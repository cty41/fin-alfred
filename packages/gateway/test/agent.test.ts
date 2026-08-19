import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmProvider, TranslationPlan } from "@fin-alfred/provider-llm";
import { AgentSession, agentResultToCommandResult } from "../src/agent.js";
import { openDatabase, getOrCreatePosition } from "../src/db.js";
import { executeCommand } from "../src/engine.js";
import type { DatabaseSync } from "node:sqlite";

let db: DatabaseSync;
let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alfred-agent-test-"));
  db = openDatabase({ dbPath: path.join(tempDir, "test.db") });
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function provider(plan: TranslationPlan, available = true): LlmProvider {
  return {
    isAvailable: vi.fn(async () => available),
    translateToPlan: vi.fn(async () => plan),
  };
}

describe("AgentSession", () => {
  it("executes known deterministic commands without calling the LLM", async () => {
    const mock = provider({ action: "unknown", reply: "unused", confidence: 0 });
    const result = await new AgentSession(db, mock).process("help");
    expect(result.kind).toBe("command");
    expect(mock.isAvailable).not.toHaveBeenCalled();
  });

  it("falls back when disabled or unavailable", async () => {
    expect((await new AgentSession(db, null).process("看看小米")).kind).toBe("unknown");
    expect((await new AgentSession(db, provider({ action: "unknown", reply: "", confidence: 0 }, false)).process("看看小米")).kind).toBe("unknown");
  });

  it("keeps deterministic mode available when the local config is malformed", async () => {
    const originalLocalAppData = process.env.LOCALAPPDATA;
    const configDir = path.join(tempDir, "fin-alfred");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "llm-config.json"), "{");
    process.env.LOCALAPPDATA = tempDir;
    try {
      const session = new AgentSession(db);
      expect((await session.process("help")).kind).toBe("command");
      expect(agentResultToCommandResult(await session.process("你好")).message).toContain("配置无效");
    } finally {
      if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = originalLocalAppData;
    }
  });

  it("returns safe read-only conversation replies", async () => {
    const greeting = provider({ action: "chat", reply: "你好，我是 Alfred。", confidence: 1 });
    const result = await new AgentSession(db, greeting).process("你好");
    expect(result).toEqual({ kind: "chat", reply: "你好，我是 Alfred。", confidence: 1 });
    expect(agentResultToCommandResult(result)).toMatchObject({ ok: true, message: "你好，我是 Alfred。" });

    const concept = provider({ action: "chat", reply: "DCF 是现金流折现估值方法。", confidence: 0.95 });
    expect((await new AgentSession(db, concept).process("什么是 DCF")).kind).toBe("chat");
  });

  it("executes an allowed read-only translation", async () => {
    executeCommand(db, "watchlist add HKEX:1810 1810.HK Xiaomi");
    const mock = provider({ action: "watchlist.list", command: "watchlist list", reply: "查看自选股", confidence: 0.95 });
    const result = await new AgentSession(db, mock).process("看看我的自选股");
    expect(result.kind).toBe("llm");
    expect(agentResultToCommandResult(result).table?.rows).toHaveLength(1);
    expect(mock.translateToPlan).toHaveBeenCalledWith(
      "看看我的自选股",
      {
        knownInstruments: [{ instrumentId: "HKEX:1810", symbol: "1810.HK", name: "Xiaomi" }],
        matchedInstruments: [],
      },
    );
  });

  it("passes deterministic name matches to the local model", async () => {
    executeCommand(db, "watchlist add HKEX:1810 1810.HK 小米集团-W");
    const mock = provider({ action: "quote", command: "quote HKEX:1810", reply: "查看报价", confidence: 0.9 });
    expect((await new AgentSession(db, mock).process("小米现在多少钱")).kind).toBe("llm");
    expect(mock.translateToPlan).toHaveBeenCalledWith(
      "小米现在多少钱",
      expect.objectContaining({
        matchedInstruments: [{ instrumentId: "HKEX:1810", symbol: "1810.HK", name: "小米集团-W" }],
      }),
    );
  });

  it("rejects explicit natural-language trading instructions before calling the model", async () => {
    executeCommand(db, "position set HKEX:1810 1000 0");
    const mock = provider({ action: "quote", command: "quote HKEX:1810", reply: "wrong", confidence: 1 });
    const result = await new AgentSession(db, mock).process("帮我卖出 500 股小米");
    expect(result.kind).toBe("forbidden");
    expect(mock.translateToPlan).not.toHaveBeenCalled();
    expect(getOrCreatePosition(db, "default", "HKEX:1810").quantity).toBe("1000");
  });

  it("rejects forbidden plans and action-command mismatches", async () => {
    const forbidden = provider({ action: "forbidden", reply: "不能交易", confidence: 0 });
    expect((await new AgentSession(db, forbidden).process("处理这个仓位")).kind).toBe("forbidden");

    const forged = provider({ action: "quote", command: "quote HKEX:1810 --refresh", reply: "刷新", confidence: 1 });
    expect((await new AgentSession(db, forged).process("刷新小米报价")).kind).toBe("forbidden");

    const mismatch = provider({ action: "quote", command: "strategy status HKEX:1810", reply: "状态", confidence: 1 });
    expect((await new AgentSession(db, mismatch).process("小米状态")).kind).toBe("forbidden");

    const chatWithCommand = provider({ action: "chat", command: "trade log HKEX:1810 sell", reply: "伪造", confidence: 1 });
    expect((await new AgentSession(db, chatWithCommand).process("随便聊聊")).kind).toBe("forbidden");

    const unknownAction = provider({ action: "made-up", command: "watchlist list", reply: "伪造", confidence: 1 });
    expect((await new AgentSession(db, unknownAction).process("未知动作")).kind).toBe("forbidden");
  });
});
