#!/usr/bin/env node
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { openDatabase, createSession } from "@fin-alfred/gateway/db";
import { executeCommand } from "@fin-alfred/gateway/engine";
import { randomUUID } from "node:crypto";

async function main(): Promise<void> {
  const db = openDatabase();
  const sessionId = randomUUID();
  createSession(db, sessionId, "cli");

  console.log("fin-alfred v0.2 — 价值投资助手");
  console.log("输入 help 查看命令，输入 exit 退出。\n");

  const rl = readline.createInterface({ input: stdin, output: stdout });
  while (true) {
    const line = (await rl.question("alfred> ")).trim();
    if (!line) continue;
    if (line === "exit" || line === "quit") break;
    const result = executeCommand(db, line);
    console.log(result.message);
    if (result.table) {
      printTable(result.table.headers, result.table.rows);
    }
    console.log("");
  }
  rl.close();
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (cells: string[]) =>
    "  " + cells.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ");
  console.log(line(headers));
  console.log("  " + widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) console.log(line(row));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
