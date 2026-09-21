# Engineering note: consuming corrected NAV bridge (WP1)

**Audience:** Markets consultant / Chief reconciliation replies  
**Publisher version:** 1.1.2 (`lab_curve_v4`)  
**Date:** 2026-09-20 (Chief P1 remediation)

## What changed

| Field | `lab_curve_v3` (superseded) | `lab_curve_v4` (headline) |
|---|---|---|
| Formula | `portfolio_equity − nonlab_marks − $40` | `lab_cash_ledger + lab_position_marks` |
| Personal purchase | Cash drop charged to lab headline | Debits **personal** cash only |
| Ownership | Allowlisted ticker prefix | Explicit owner → strategy_id → personal patterns |
| Baseline | $200 (unchanged semantics) | $200 lab deposit preserved |

## How Markets should read `status.json`

1. **Headline:** `equity_usd` / `lab_equity_usd` when `equity_definition === "lab_curve_v4"`.
2. **Legacy (do not use for P&L):** `legacy_headline_v3_usd` — the old scoreboard value.
3. **Bridge:** `nav_bridge` object:
   ```json
   {
     "from_definition": "lab_curve_v3",
     "to_definition": "lab_curve_v4",
     "from_headline_usd": 134.86,
     "to_corrected_nav_usd": 144.77,
     "adjustments": [
       { "reason": "personal_nfl_purchase_not_lab_loss", "amount_usd": 9.91, "ref": "KXNFLGAME-26SEP20CINHOU-HOU" }
     ],
     "unexplained_residual_usd": 0,
     "note": "v3 headline superseded — ..."
   }
   ```
4. **Personal book:** `personal_nav_usd`, `personal_cash_usd`, `personal_positions_usd`, `personal_legs`.
5. **Lab book:** `lab_cash_usd`, `lab_positions_usd`.

## Equity history (append-only)

- Prior `lab_curve_v3` points remain in `equity_history.json`.
- New points use `definition: "lab_curve_v4"`.
- Bridge events are appended as **marker** rows (`marker: "nav_bridge"`) — never rewrite prior timestamps.
- Chart may show a discontinuity at the bridge; UI displays bridge note when `nav_bridge` is present.

## NFL 10:04 → 10:07 CT contamination

Regression fixture: `tests/fixtures/status_2026-09-20T150410Z.json` → `status_2026-09-20T150745Z.json`.

| Metric | Before | After | Interpretation |
|---|---:|---:|---|
| v3 lab headline | $144.83 | $134.92 | −$9.91 (false weather loss) |
| Full account equity | $203.92 | $203.65 | −$0.28 (real) |
| New personal NFL mark | — | $9.63 | Personal position appeared |

**Corrected v4 behavior:** lab NAV moves only with lab cash/positions; personal NFL purchase affects `personal_nav_usd` only.

## Fill normalization (WP2) — Markets checks

- `recent_fills[].normalization_confidence`: `verified` | `inferred_complement` | `unverified` | `unknown`.
- **Complement flip is opt-in only** (`prefer_complement_correction: true`). Default: published `buy_no@74` stays `buy_no` (cash −$4.44), not flipped to `buy_yes@26`.
- **Never select side by `max(yes_price, no_price)`** — Kalshi always echoes both legs; the higher price is often the complement (SEP21: buy YES@6¢ also shows no@94¢). Box `write_public_status.py` and `kalshi_labels.py` must prefer `outcome_side` / `side` and the matching price field. Poisoned historical rows recover via `resolveFromExchangeOutcome` when raw `outcome_side` or bare `side` is present; otherwise fail-closed (`unverified`).
- `unverified` / `unknown` fills **block certified NAV** (`authoritative: false`).
- Kalshi fixed-point API fields supported: `count_fp`, `yes_price_dollars`, `no_price_dollars`, `remaining_count_fp`.
- `recent_fills[].ownership`: `lab` | `personal` | `unknown`.
- SEP15 raw exchange path: realized P&L **+$1.00** (illustrative fixture — see `tests/fixtures/FIXTURE_PROVENANCE.md`).
- SEP21 resting: `risk_usd` ≈ **$1.20** (not $18.80 literal NO notional).
- Entry fees allocated into realized P&L on FIFO match; rebates preserve signed `fee_usd`.
- Raw fields preserved in publisher output (`raw_side`, `raw_price_cents`); compare to exchange export.

## Publication authority (Chief P1-4)

`publishStatus` returns `authoritative: true` only when **all** hold:

1. `opening_allocation_verified` (or explicit verified $200 lab deposit in `deposits[]`).
2. `acquisition_complete` — no incomplete/unverified fills in the cash ledger.
3. `cash_reconcile.reconciled` — `lab_cash_usd + personal_cash_usd === portfolio_cash_usd` (±$0.01).

When blocked: `equity_usd` / `lab_equity_usd` are `null` (no synthetic $200 headline). Check `publish_blocked_reasons[]`.

New fields: `authoritative`, `publish_blocked`, `publish_blocked_reasons`, `cash_reconcile`, `opening_allocation_verified`, `acquisition_complete`, `incomplete_fill_ids[]`.

## v3 bridge (Chief P1-5)

`legacy_headline_v3_usd` uses `portfolio_equity_usd` from the snapshot (not a misnamed `equity_usd` field). Probe: $225 equity, $0 personal marks, $40 pre-lab → **$185** legacy headline.

## Box publisher — side labeling (Gate-3)

**Incident (2026-09-21):** Box `write_public_status.py` used `if no_c > yes_c: label buy_no`, turning SEP21 buy YES@6¢×20 ($1.20 cash) into `buy_no@94` (−$18.80). Kalshi echoes both prices on every fill/order.

| Rule | Required behavior |
|---|---|
| Side source | `outcome_side` → `side` (yes/no) — never `max(yes_c, no_c)` |
| Price | `yes_price_dollars` for YES leg, `no_price_dollars` for NO leg |
| Recovery | `fill_normalize.resolveFromExchangeOutcome` when poisoned row retains raw `outcome_side` |
| Fail-closed | No `outcome_side` / bare `side` → `unverified`, blocks certified NAV |

Canonical implementation: `box_publisher/kalshi_labels.py` (`label_fill`, `label_resting_order`). Regression: `tests/test_kalshi_labels.py`, `tests/fill_normalize.test.js` (Gate-3 block).

## Box publisher integration

```javascript
import { publishStatus, appendEquityPoint, appendBridgeMarker } from './lib/publisher.js';

const status = publishStatus(exchangeSnapshot);
// status.nav_bridge_adjustments can be pre-filled for known one-off events
```

Run tests: `npm test` (Chief P1 regression suite included).

## Open exposure (`open_usd`) — DASH_RECON_LIE contract

**Incident (2026-09-20):** Box `apply_v4_cutover.mjs` merged `open_usd: v4.open_usd ?? base.open_usd`. Publisher `open_usd` was `sum(resting.risk_usd) + sum(|lab mtm|)` (~$23), overwriting Python recon `total_open_worst_case_usd` (~$5.64) → DASH_RECON_LIE alert.

### Field ownership

| Field | Source | Use |
|---|---|---|
| `open_usd` | Python recon (`total_open_worst_case_usd` / lab_hourly) | **Authoritative** exposure on Pages/status |
| `open_usd_v4_estimate` | Publisher heuristic (resting risk + \|lab MTM\|) | Debug/diagnostic only — never headline exposure |
| `remaining_usd` | `max_open_usd − open_usd` (recon-backed) | Capacity left |

### Box merge contract (required)

```javascript
const merged = {
  ...base,
  // ... v4 equity fields from publishStatus ...
  open_usd: base.open_usd,                              // Python recon — never overwrite
  open_usd_v4_estimate: v4.open_usd_v4_estimate ?? null,
  remaining_usd: base.remaining_usd ?? (
    base.max_open_usd != null && base.open_usd != null
      ? Math.max(0, Number(base.max_open_usd) - Number(base.open_usd))
      : base.remaining_usd
  ),
};
```

**Never:** `open_usd: v4.open_usd ?? base.open_usd` — the v4 publisher does not compute recon worst-case; `publishStatus` returns `open_usd: null` unless `recon_open_usd` / `total_open_worst_case_usd` is passed in the snapshot.

Regression: `tests/dash_recon_lie_regression.test.js`.

## Not in scope (per constraints)

- No live trading, capital increase, or micro_trial arming.
- Deployed box must adopt this library before published `status.json` reflects v4 fields.
