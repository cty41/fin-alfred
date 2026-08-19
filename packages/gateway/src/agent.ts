import { DatabaseSync } from "node:sqlite";
import {
  createConfiguredLlmProvider,
  LlmTranslationError,
  LlmUnavailable,
  type LlmProvider,
  type TranslationPlan,
} from "@fin-alfred/provider-llm";
import { watchlistList } from "./db.js";
import { executeCommand, type CommandResult } from "./engine.js";

export type AgentResult =
  | { kind: "command"; command: string; result: CommandResult }
  | { kind: "llm"; action: string; command: string; confidence: number; reply: string; result: CommandResult }
  | { kind: "chat"; reply: string; confidence: number }
  | { kind: "forbidden"; action: string; reply: string; message: string }
  | { kind: "unknown"; message: string };

export class AgentSession {
  private readonly provider: LlmProvider | undefined;
  private readonly providerInitError: string | undefined;

  constructor(private readonly db: DatabaseSync, provider?: LlmProvider | null) {
    if (provider !== undefined) {
      this.provider = provider === null ? undefined : provider;
      return;
    }
    try {
      this.provider = createConfiguredLlmProvider();
    } catch (error) {
      if (error instanceof LlmTranslationError) {
        this.provider = undefined;
        this.providerInitError = error.message;
        return;
      }
      throw error;
    }
  }

  async process(input: string): Promise<AgentResult> {
    const trimmed = input.trim();
    if (!trimmed) return { kind: "unknown", message: "空输入。" };
    if (isKnownCommand(trimmed)) {
      return { kind: "command", command: trimmed, result: executeCommand(this.db, trimmed) };
    }
    if (!this.provider) {
      const detail = this.providerInitError
        ? `本地模型配置无效：${this.providerInitError}`
        : "本地模型当前未启用。";
      return { kind: "unknown", message: `未识别命令。可输入 help 查看命令；${detail}` };
    }
    if (looksLikeExplicitStockOperation(trimmed)) return forbiddenStockOperation();

    try {
      if (!(await this.provider.isAvailable())) {
        return { kind: "unknown", message: "本地模型或配置的模型不可用。已回退到确定性命令模式；输入 help 查看命令。" };
      }
      const knownInstruments = watchlistList(this.db).map(({ instrumentId, symbol, name }) => ({ instrumentId, symbol, name }));
      const matchedInstruments = knownInstruments.filter((instrument) => instrumentMatches(trimmed, instrument));
      return executePlan(this.db, await this.provider.translateToPlan(trimmed, { knownInstruments, matchedInstruments }));
    } catch (error) {
      if (error instanceof LlmUnavailable || error instanceof LlmTranslationError) {
        return { kind: "unknown", message: `本地模型无法完成解析。已回退到确定性命令模式：${error.message}` };
      }
      throw error;
    }
  }
}

const ROOT_COMMANDS = new Set([
  "help", "guide", "watchlist", "quote", "position", "trade", "strategy",
  "financials", "dcf", "summary", "screen", "report", "migrate", "session",
]);

const PLAN_COMMANDS: Record<string, RegExp> = {
  "watchlist.list": /^watchlist list$/i,
  quote: /^quote [A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/i,
  summary: /^summary [A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/i,
  dcf: /^dcf [A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/i,
  "screen.lilu": /^screen lilu$/i,
  "screen.burry": /^screen burry$/i,
  "strategy.status": /^strategy status [A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/i,
};

function isKnownCommand(input: string): boolean {
  return ROOT_COMMANDS.has(input.split(/\s+/, 1)[0].toLowerCase());
}

function looksLikeExplicitStockOperation(input: string): boolean {
  const operation = /(?:买入|买进|卖出|减仓|加仓|清仓|调仓|设置持仓|记录成交|执行交易|\b(?:buy|sell|trade|set position)\b)/i;
  const directive = /(?:帮我|替我|给我|立即|现在|执行|下单|记录|\d[\d,.]*\s*(?:股|手|shares?)|\b\d[\d,.]*\s*shares?\b)/i;
  return operation.test(input) && directive.test(input);
}

function instrumentMatches(
  input: string,
  instrument: { instrumentId: string; symbol: string; name: string },
): boolean {
  const normalizedInput = input.toLowerCase();
  const aliases = [
    instrument.instrumentId,
    instrument.instrumentId.split(":").at(-1) ?? "",
    instrument.symbol,
    instrument.symbol.split(".")[0],
    instrument.name,
    instrument.name.replace(/(?:集团|控股|股份|有限公司).*$/u, ""),
  ];
  return aliases.some((alias) => alias.length >= 2 && normalizedInput.includes(alias.toLowerCase()));
}

function forbiddenStockOperation(reply = "交易、持仓和其他写入操作不能通过自然语言执行。"): AgentResult {
  return {
    kind: "forbidden",
    action: "forbidden",
    reply,
    message: `拒绝执行：${reply}如确需操作，请检查后直接输入现有确定性命令。`,
  };
}

function executePlan(db: DatabaseSync, plan: TranslationPlan): AgentResult {
  if (plan.action === "forbidden") return forbiddenStockOperation(plan.reply);
  if (plan.action === "chat") {
    if (plan.command) {
      return {
        kind: "forbidden",
        action: "chat",
        reply: plan.reply,
        message: "拒绝执行：对话回复不能携带可执行命令。",
      };
    }
    return { kind: "chat", reply: plan.reply, confidence: plan.confidence };
  }
  if (plan.action === "unknown" || !plan.command) {
    return { kind: "unknown", message: plan.reply || "无法从自然语言推断出只读命令。" };
  }
  const pattern = PLAN_COMMANDS[plan.action];
  if (!pattern || !pattern.test(plan.command)) {
    return {
      kind: "forbidden",
      action: plan.action,
      reply: plan.reply,
      message: "拒绝执行：本地模型返回的 action 与命令不在严格只读白名单内。",
    };
  }
  const result = executeCommand(db, plan.command);
  return {
    kind: "llm",
    action: plan.action,
    command: plan.command,
    confidence: plan.confidence,
    reply: plan.reply,
    result,
  };
}

export function agentResultToCommandResult(result: AgentResult): CommandResult {
  if (result.kind === "command") return result.result;
  if (result.kind === "chat") {
    return {
      ok: true,
      message: result.reply,
      data: { conversation: { mode: "chat", confidence: result.confidence } },
    };
  }
  if (result.kind === "llm") {
    return {
      ...result.result,
      message: `本地模型理解为: ${result.command}\n(置信度 ${Math.round(result.confidence * 100)}%)\n\n${result.result.message}`,
      data: {
        ...(result.result.data && typeof result.result.data === "object" ? result.result.data : {}),
        interpretation: { action: result.action, command: result.command, confidence: result.confidence, reply: result.reply },
      },
    };
  }
  return { ok: false, message: result.message };
}
