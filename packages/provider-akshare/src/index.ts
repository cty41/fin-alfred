import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export interface PriceResult {
  symbol: string;
  price?: number;
  previousClose?: number;
  observedAt?: string;
  source?: string;
}

export interface AkshareProviderOptions {
  /** Path to the uv-managed python. Defaults to data-provider/.venv/Scripts/python.exe */
  pythonPath?: string;
  /** Path to akshare_adapter.py. Defaults to data-provider/akshare_adapter.py relative to repo root. */
  adapterPath?: string;
  timeoutMs?: number;
}

function findRepoRoot(): string {
  let dir = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "data-provider", "akshare_adapter.py"))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

export class AkshareProvider {
  private pythonPath: string;
  private adapterPath: string;
  private timeoutMs: number;

  constructor(opts?: AkshareProviderOptions) {
    const repoRoot = findRepoRoot();
    this.pythonPath = opts?.pythonPath ?? path.join(repoRoot, "data-provider", ".venv", "Scripts", "python.exe");
    this.adapterPath = opts?.adapterPath ?? path.join(repoRoot, "data-provider", "akshare_adapter.py");
    this.timeoutMs = opts?.timeoutMs ?? 30_000;
  }

  private run(action: "prices" | "relative", payload: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.pythonPath, [this.adapterPath, action, JSON.stringify(payload)], {
        stdio: ["ignore", "pipe", "pipe"],
        signal,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`AKShare adapter timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`AKShare adapter exited ${code}: ${stderr.trim() || "unknown error"}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error(`AKShare adapter returned invalid JSON: ${stdout.slice(0, 200)}`));
        }
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  async fetchPrices(symbol: string, signal?: AbortSignal): Promise<PriceResult[]> {
    const result = await this.run("prices", { symbols: [symbol] }, signal);
    const prices = Array.isArray(result) ? result : result?.prices;
    return Array.isArray(prices) ? prices : [];
  }

  async fetchRelative(symbol: string, peers: string[] = [], signal?: AbortSignal): Promise<any> {
    return this.run("relative", { symbol, peers }, signal);
  }
}

export { fetchPriceSync } from "./sync.js";
