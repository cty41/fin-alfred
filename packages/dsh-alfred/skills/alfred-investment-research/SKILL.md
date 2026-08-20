---
name: alfred-investment-research
description: Analyze Xiaomi, Tencent, or Alibaba in DSH using Alfred market, fundamentals, portfolio, valuation-strategy, and confirmed-ledger tools. Use for Chinese or English questions about value, margin of safety, portfolio risk, staged buying or selling, earnings impact, or recording a real completed trade.
---

# Alfred Investment Research

1. Resolve the company to `HKEX:1810`, `HKEX:0700`, or `HKEX:9988`. Ask when ambiguous.
2. Call quote and fundamentals before making current claims. Call portfolio context when holdings, cash, concentration, or selling are relevant.
3. For intrinsic-value or enterprise-value work, call `alfred_financial_statements` to obtain the three-statement detail and the standard-account summary (cash, investments, interest-bearing debt, minority interest, totals). Always restate the report date and currency (CNY) with any figure you use.
4. State source dates and missing inputs. Separate facts, calculations, assumptions, and conclusions. Never invent missing financial data.
5. Read [references/valuation-framework.md](references/valuation-framework.md) for valuation or cross-company comparison.
6. Read [references/position-strategy.md](references/position-strategy.md) for buying, selling, position sizing, Xiaomi stages, or real executions.
7. Use `alfred_value_strategy` only after Bear/Base/Bull values and Base IRR have evidence. Treat its thresholds as versioned defaults, not proven market laws.
8. Treat technical price action only as execution timing. Do not use historical cost as an investment trigger.
9. Never claim to place a broker order. For a completed real trade, call a prepare tool, show its complete preview, stop, and wait for a later explicit user confirmation before calling the matching commit tool.
