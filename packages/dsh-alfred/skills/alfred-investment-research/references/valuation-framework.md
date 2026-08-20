# Valuation framework

Use Bear/Base/Bull values, reverse-DCF assumptions, normalized free cash flow, balance-sheet safety, and per-share dilution. Require Base IRR of at least 15% and Bear downside no greater than 25% for a default build candidate. Treat 8%-15% as wait/hold and below 8% as a reduction reference, subject to thesis and portfolio review.

Apply red lines first: unreliable accounts, management integrity, solvency, or material appropriation stop new risk and trigger exit review. Treat missing critical evidence as unknown, never neutral.

For the balance-sheet and enterprise-value inputs, use `alfred_financial_statements`, which returns the three-statement detail and a standard-account summary (cash, investments, interest-bearing debt, minority interest, and asset/liability/equity totals) together with the report date and currency. Three-statement figures are CNY and a secondary Eastmoney aggregation; the summary's standard accounts come from a versioned mapping layer, not the companies' IR originals. Segment revenue (and the net-cash/investment detail that only the official results release carries) is not in the three statements — treat it as missing evidence, never estimate it from price.

For Tencent examine games, advertising, fintech/business services, cloud and AI capex, normalized FCF, share-based compensation, buyback cancellation, investments, net cash, and regulation.

For Alibaba examine Taobao/Tmall monetization, quick-commerce investment, cloud and AI demand/capex, international commerce losses, Cainiao and other capital consumption, net cash/investments, share-based compensation, buybacks, competition, and regulation.

Do not copy business weights between companies. In comparisons align reporting date, currency, share count, accounting scope, and data freshness.
