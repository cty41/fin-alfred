import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultLlmConfig,
  LlmTranslationError,
  LlmUnavailable,
  loadLlmConfig,
  OllamaClient,
  parseTranslationPlan,
} from "../src/index.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("LLM configuration", () => {
  it("uses disabled defaults when the config is absent", () => {
    expect(loadLlmConfig(path.join(os.tmpdir(), "missing-fin-alfred-config.json"))).toEqual(defaultLlmConfig());
  });

  it("loads valid overrides and rejects malformed JSON", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alfred-llm-config-"));
    tempDirs.push(dir);
    const file = path.join(dir, "llm-config.json");
    fs.writeFileSync(file, JSON.stringify({ enabled: true, model: "qwen3.5:2b", timeoutMs: 5_000 }));
    expect(loadLlmConfig(file).enabled).toBe(true);
    fs.writeFileSync(file, "{");
    expect(() => loadLlmConfig(file)).toThrow(LlmTranslationError);
  });
});

describe("Ollama provider", () => {
  it("checks that the configured model is installed", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ models: [{ name: "qwen3.5:2b" }] }), { status: 200 }));
    const client = new OllamaClient({ ...defaultLlmConfig(), enabled: true }, fetcher as typeof fetch);
    expect(await client.isAvailable()).toBe(true);
  });

  it("reports unavailable for a missing model or failed request", async () => {
    const missing = vi.fn(async () => new Response(JSON.stringify({ models: [] }), { status: 200 }));
    expect(await new OllamaClient({ ...defaultLlmConfig(), enabled: true }, missing as typeof fetch).isAvailable()).toBe(false);
    const failed = vi.fn(async () => { throw new Error("offline"); });
    expect(await new OllamaClient({ ...defaultLlmConfig(), enabled: true }, failed as typeof fetch).isAvailable()).toBe(false);
  });

  it("uses native structured chat output", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.stream).toBe(false);
      expect(body.think).toBe(false);
      expect(body.format.type).toBe("object");
      expect(body.format.required).toContain("command");
      return new Response(JSON.stringify({
        message: { content: JSON.stringify({ action: "quote", command: "quote HKEX:1810", reply: "查询报价", confidence: 0.9 }) },
      }), { status: 200 });
    });
    const client = new OllamaClient({ ...defaultLlmConfig(), enabled: true }, fetcher as typeof fetch);
    await expect(client.translateToPlan("小米现在多少钱")).resolves.toMatchObject({ action: "quote", confidence: 0.9 });
  });

  it("turns transport and HTTP failures into LlmUnavailable", async () => {
    const rejected = vi.fn(async () => { throw new Error("timeout"); });
    const rejectedClient = new OllamaClient({ ...defaultLlmConfig(), enabled: true }, rejected as typeof fetch);
    await expect(rejectedClient.translateToPlan("test")).rejects.toBeInstanceOf(LlmUnavailable);
    const badStatus = vi.fn(async () => new Response("bad", { status: 500 }));
    const badStatusClient = new OllamaClient({ ...defaultLlmConfig(), enabled: true }, badStatus as typeof fetch);
    await expect(badStatusClient.translateToPlan("test")).rejects.toBeInstanceOf(LlmUnavailable);
  });

  it("turns malformed HTTP bodies into LlmTranslationError", async () => {
    const invalidJson = vi.fn(async () => new Response("not-json", { status: 200 }));
    const client = new OllamaClient({ ...defaultLlmConfig(), enabled: true }, invalidJson as typeof fetch);
    await expect(client.translateToPlan("test")).rejects.toBeInstanceOf(LlmTranslationError);
  });
});

describe("translation plan parsing", () => {
  it("accepts JSON and fenced JSON", () => {
    const json = '{"action":"screen.lilu","command":"screen lilu","reply":"筛选","confidence":1}';
    expect(parseTranslationPlan(json).action).toBe("screen.lilu");
    expect(parseTranslationPlan(`\`\`\`json\n${json}\n\`\`\``).command).toBe("screen lilu");
  });

  it("rejects malformed or incomplete output", () => {
    expect(() => parseTranslationPlan("not json")).toThrow(LlmTranslationError);
    expect(() => parseTranslationPlan('{"action":"quote"}')).toThrow(LlmTranslationError);
    expect(() => parseTranslationPlan('{"action":"chat","command":"","reply":"  ","confidence":1}')).toThrow(LlmTranslationError);
  });
});
