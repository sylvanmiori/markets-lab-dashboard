# Changelog

## 1.1.4 — 2026-09-21 (Gate 3 personal ownership)

- **Gate 3:** `attributeOwner` defaults non-allowlist fills/positions with a ticker to **`personal`** instead of `unknown`, so hist fills are not skipped in the cash ledger. Empty ticker still → `unknown`.

## 1.1.3 — 2026-09-21 (Gate-3 complement poison)

- **Gate-3:** Box `write_public_status.py` tracked in `box_publisher/` — side from `outcome_side`/`side`, never `max(yes,no)`. SEP21 buy YES@6×20 → $1.20 cash (not buy_no@94 / −$18.80).
- `kalshi_labels.py` extracted for regression tests; `resolveFromExchangeOutcome` recovers poisoned rows when raw `outcome_side` present.

## 1.1.2 — 2026-09-21 (DASH_RECON_LIE)

- **DASH_RECON_LIE:** `publishStatus` no longer publishes resting+MTM sum as authoritative `open_usd`; returns `null` fail-closed unless `recon_open_usd` / `total_open_worst_case_usd` is in the snapshot. Inflated heuristic moved to `open_usd_v4_estimate`.
- Box merge contract documented in `ENGINEERING_NOTE.md`: Pages `open_usd` = Python recon; never `v4.open_usd ?? base.open_usd`.

## 1.1.1 — 2026-09-20 (Chief P1 remediation)

### Chief review fixes (dashboard only — no live trading)

- **P1-1:** Complement flip is opt-in only; `buy_no@74×6` stays −$4.44; already-normalized fills pass through unchanged; `unverified` rows block certified NAV.
- **P1-2:** Parse Kalshi fixed-point fields (`count_fp`, `yes_price_dollars`, `no_price_dollars`); incomplete acquisition rejects publish.
- **P1-3:** FIFO realized P&L keyed by `ticker|owner|side` — cross-ticker lots no longer match.
- **P1-4:** `publishStatus` requires verified opening allocation + cash reconcile; blocked publish returns `equity_usd: null` (no synthetic $200).
- **P1-5:** v3 bridge uses `portfolio_equity_usd` (probe: $225 → $185 legacy headline).
- **P1-6:** Entry fees allocated into realized P&L; rebates preserve signed cash.
- Fixture provenance documented in `tests/fixtures/FIXTURE_PROVENANCE.md`.

## 1.1.0 — 2026-09-20 (WP1 + WP2)

### WP1 — Lab vs personal cash ledger (`lab_curve_v4`)

- **Stopped** computing lab headline as `(all cash + all marks − personal open marks − fixed $40)`.
- Added separate **lab** and **personal** cash-flow ledgers: deposits, withdrawals, transfers, purchases, sales, fees, settlements.
- Lot ownership attributed by **explicit owner → strategy_id → personal ticker patterns → allowlist → personal** (allowlist alone is insufficient; empty ticker → `unknown`).
- Headline equity is now `lab_curve_v4`: **lab cash ledger + lab position marks**, with original **$200** lab allocation baseline preserved.
- Published **`nav_bridge`** object linking superseded `lab_curve_v3` headline to corrected v4 NAV — append-only; old history is **not** silently rewritten.
- Regression fixture reproduces Sep 20 **10:04 vs 10:07 CT** NFL purchase contamination (~−$9.91 false lab loss).

### WP2 — Fill/order normalization

- Fixed complement-book mislabel: SEP15 scalp now shows **buy YES@6¢ / sell YES@11¢ = +$1**, not buy NO@94¢ / sell NO@89¢ = −$1.
- Raw exchange fields preserved on every published fill; one canonical side/price derived and verified against cash + inventory deltas.
- Resting orders carry **`risk_usd`** using canonical side (resolves SEP21 **$1.20** vs literal **$18.80** NO-notional).
- Published fills include stable IDs, ownership, `normalization_confidence`, inventory Δ, cash Δ; missing → `unknown`, never fabricated 0/midpoint.
- Acceptance tests: buy/sell YES/NO, partial fills, fractional counts, close-to-flat, oversell, fees.

### Dashboard

- UI shows v4 headline, legacy v3 headline (when bridged), personal NAV, bridge note, fill owner/confidence, resting order risk.
