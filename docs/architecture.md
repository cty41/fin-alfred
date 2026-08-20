# DSH Alfred architecture

## System shape

```text
User in DSH Web
      |
      v
Alfred preset + startup guidance + investment Skill
      |
      v
DeepSeek Harness agent loop (model/provider owned by DSH)
      |
      +------------------------+-------------------------+
      |                        |                         |
      v                        v                         v
Market/read tools        Strategy calculation     Confirmed write tools
      |                        |                         |
      v                        v                         v
AKShare provider          deterministic rules      preview token gate
      |                                                  |
      v                                                  v
Python adapter                                      SQLite transaction
      |                                                  |
      v                                                  v
Public upstream data                            ledger_entries + positions
```

## Components

### DSH bundle

`packages/dsh-alfred` is both a server plugin and a Web client bundle. `cordis.patch.yml` inserts the server plugin into a DSH profile. The package manifest declares the DSH bundle and Web-client injections.

The server registers nine tools, the bundled investment Skill, and an `agent/session-start` listener. Startup guidance is injected only when the session header selects the `alfred` preset.

The Web client registers a help card in `conversation.input.dock` and a help button in `conversation.input.right`. Example prompts update the draft only. The build wrapper emits the factory format required by DSH's browser module loader.

### Research service

The research service normalizes user aliases to one of three instrument IDs. Quote and relative-valuation calls cross the Node/Python boundary through `packages/provider-akshare`; abort signals and timeouts terminate abandoned subprocess work.

Market results are bounded envelopes carrying an instrument, data, source, observation time, warning, or explicit error. Raw upstream series are not copied into model context when a compact summary is sufficient.

Financial statements cross the same Node/Python boundary through a `financials` action. The Python adapter maps the Eastmoney F10 three-statement reports (balance `RPT_HKF10_FN_BALANCE_PC`, income `_INCOME_PC`, cashflow `_CASHFLOW_PC`) into a bounded envelope keyed by statement kind. The TypeScript service then bestows a stable standard-account summary (cash, investments, interest-bearing debt, minority interest, totals) via the versioned mapping layer in `packages/core/src/financials.ts`, while preserving raw rows for audit. Raw Eastmoney account names are non-uniform across instruments and are not assumed to be XBRL-standard.

Portfolio context opens the configured SQLite database read-only. Missing databases, incompatible schemas, missing positions, and missing strategies remain distinguishable states.

### Strategy evaluator

The evaluator is a pure function. It validates positive price/value inputs and produces one of: `data-insufficient`, `exit-review`, `build-candidate`, `wait`, or `reduce-reference`. Company-specific research belongs in the Skill and evidence gathering; capital-safety gates remain common and deterministic.

### Confirmed ledger adapter

Prepare tools validate and normalize the proposed completed execution, read current state, compute a fixed-point projection, and issue an in-memory token. They do not write SQLite.

Commit tools consume a session-bound, expiring, single-use token and open `BEGIN IMMEDIATE`. Inside the transaction they recheck the execution key, position, cash, and quantity; then insert `ledger_entries` and update `positions` before one commit. Any failure rolls back. Initial-position tools use the same two-phase boundary and refuse to overwrite existing position or execution history.

## Trust boundaries

- **Model boundary:** model output is untrusted orchestration and prose. Only registered tool code can read bounded local state or write the ledger.
- **Market-data boundary:** AKShare and its upstream sources are untrusted and mutable. Validate shapes, retain source/time, and fail visibly.
- **Local-data boundary:** SQLite contains personal financial state in plaintext. It stays local by default and must never be committed.
- **Confirmation boundary:** possession of a token is insufficient; the commit must run in the originating DSH session before expiry.
- **Distribution boundary:** source-link installation executes locally built code. Public registry/Git installation requires a separate self-contained packaging and supply-chain review.

## Build and runtime flow

The root TypeScript project builds server packages. `packages/dsh-alfred/scripts/build-client.mjs` separately bundles the TSX client as CommonJS inside `window.__ModuleLoader__.load`. Root `npm run build` intentionally invokes this client step after `tsc -b`; bypassing it can produce an ESM file that DSH refuses to load.

At runtime, DSH composes the base bundle, installed bundle patches, profile `cordis.patch.yml`, home overlay, and command-line overlays in order. User profile configuration supplies machine-specific Python, adapter, database, timeout, and token TTL values.

## Verification layers

- Unit tests cover aliases, bounded envelopes, strategy invariants, fixed-point arithmetic, token replay/session/expiry, oversell, insufficient cash, initial-position refusal, financial-statement mapping, and enterprise-value derivation.
- Integration tests cover Skill/startup scoping, Web slot registration, three-company scenarios, and transaction rollback after state changes.
- Python tests cover adapter retry/fallback behavior and the financial-statement envelope and per-report column sets.
- Build verification checks type safety, package contents, and DSH browser registration.
- Runtime acceptance checks composed config, plugin loading, Alfred preset visibility, Help UI behavior, and representative prompts. Visual and model-quality acceptance must not be inferred solely from unit tests.
