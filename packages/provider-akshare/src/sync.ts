import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

function findRepoRoot(start: string): string {
  let dir = start;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "data-provider", "akshare_adapter.py"))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

export interface SyncPriceResult {
  price?: string;
  previousClose?: string;
  observedAt?: string;
  source?: string;
  error?: string;
}

/** Call the AKShare Python adapter synchronously. Returns price or an error. */
export function fetchPriceSync(symbol: string, timeoutMs = 30000): SyncPriceResult {
  const repoRoot = findRepoRoot(process.cwd());
  const pythonPath = path.join(repoRoot, "data-provider", ".venv", "Scripts", "python.exe");
  const adapterPath = path.join(repoRoot, "data-provider", "akshare_adapter.py");
  if (!fs.existsSync(pythonPath)) {
    return { error: `python venv not found at ${pythonPath}; run: uv sync --frozen --project data-provider` };
  }
  if (!fs.existsSync(adapterPath)) {
    return { error: `adapter not found at ${adapterPath}` };
  }
  const cleanSymbol = symbol.replace(/^HKEX:/, "").replace(/\.HK$/i, "").padStart(5, "0");
  const payload = JSON.stringify({ symbols: [cleanSymbol] });
  const result = spawnSync(pythonPath, [adapterPath, "prices", payload], {
    encoding: "utf-8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (result.status !== 0) {
    return { error: (result.stderr || "").trim() || `adapter exited ${result.status}` };
  }
  try {
    // Strip UTF-8 BOM if present
    const raw = (result.stdout || "").replace(/^\uFEFF/, "");
    const data = JSON.parse(raw);
    const items = data?.prices ?? [];
    if (items.length === 0) return { error: "adapter returned no price data" };
    const item = items[0];
    return {
      price: item?.price != null ? String(item.price) : undefined,
      previousClose: item?.previousClose != null ? String(item.previousClose) : undefined,
      observedAt: item?.observedAt ? String(item.observedAt).slice(0, 10) : undefined,
      source: item?.source ?? "akshare",
    };
  } catch (e: any) {
    return { error: `invalid adapter JSON: ${e.message}` };
  }
}
