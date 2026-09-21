# Markets Lab Dashboard

Static GitHub Pages UI. Box publisher overwrites `status.json` and `equity_history.json` only (sanitized, no secrets).

Publisher library: `lib/` — run `npm test` for WP1/WP2 regression suite (28 tests).

## Equity definition

### Headline — `lab_curve_v4` (current)

**`equity_usd` = lab cash ledger + lab position marks**

- Separate lab vs personal cash flows: deposits, withdrawals, transfers, purchases, sales, fees, settlements.
- Lots attributed by owner (explicit → strategy_id → personal ticker patterns → allowlist). **Allowlist alone is insufficient.**
- Original **$200** lab allocation baseline preserved (`starting_bankroll_usd`).
- Personal purchases (e.g. NFL) do **not** reduce lab headline.

### Superseded — `lab_curve_v3` (bridge only)

`portfolio_equity − nonlab_position_marks − $40 pre_lab_cash`

Published as `legacy_headline_v3_usd` with `nav_bridge` to corrected v4 NAV. **Do not silently rewrite** past `equity_history.json` points; append only; use `nav_bridge` marker rows for corrections.

### Secondary (not headline)

`lab_synthetic_equity_usd ≈ 200 + realized_lab_pnl + unrealized_lab_mtm` — cross-check only.

## Fill normalization (WP2)

- Raw exchange fields preserved; one canonical side/price per fill verified against cash + inventory Δ.
- Published fills: `fill_id`, `order_id`, `ownership`, `strategy_id`, `normalization_confidence`, `cash_delta_usd`, inventory deltas.
- Resting orders include canonical `risk_usd` (resolves complement-book vs inventory contradictions).
- Missing data → `unknown`, never fabricated 0/midpoint.

## Freshness

The UI shows separately:

- status age (`status.json` `updated_at`)
- chart age (newest `equity_history.json` point `t`, or optional `equity_history_updated_at`)
- oldest input age (optional `oldest_input_updated_at`)
- reconciliation age (optional `reconciliation_updated_at`)

It warns when the chart newest point lags status by more than 1 hour.

## Fills

Open marks are labeled **unrealized** (not wins). Fees, `strategy_id`, `ownership`, and normalization confidence display when present.

See `ENGINEERING_NOTE.md` for Markets consumption guide and `CHANGELOG.md` for v3→v4 bridge details.
