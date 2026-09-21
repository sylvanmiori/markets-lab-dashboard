import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { publishStatus } from '../lib/publisher.js';
import { LAB_BASELINE_USD, PRE_LAB_PERSONAL_CASH_USD } from '../lib/constants.js';

const OPENING = {
  opening_allocation_verified: true,
  deposits: [{ ts: '2026-08-28', amount_usd: LAB_BASELINE_USD, owner: 'lab' }],
};

const EXCHANGE_CASH = LAB_BASELINE_USD + PRE_LAB_PERSONAL_CASH_USD;

/** Synthetic incident shape: resting+mtm ≈ $23 vs Python recon open $5.64. */
function incidentSnapshot(overrides = {}) {
  return {
    ...OPENING,
    portfolio_equity_usd: 240,
    portfolio_cash_usd: EXCHANGE_CASH,
    portfolio_positions_usd: 18.8,
    positions: [
      { ticker: 'KXHIGHCHI-26SEP18-B76.5', qty: 20, mtm_usd: 17.64, strategy_id: 'WX_CHI' },
    ],
    resting_orders: [
      {
        ticker: 'KXHIGHCHI-26SEP21-B67.5',
        side: 'buy_no',
        price_cents: 94,
        qty: 20,
        risk_usd: 1.2,
      },
      {
        ticker: 'KXHIGHCHI-26SEP20-B73.5',
        side: 'buy_no',
        price_cents: 74,
        qty: 6,
        risk_usd: 4.44,
      },
    ],
    fills: [],
    ...overrides,
  };
}

describe('DASH_RECON_LIE — open_usd must not be resting+mtm estimate', () => {
  it('publishStatus returns null open_usd and separate v4 estimate without recon in snapshot', () => {
    const status = publishStatus(incidentSnapshot());

    const expectedEstimate = Math.round((1.2 + 4.44 + 17.64) * 100) / 100;
    assert.equal(status.open_usd_v4_estimate, expectedEstimate);
    assert.equal(status.open_usd, null);
    assert.notEqual(status.open_usd, status.open_usd_v4_estimate);
    assert.ok(status.open_usd_v4_estimate >= 10, 'estimate should be materially inflated vs recon');
  });

  it('passes through recon_open_usd when provided in snapshot', () => {
    const status = publishStatus(incidentSnapshot({ recon_open_usd: 5.64 }));

    assert.equal(status.open_usd, 5.64);
    assert.ok(status.open_usd_v4_estimate > status.open_usd);
    assert.notEqual(status.open_usd, status.open_usd_v4_estimate);
  });

  it('passes through total_open_worst_case_usd alias', () => {
    const status = publishStatus(incidentSnapshot({ total_open_worst_case_usd: 5.64 }));

    assert.equal(status.open_usd, 5.64);
    assert.notEqual(status.open_usd, status.open_usd_v4_estimate);
  });

  it('box merge contract: base.open_usd wins; never v4.open_usd ?? base.open_usd', () => {
    const base = { open_usd: 5.64, max_open_usd: 50, remaining_usd: 44.36 };
    const v4 = publishStatus(incidentSnapshot());

    const merged = {
      open_usd: base.open_usd,
      open_usd_v4_estimate: v4.open_usd_v4_estimate ?? null,
      remaining_usd:
        base.max_open_usd != null && base.open_usd != null
          ? Math.max(0, Number(base.max_open_usd) - Number(base.open_usd))
          : base.remaining_usd,
    };

    assert.equal(merged.open_usd, 5.64);
    assert.equal(merged.remaining_usd, 44.36);
    assert.ok(merged.open_usd_v4_estimate > merged.open_usd);
    assert.notEqual(merged.open_usd, merged.open_usd_v4_estimate);

    // Pre-fix publisher returned inflated sum as v4.open_usd — this merge overwrote recon.
    const legacyV4 = { open_usd: v4.open_usd_v4_estimate };
    const badMerge = { open_usd: legacyV4.open_usd ?? base.open_usd };
    assert.notEqual(badMerge.open_usd, base.open_usd, 'v4.open_usd ?? base.open_usd must not be used');
    assert.equal(v4.open_usd, null, 'current publisher must not emit recon as open_usd');
  });
});
