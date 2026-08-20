# dsh-alfred plugin

English | [简体中文](README.md)

`dsh-alfred` is the DeepSeek Harness bundle for [DSH Alfred](../../README.en.md). It registers Hong Kong market data, relative valuation, local portfolio context, value-strategy evaluation, and confirmed ledger writes as DSH tools. It also ships the Alfred agent preset, investment-research Skill, and Web-session help.

The current version supports Xiaomi (`HKEX:1810`), Tencent (`HKEX:0700`), and Alibaba (`HKEX:9988`).

## Capabilities and boundaries

| Capability | Behavior |
| --- | --- |
| Market and valuation | Read-only calls to the local AKShare adapter, with source, time, or structured errors |
| Portfolio context | Opens the local Alfred SQLite database read-only and never invents missing records |
| Value strategy | Computes a strategy state from verified Bear / Base / Bull values, price, and Base IRR |
| Execution records | Records only broker-completed trades after preview and later explicit commit confirmation |
| Models | Fully configured by DSH; the plugin provides no model provider and stores no API keys |
| Brokerage | No connection, order submission, or automatic trading capability |

## Source installation

The plugin is currently a monorepo package that depends on sibling `@fin-alfred/core` and `@fin-alfred/provider-akshare` workspaces. Build from a source checkout and link it locally; npm and GitHub one-command installation are not supported yet.

Requirements: Windows, Node.js 24+, Python 3.12, [uv](https://docs.astral.sh/uv/), and a working DeepSeek Harness installation.

```powershell
git clone https://github.com/cty41/fin-alfred.git
cd fin-alfred
npm ci
uv sync --frozen --project data-provider
npm run build

npx --yes @deepseek-ai/dsh plugin --profile web add ./packages/dsh-alfred
powershell -ExecutionPolicy Bypass -File ./packages/dsh-alfred/scripts/install-preset.ps1
```

Optionally add the bundle to the headless profile:

```powershell
npx --yes @deepseek-ai/dsh plugin --profile headless add ./packages/dsh-alfred
```

See the [official DSH publishing guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md) for local bundles and configuration-layer behavior.

## Configuration

Configure the bundle row in `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`. This file is a YAML array, not an object keyed by plugin name:

```yaml
- id: dsh-alfred
  config:
    pythonPath: C:/path/to/fin-alfred/data-provider/.venv/Scripts/python.exe
    adapterPath: C:/path/to/fin-alfred/data-provider/akshare_adapter.py
    dbPath: C:/Users/<user>/AppData/Local/fin-alfred/alfred.db
    timeoutMs: 30000
    confirmationTtlMs: 600000
```

`FIN_ALFRED_PYTHON_PATH`, `FIN_ALFRED_AKSHARE_ADAPTER`, `FIN_ALFRED_DB_PATH`, and `FIN_ALFRED_AKSHARE_TIMEOUT_MS` can provide defaults. Explicit profile configuration takes precedence.

Configure models in the DSH Models page or a DSH profile overlay. Provider connectivity and credentials for DeepSeek, OpenRouter, or Ollama are outside this plugin.

## Start and verify

```powershell
npx --yes @deepseek-ai/dsh --profile web --dump-config
npx --yes @deepseek-ai/dsh web --port 3091
```

Open `http://127.0.0.1:3091`, create a session, and select `alfred`. The blank session displays a help card; example buttons fill the draft without sending it. Verify with:

```text
Query HKEX:1810 and summarize only the tool-returned price, observation time, and source.
Analyze Tencent as a new position and list missing evidence.
Compare Tencent and Alibaba on margin of safety without assuming holdings.
```

## Registered tools

| Tool | Type | Purpose |
| --- | --- | --- |
| `alfred_stock_quote` | Read-only | Query quotes for any HK listing (by code or Chinese/English name) |
| `alfred_stock_fundamentals` | Read-only | Current valuation and historical percentile summary |
| `alfred_financial_statements` | Read-only | Three-statement detail (balance/income/cashflow) plus standard-account summary (cash, investments, interest-bearing debt, minority interest, etc.) |
| `alfred_portfolio_context` | Read-only | Read local position and strategy context |
| `alfred_value_strategy` | Pure calculation | Evaluate the value-strategy state |
| `alfred_prepare_execution` | Preview | Preview a completed execution and issue a confirmation token |
| `alfred_commit_execution` | Confirmed write | Atomically record the execution and update the position |
| `alfred_prepare_initial_position` | Preview | Preview first-time position initialization |
| `alfred_commit_initial_position` | Confirmed write | Initialize a position with no prior records |

Tokens are session-bound, expire after ten minutes by default, and are single-use. Commit rechecks cash, holdings, and duplicate execution keys. A failed transaction leaves no partial execution.

Read-only tools accept any HK code (`HKEX:0001`, `2020.HK`, `9633`, …) or a name (resolved against the cached full securities list, refreshed every 24 hours; the first lookup may be slower). The three anchors (Xiaomi/Tencent/Alibaba) keep Chinese shortcut aliases.

### Financial-statement boundaries

`alfred_financial_statements` fetches the three statements from a public Eastmoney interface (`datacenter.eastmoney.com`, free and unauthenticated) — a **secondary aggregation**, not the companies' IR originals. Notes:

- **Currency:** the three statements are reported in **CNY (人民币)**; the returned `currency` is 「人民币」.
- **Reporting period:** `报告期` returns each period (including quarterly); `年度` returns fiscal-year 12-31 only. Alibaba's fiscal year ends in March, so cross-company comparison must align periods.
- **Non-uniform account names:** each company's raw account names follow their own filings. The standard-account summary (cash, investments, interest-bearing debt, minority interest, total assets/liabilities/equity) is produced by the generic keyword mapping layer in `packages/core/src/financials.ts`, marked `mapping.heuristic=true`; raw rows are preserved for audit.
- **No segment data:** the statements omit segment revenue (Tencent's VAS / ads / fintech & business services), which requires official results-PDF parsing — out of scope for this release.

## Usage examples

```text
Analyze Tencent as a new position. Query tools first, then separate facts, assumptions, calculations, and strategy draft.

Read my Xiaomi position and explain the add, wait, reduce, and exit-review conditions.

I sold 1,000 Xiaomi shares at HKD 30 on 2026-08-20T10:00:00+08:00 with HKD 10 commission. Preview the record and do not write it yet.
```

After inspecting the preview, explicitly confirm in a later turn. `tradedAt` accepts `YYYY-MM-DD` or a complete ISO timestamp with `Z` / UTC offset; timezone-free local timestamps are rejected.

## Troubleshooting

- **`EADDRINUSE: 3091`:** inspect the listener with `Get-NetTCPConnection -LocalPort 3091 -State Listen`. Stop it only after confirming it is an old DSH process, or select another port.
- **`Failed to load plugins`:** run the root `npm run build`; `packages/dsh-alfred/dist/client.js` must start with `window.__ModuleLoader__.load`. Restart DSH afterward.
- **Missing Alfred preset:** rerun `scripts/install-preset.ps1`, verify `%USERPROFILE%\.dsh\.agent-presets\alfred\agent.cordis.yml`, restart DSH, and create a new session.
- **Model `Failed to fetch`:** validate the DSH provider base URL, API key, proxy, and local Ollama listener independently. Alfred does not make model-provider requests.
- **Missing market data:** validate `pythonPath`, `adapterPath`, and the uv environment. AKShare or an upstream public interface may still fail; Alfred does not fabricate missing quotes.

```powershell
uv run --frozen --project data-provider python -m unittest discover -s data-provider -p "test_*.py" -v
```

## Development

```powershell
npm run typecheck
npm test
npm run build
npm pack --workspace dsh-alfred --dry-run
```

A linked checkout does not need reinstallation after source changes, but it does require rebuild and DSH restart. Rerun the preset installer after changing preset files.

## Distribution status

`package.json` remains `private: true` and workspace dependencies use `file:..`. Until a self-contained package with prebuilt server/client output passes a clean-install test, the project will not use the `dsh-plugin` discovery topic or claim one-command community installation.

## License

[Apache-2.0](../../LICENSE)
