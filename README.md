# Markets Lab Dashboard

Static GitHub Pages UI. Box publisher overwrites `status.json` and `equity_history.json` only (sanitized, no secrets).

## Equity definition (lab_curve_v3)

**Headline `equity_usd` (lab_curve_v3):** account-derived lab equity =

`Kalshi portfolio equity − non-lab position marks − $40 pre-lab cash`

with original baseline **$200** (first lab fill / lab deposit framing). Do **not** silently delete or rewrite past `equity_history.json` points; append only; use explicit correction markers if a point must be amended.

**Secondary (not headline):** `lab_synthetic_equity_usd ≈ 200 + realized_lab_pnl + unrealized_lab_mtm` from fill reconstruction — useful cross-check, not the curve source of truth.

UI polls every 20s.

## Freshness

The UI shows separately:

- status age (`status.json` `updated_at`)
- chart age (newest `equity_history.json` point `t`, or optional `equity_history_updated_at`)
- oldest input age (optional `oldest_input_updated_at`)
- reconciliation age (optional `reconciliation_updated_at`)

It warns when the chart newest point lags status by more than 1 hour.

## Fills

Open marks are labeled **unrealized** (not wins). Fees and `strategy_id` display when present on fill objects.
