# Test fixture provenance

## SEP15 (`sep15_scalp_raw.json`)

**Source:** Illustrative, sanitized records shaped like Kalshi exchange fills for the
`KXHIGHCHI-26SEP15-B86.5` weather scalp (buy YES@6¢ / sell YES@11¢, 20 contracts).

- `fills[]` — raw exchange-shaped rows (`action`/`side`/`yes_price`/`count`).
- `published_wrong[]` — deliberately mislabeled dashboard rows (`buy_no@94` / `sell_no@89`)
  used to prove complement inference is **opt-in only** (Chief P1-1). These rows do **not**
  prove exchange truth; they model a known mislabeling failure mode.

**Expected economics (raw exchange path only):** +$1.00 realized on the round-trip.

## SEP21 (`sep21_resting.json`)

**Source:** Illustrative resting-order rows for weather micro risk ($1.20 open risk vs $18.80
literal complement notional). Used for resting-order risk-matched complement resolution only.

## NFL contamination (`status_2026-09-20T150410Z.json` → `status_2026-09-20T150745Z.json`)

**Source:** Sanitized dashboard `status.json` snapshots from 2026-09-20 (10:04 CT / 10:07 CT).
Used to regression-test v3 headline contamination when a personal NFL position appears.

These snapshots document publisher behavior at a point in time; they are not a live exchange export.
