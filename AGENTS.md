# Repository guidance for coding agents

## Product

DSH Alfred is a local-first, auditable value-investing research agent for Hong Kong stocks. The recommended user surface is the `packages/dsh-alfred` DeepSeek Harness bundle. The standalone CLI/Gateway remains a deterministic administration and fallback interface.

Read [docs/product.md](docs/product.md) before changing product behavior and [docs/architecture.md](docs/architecture.md) before changing module boundaries or DSH integration.

## Non-negotiable boundaries

- Research and strategy output is not broker execution. Never add broker connectivity or automatic order submission without a separate proposal and threat-model update.
- Only registered real executions may change the ledger. Model text, strategy recommendations, and hypothetical fills must remain read-only.
- A DSH ledger write requires a complete prepare preview and explicit confirmation in a later user turn. Tokens are session-bound, short-lived, and single-use.
- Keep SQLite execution insertion and position update in one transaction; revalidate cash, holdings, and idempotency inside the transaction.
- Never fabricate market data, holdings, cost basis, source dates, or successful writes. Return explicit unavailable/degraded/error states.
- Preserve fixed-point decimal arithmetic for money and quantities.
- Do not commit API keys, personal investment data, SQLite databases, local profile overlays, or machine-specific paths.

## Repository map

- `packages/dsh-alfred`: DSH bundle, tools, Skill, preset, Web help, and confirmed ledger adapter.
- `packages/core`: deterministic decimal, ledger, valuation, decision, and strategy domain logic.
- `packages/provider-akshare`: TypeScript bridge to the Python market-data adapter.
- `data-provider`: uv-locked Python adapter and tests for AKShare/upstream public sources.
- `packages/gateway`, `packages/cli`, `packages/ui`: standalone local application surfaces.
- `packages/provider-llm`: optional local-model intent translation for the standalone application, not the DSH model provider.

## DSH constraints

- The package must retain a static `dsh.bundle.patch` manifest and a matching `cordis.patch.yml` row.
- The Web client is not ordinary ESM. `npm run build` must leave `packages/dsh-alfred/dist/client.js` registered through `window.__ModuleLoader__.load({ id: "dsh-alfred", ... })`.
- DSH owns model selection and credentials. Do not add model-provider configuration or secrets to Alfred.
- Keep the bundled Skill and `agent/session-start` guidance scoped to the `alfred` preset.
- Current source distribution is monorepo-local. Do not advertise npm/GitHub one-command installation or add the `dsh-plugin` discovery topic until a self-contained package passes clean-install verification.

## Verification

Run all relevant checks before claiming completion:

```powershell
npm run typecheck
npm test
npm run build
uv run --frozen --project data-provider python -m unittest discover -s data-provider -p "test_*.py" -v
npm pack --workspace dsh-alfred --dry-run
python "$env:USERPROFILE/.codex/skills/.system/skill-creator/scripts/quick_validate.py" packages/dsh-alfred/skills/alfred-investment-research
```

The last command is optional when the validator is not installed. For DSH runtime changes, also inspect `--dump-config`, restart the affected profile, and distinguish automated loading checks from manual Web UI acceptance.

## Change discipline

- Preserve unrelated dirty-worktree changes. Stage and commit only explicit task paths.
- Prefer small deterministic functions and tests for failure, replay, expiry, race, and insufficient-data cases.
- Update both Chinese and English README variants when user-visible behavior, commands, configuration, or supported instruments change.
- Update `docs/product.md` for goal/scope changes and `docs/architecture.md` for component, data-flow, persistence, or trust-boundary changes.
- Do not push, publish, change GitHub metadata, or perform other external writes unless the user explicitly authorizes that action.
