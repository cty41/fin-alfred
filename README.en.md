# DSH Alfred

English | [简体中文](README.md)

A local-first, auditable DeepSeek Harness agent for value-investing research on Hong Kong stocks. DSH Alfred connects market data, valuation evidence, portfolio context, and deterministic strategy tools to DSH: the model organizes evidence and explains conclusions, while real data boundaries, calculations, and ledger writes remain tool-controlled.

> This version is intended for personal research and is not investment advice. It never connects to a broker or places orders. Only a trade that has already occurred at a broker can be recorded, through a preview followed by explicit confirmation in a later turn.

## What it does

- Queries and compares market quotes, relative valuation, and three-statement financial detail for any Hong Kong listing (by `HKEX:` code, or by Chinese/English name).
- Structures Bear / Base / Bull valuation cases, margin of safety, and expected IRR.
- Reads local positions and strategies without inventing holdings or cost basis.
- Produces build, wait, reduce, or exit-review conditions as research drafts—not trade instructions.
- Atomically records completed real executions or initial positions after explicit confirmation.
- Adds an Alfred preset, investment-research Skill, natural-language tool use, and contextual help to DSH Web.

Any Hong Kong code works (e.g. `HKEX:0001` CK Hutchison, `HKEX:2020` Anta, `HKEX:9633` Nongfu Spring). The following three are shortcut anchors with Chinese aliases:

| Company | Instrument ID | Market symbol |
| --- | --- | --- |
| Xiaomi Corporation-W | `HKEX:1810` | `01810` |
| Tencent Holdings | `HKEX:0700` | `00700` |
| Alibaba Group-W | `HKEX:9988` | `09988` |

## Quick start: connect it to DSH

### 1. Prepare the repository

You need Windows, Git, Node.js 24+, Python 3.12, and [uv](https://docs.astral.sh/uv/). Models and API keys are configured in DSH; Alfred does not store model credentials.

```powershell
git clone https://github.com/cty41/fin-alfred.git
cd fin-alfred
npm ci
uv sync --frozen --project data-provider
npm run build
```

### 2. Link the plugin into the DSH Web profile

```powershell
npx --yes @deepseek-ai/dsh plugin --profile web add ./packages/dsh-alfred
powershell -ExecutionPolicy Bypass -File ./packages/dsh-alfred/scripts/install-preset.ps1
```

Optionally link it into the headless profile as well:

```powershell
npx --yes @deepseek-ai/dsh plugin --profile headless add ./packages/dsh-alfred
```

### 3. Configure local data paths

Add or update this row in `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`:

```yaml
- id: dsh-alfred
  config:
    pythonPath: C:/path/to/fin-alfred/data-provider/.venv/Scripts/python.exe
    adapterPath: C:/path/to/fin-alfred/data-provider/akshare_adapter.py
    dbPath: C:/Users/<user>/AppData/Local/fin-alfred/alfred.db
    timeoutMs: 30000
    confirmationTtlMs: 600000
```

Use forward slashes in paths. Apply the same row to the headless profile when needed.

### 4. Verify and start DSH

```powershell
npx --yes @deepseek-ai/dsh --profile web --dump-config
npx --yes @deepseek-ai/dsh web --port 3091
```

Open `http://127.0.0.1:3091`, create a session, and select the `alfred` preset. Start with:

```text
Query the current quote for HKEX:1810 and include the observation time and source.
```

See [packages/dsh-alfred/README.en.md](packages/dsh-alfred/README.en.md) for plugin configuration, tool details, and troubleshooting.

## Example research prompts

```text
Analyze whether Tencent is attractive for a new position. Give Bear, Base, and Bull cases and list the evidence that still needs verification.

Compare Tencent and Alibaba on margin of safety. Do not assume I already hold either company.

Read my Xiaomi position and explain the conditions for adding, waiting, and reducing.
```

For a completed trade, state that it already occurred:

```text
I sold 1,000 Xiaomi shares at HKD 30 on 2026-08-20 with HKD 10 commission. Preview the ledger entry first.
```

Alfred returns a preview and confirmation token, then stops. A matching commit tool can write to SQLite only after explicit confirmation in a later turn. Planned trades, hypothetical fills, and model recommendations cannot modify the ledger.

## Safety boundaries

- **Local-first:** positions, strategies, and executions live in `%LOCALAPPDATA%\fin-alfred\alfred.db`. It is plain SQLite; protect and back it up accordingly.
- **Evidence-first:** market and valuation results should expose source and observation time; missing evidence must remain visible.
- **Research is not execution:** the plugin has no broker connection and cannot submit orders.
- **Confirmed writes:** tokens are session-bound, expire after ten minutes by default, and are single-use. Ledger and position updates share one SQLite transaction.
- **The model is not a source of truth:** it organizes research but cannot replace tool data or invent a portfolio.
- **Coverage and heuristic caveat:** any Hong Kong listing is addressable, but valuation and financial detail depend on upstream availability. The three-statement "standard-account summary" is assembled by generic Chinese-keyword rules and may under- or over-count for unusual layouts (banks, property, REITs); always verify against the raw statement rows.

## Data and failure boundaries

The local Python adapter uses AKShare and upstream public interfaces for market, relative-valuation, and three-statement financial data. Network failures, rate limits, or upstream schema changes may make data unavailable. Alfred retries connection errors, timeouts, and HTTP 429/5xx with exponential backoff, and returns a structured error or degraded result instead of fabricating data. The full securities list is cached with a 24-hour TTL to avoid rate-limit-triggering refreshes. Verify investment decisions against exchange filings, company reports, and broker confirmations.

## Standalone deterministic tools

The repository still includes the DSH-independent CLI and Gateway for direct local-data administration and deterministic commands:

```powershell
npm run alfred
npm run gateway
npm run dashboard
```

Commands include `watchlist`, `quote`, `position`, `trade log`, `strategy`, and `migrate import`. They remain the underlying and fallback interface; DSH Alfred is the recommended conversational surface.

## Development and verification

```powershell
npm run typecheck
npm test
npm run build
uv run --frozen --project data-provider python -m unittest discover -s data-provider -p "test_*.py" -v
npm pack --workspace dsh-alfred --dry-run
```

After changing the DSH client, run the root build and confirm `dist/client.js` still registers through `window.__ModuleLoader__.load(...)`. See [AGENTS.md](AGENTS.md), [docs/product.md](docs/product.md), and [docs/architecture.md](docs/architecture.md) for contributor and agent context.

## Distribution status

Only source builds linked from a local checkout are supported today. The plugin depends on sibling core and AKShare-provider workspaces, so npm and `github:cty41/fin-alfred` one-command installation are intentionally not advertised yet. The `dsh-plugin` discovery topic will be added after the plugin becomes a self-contained distribution.

See the [official DSH plugin publishing guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md) for bundle, profile, and Git-install behavior.

## License

[Apache-2.0](LICENSE)
