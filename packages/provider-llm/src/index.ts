import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface LlmConfig {
  provider: "ollama";
  enabled: boolean;
  model: string;
  baseUrl: string;
  timeoutMs: number;
}

export interface TranslationPlan {
  action: string;
  command?: string;
  reply: string;
  confidence: number;
}

export interface LlmProvider {
  isAvailable(): Promise<boolean>;
  translateToPlan(input: string, context?: Record<string, unknown>): Promise<TranslationPlan>;
}

export class LlmUnavailable extends Error {
  constructor(message = "local LLM is not available") {
    super(message);
    this.name = "LlmUnavailable";
  }
}

export class LlmTranslationError extends Error {
  constructor(message = "local LLM did not produce a valid command plan") {
    super(message);
    this.name = "LlmTranslationError";
  }
}

export function defaultLlmConfig(): LlmConfig {
  return {
    provider: "ollama",
    enabled: false,
    model: "qwen3.5:2b",
    baseUrl: "http://127.0.0.1:11434",
    timeoutMs: 60_000,
  };
}

export function configPath(): string {
  const localData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share");
  return path.join(localData, "fin-alfred", "llm-config.json");
}

export function loadLlmConfig(filePath = configPath()): LlmConfig {
  const defaults = defaultLlmConfig();
  let parsed: Partial<LlmConfig>;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<LlmConfig>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults;
    throw new LlmTranslationError(`invalid LLM config at ${filePath}: ${(error as Error).message}`);
  }

  if (parsed.provider !== undefined && parsed.provider !== "ollama") {
    throw new LlmTranslationError(`unsupported LLM provider: ${String(parsed.provider)}`);
  }
  return {
    provider: "ollama",
    enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : defaults.enabled,
    model: nonEmptyString(parsed.model) ?? defaults.model,
    baseUrl: (nonEmptyString(parsed.baseUrl) ?? defaults.baseUrl).replace(/\/+$/, ""),
    timeoutMs: validTimeout(parsed.timeoutMs) ?? defaults.timeoutMs,
  };
}

export function createConfiguredLlmProvider(filePath = configPath()): LlmProvider | undefined {
  const config = loadLlmConfig(filePath);
  return config.enabled ? new OllamaClient(config) : undefined;
}

export const READ_ONLY_CATALOG = [
  { action: "watchlist.list", command: "watchlist list", mutation: false },
  { action: "quote", command: "quote <instrument_id>", mutation: false },
  { action: "summary", command: "summary <instrument_id>", mutation: false },
  { action: "dcf", command: "dcf <instrument_id>", mutation: false },
  { action: "screen.lilu", command: "screen lilu", mutation: false },
  { action: "screen.burry", command: "screen burry", mutation: false },
  { action: "strategy.status", command: "strategy status <instrument_id>", mutation: false },
] as const;

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [
        "chat",
        "forbidden",
        "unknown",
        "watchlist.list",
        "quote",
        "summary",
        "dcf",
        "screen.lilu",
        "screen.burry",
        "strategy.status",
      ],
    },
    command: { type: "string" },
    reply: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["action", "command", "reply", "confidence"],
} as const;

const SYSTEM_PROMPT = `You are fin-alfred's local read-only investment assistant and intent translator.
Respond in Chinese unless the user clearly uses another language.
Translate requests that need Alfred's local data into at most one existing read-only command.
Never invent commands, shell code, SQL, file operations, or write operations.

Allowed commands:
- watchlist list
- quote <instrument_id>
- summary <instrument_id>
- dcf <instrument_id>
- screen lilu
- screen burry
- strategy status <instrument_id>

Rules:
- Explicit instructions to buy, sell, reduce, add, set a position, import data, create a strategy, or otherwise mutate state use action "forbidden" and command "".
- Questions asking whether a strategy currently suggests action are read-only and may map to strategy status.
- Greetings, capability questions, and general investment concepts such as DCF use action "chat", command "", and put the complete helpful answer in reply.
- In chat mode, explain evidence, risks, valuation methods, and verification steps, but never decide a trade, promise returns, or claim access to live/local data that was not provided.
- Requests requiring Alfred's saved or current data should use an allowed command rather than chat. If the request cannot be answered safely or understood, use action "unknown" and command "".
- The user message includes knownInstruments. Treat those mappings as authoritative: when the request uses an instrument's name, a meaningful name substring, or symbol, substitute its instrumentId in the command.
- matchedInstruments contains deterministic matches for this request. If it contains exactly one item, use that item's instrumentId; do not return unknown merely because the request uses a company name.
- Use canonical instrument IDs such as HKEX:1810.
- Never append --refresh to quote.
- Reply briefly in Chinese.

Examples:
- Request "小米现在多少钱" with matched instrument HKEX:1810 -> {"action":"quote","command":"quote HKEX:1810","reply":"查询小米报价。","confidence":0.95}
- Request "小米还能减仓吗" with matched instrument HKEX:1810 -> {"action":"strategy.status","command":"strategy status HKEX:1810","reply":"查看小米当前策略状态。","confidence":0.9}
- Request "你好" -> {"action":"chat","command":"","reply":"你好，我是 Alfred。可以帮你查询和解释投资信息，但不会替你执行交易。","confidence":1}
- Request "什么是 DCF" -> {"action":"chat","command":"","reply":"DCF 是将企业未来自由现金流折现到今天的估值方法，结果取决于现金流、增长率和折现率等假设。","confidence":0.95}
- Request "帮我卖出500股小米" -> {"action":"forbidden","command":"","reply":"自然语言不能执行交易操作。","confidence":1}`;

type FetchLike = typeof fetch;

export class OllamaClient implements LlmProvider {
  constructor(
    private readonly config: LlmConfig = loadLlmConfig(),
    private readonly fetcher: FetchLike = fetch,
  ) {}

  async isAvailable(): Promise<boolean> {
    try {
      const response = await this.fetcher(`${this.config.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(Math.min(this.config.timeoutMs, 10_000)),
      });
      if (!response.ok) return false;
      const body = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
      return Boolean(body.models?.some((item) => modelMatches(item.name ?? item.model, this.config.model)));
    } catch {
      return false;
    }
  }

  async translateToPlan(input: string, context: Record<string, unknown> = {}): Promise<TranslationPlan> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.config.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.config.model,
          stream: false,
          think: false,
          format: PLAN_SCHEMA,
          options: { temperature: 0, num_predict: 500 },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: JSON.stringify({
                catalog: READ_ONLY_CATALOG,
                knownInstruments: context.knownInstruments ?? [],
                matchedInstruments: context.matchedInstruments ?? [],
                request: input,
              }),
            },
          ],
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      throw new LlmUnavailable(`Ollama request failed: ${(error as Error).message}`);
    }
    if (!response.ok) throw new LlmUnavailable(`Ollama returned HTTP ${response.status}`);

    let body: { message?: { content?: string } };
    try {
      body = (await response.json()) as { message?: { content?: string } };
    } catch (error) {
      throw new LlmTranslationError(`Ollama returned invalid JSON: ${(error as Error).message}`);
    }
    return parseTranslationPlan(body.message?.content ?? "");
  }
}

export function parseTranslationPlan(raw: string): TranslationPlan {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").replace(/^\uFEFF/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new LlmTranslationError(`cannot parse Ollama JSON output: ${raw.slice(0, 120)}`);
  }
  if (!parsed || typeof parsed !== "object") throw new LlmTranslationError("Ollama plan must be an object");
  const plan = parsed as Record<string, unknown>;
  if (typeof plan.action !== "string" || !plan.action.trim() || typeof plan.reply !== "string" || !plan.reply.trim()) {
    throw new LlmTranslationError("Ollama plan is missing action or reply");
  }
  const confidence = Number(plan.confidence);
  if (!Number.isFinite(confidence)) throw new LlmTranslationError("Ollama plan confidence must be numeric");
  return {
    action: plan.action.trim(),
    command: typeof plan.command === "string" && plan.command.trim() ? plan.command.trim() : undefined,
    reply: plan.reply.trim(),
    confidence: Math.max(0, Math.min(1, confidence)),
  };
}

function modelMatches(candidate: string | undefined, configured: string): boolean {
  if (!candidate) return false;
  return candidate === configured || candidate === `${configured}:latest` || configured === `${candidate}:latest`;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function validTimeout(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 1_000 && value <= 300_000
    ? value
    : undefined;
}
