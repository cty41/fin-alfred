# DSH Alfred product contract

## Purpose

DSH Alfred helps an individual investor conduct deep, evidence-led value research and turn it into explicit portfolio conditions without giving an AI model authority over broker execution or unverified financial state.

The primary user sits at a computer, uses DeepSeek Harness for long-form research, and wants one conversational surface for market evidence, valuation scenarios, portfolio context, and staged strategy work. The current release is Chinese-first in interaction but ships complete Chinese and English documentation.

## Value proposition

- **Useful context, not generic chat:** tools provide bounded market, valuation, and portfolio facts for the supported companies.
- **Auditable reasoning:** answers separate facts, assumptions, calculations, missing evidence, and strategy drafts.
- **Local control:** personal positions, strategies, and executions remain in a local SQLite database.
- **Safe write boundary:** only an already completed broker execution can enter the ledger, after preview and later explicit confirmation.
- **Harness-native interaction:** DSH supplies the model, session loop, permissions, UI, and plugin composition; Alfred concentrates on investment-domain capability.

## Supported release scope

- Any Hong Kong listing, addressed by `HKEX:` + code (e.g. `HKEX:0700`, `HKEX:0001`) or, for a name, resolved against the cached securities master. Three anchor listings — Xiaomi (`HKEX:1810`), Tencent (`HKEX:0700`), and Alibaba (`HKEX:9988`) — keep first-class Chinese aliases and shortcuts.
- Market quote, relative-valuation evidence, and three-statement financial detail (balance/income/cashflow) with a standard-account summary through the local AKShare adapter.
- Read-only portfolio and active-strategy context from the Alfred database.
- Bear / Base / Bull strategy-state evaluation using price, downside, Base IRR, evidence completeness, and thesis red lines.
- Confirmed registration of completed executions and first-time initial positions.
- Alfred preset, investment-research Skill, startup guidance, and contextual Web help.

The standard-account summary (cash, investments, interest-bearing debt, minority interest, and asset/liability/equity totals) is produced by a versioned Chinese-keyword mapping layer. It is heuristic — for unusual statement layouts (banks, property, REITs) it may under- or over-count, so the raw rows are always preserved for audit and must be checked per company.

## Product rules

1. A model response is a research artifact, not a fact or execution receipt.
2. Missing or stale evidence reduces confidence; it never licenses fabrication.
3. Historical cost and technical price action may inform execution context but cannot replace intrinsic-value and thesis analysis.
4. Strategy thresholds are explicit, versioned defaults—not universal market laws.
5. A planned order, recommendation, or hypothetical fill is never a real execution.
6. Only a registered real execution changes the ledger; the ledger update must be idempotent and atomic.

## Non-goals for the current release

- Broker connectivity, order routing, automatic trading, or autonomous portfolio management.
- Personalized financial advice, suitability assessment, tax advice, or regulatory compliance services.
- Full financial-statement ingestion, production-grade DCF forecasting, live exchange feeds, or guaranteed market-data availability.
- Broad security coverage, A-share workflows, multi-currency portfolio accounting, or portfolio optimization.
- Per-company exact standard-account reconciliation: the statement summary is keyword-heuristic, not a XBRL-grade mapping.
- Public npm/GitHub one-command installation. The current plugin is linked from a built monorepo checkout.

## Success criteria

A user can install the source checkout, select the Alfred preset, ask a natural-language question about a supported company, see tool-grounded evidence with dates and limitations, receive explicit strategy conditions, and—only when needed—record a completed execution through the two-turn confirmation boundary. Failures remain visible and do not corrupt local state.

## Distribution milestones

The repository can be presented publicly as a working personal-use project now. Marketplace discovery through the `dsh-plugin` topic comes later, after the plugin is self-contained, ships prebuilt server/client output, no longer depends on sibling `file:` workspaces, and passes a clean profile installation test.
