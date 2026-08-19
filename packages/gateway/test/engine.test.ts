import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openDatabase, watchlistList, getOrCreatePosition } from "../src/db.js";
import { executeCommand } from "../src/engine.js";

let db: DatabaseSync;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alfred-test-"));
  db = openDatabase({ dbPath: path.join(tmpDir, "test.db") });
});

describe("gateway engine integration", () => {
  it("full Xiaomi lifecycle: position -> strategy -> trade -> status", () => {
    executeCommand(db, "position set HKEX:1810 225600 87889");
    executeCommand(db, "strategy new HKEX:1810 225600 --preset xiaomi");
    const trade = executeCommand(db, "trade log HKEX:1810 sell 2026-08-14 12000 25.62 270 22 11 26");
    expect(trade.ok).toBe(true);
    expect(trade.message).toContain("213600");
    const pos = executeCommand(db, "position HKEX:1810");
    expect(pos.message).toContain("213600");
    expect(pos.message).toContain("395000");
    const status = executeCommand(db, "strategy status HKEX:1810");
    expect(status.ok).toBe(true);
    expect(status.message).toContain("等待");
  });

  it("duplicate trade is idempotent", () => {
    executeCommand(db, "position set HKEX:1810 225600 87889");
    executeCommand(db, "trade log HKEX:1810 sell 2026-08-14 12000 25.62 270 22 11 26");
    const dup = executeCommand(db, "trade log HKEX:1810 sell 2026-08-14 12000 25.62 270 22 11 26");
    expect(dup.message).toContain("幂等");
    const pos = getOrCreatePosition(db, "default", "HKEX:1810");
    expect(pos.quantity).toBe("213600");
  });

  it("oversell is rejected", () => {
    executeCommand(db, "position set HKEX:1810 100 0");
    const r = executeCommand(db, "trade log HKEX:1810 sell 2026-08-14 200 25 0 0 0 0");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("超过");
  });

  it("watchlist add/list/remove", () => {
    executeCommand(db, "watchlist add HKEX:9988 9988.HK Alibaba");
    const list = executeCommand(db, "watchlist list");
    expect(list.table?.rows.length).toBe(1);
    executeCommand(db, "watchlist remove HKEX:9988");
    const list2 = executeCommand(db, "watchlist list");
    expect(list2.message).toContain("为空");
  });

  it("unknown command returns helpful error", () => {
    const r = executeCommand(db, "foobar");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("help");
  });
});
