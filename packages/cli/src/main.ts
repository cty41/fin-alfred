#!/usr/bin/env node
import * as readline from "node:readline";
import { stdin, stdout, exit } from "node:process";
import { openDatabase, createSession, listSessions } from "@fin-alfred/gateway/db";
import { executeCommand } from "@fin-alfred/gateway/engine";
import { randomUUID } from "node:crypto";

const GUIDE = `
欢迎使用 fin-alfred！这是你的确定性价值投资助手。
以下是快速上手路径（按顺序尝试）：

1. 添加自选股:
   watchlist add HKEX:1810 1810.HK 小米集团-W

2. 获取实时行情:
   quote HKEX:1810 --refresh

3. 设置初始持仓（如果已有持仓）:
   position set HKEX:1810 213600 395000

4. 创建减仓策略:
   strategy new HKEX:1810 225600 --preset xiaomi

5. 查看策略状态（是否该卖）:
   strategy status HKEX:1810

6. 记录真实成交（幂等，不会重复入账）:
   trade log HKEX:1810 sell 2026-08-14 12000 25.62 270 22 11 26

7. 生成分析报告:
   report HKEX:1810

随时输入 help 查看全部命令。
`;

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) =>
    Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? ""))),
  );
  const line = (cells: string[]) =>
    "  " + cells.map((c, i) => padDisplay(c ?? "", widths[i])).join("  ");
  console.log(line(headers));
  console.log("  " + widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) console.log(line(row));
}

function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += (ch.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1;
  return w;
}

function padDisplay(s: string, target: number): string {
  const pad = target - displayWidth(s);
  return s + " ".repeat(Math.max(0, pad));
}

function handle(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed === "exit" || trimmed === "quit") return true;
  const result = executeCommand(db, trimmed);
  console.log(result.message);
  if (result.table) printTable(result.table.headers, result.table.rows);
  console.log("");
  return false;
}

const db = openDatabase();
createSession(db, randomUUID(), "cli");

console.log("fin-alfred v0.2 — 确定性价值投资助手");
console.log("输入 help 查看命令，输入 exit 退出。\n");

if (listSessions(db).length <= 1) console.log(GUIDE);

const interactive = Boolean(process.stdin.isTTY);
const rl = readline.createInterface({ input: stdin, output: stdout, terminal: interactive });

if (interactive) {
  const prompt = () => rl.question("alfred> ", (line) => {
    if (handle(line)) { rl.close(); exit(0); }
    prompt();
  });
  prompt();
} else {
  rl.on("line", (line) => {
    if (handle(line)) { rl.close(); exit(0); }
  });
  rl.on("close", () => exit(0));
}
