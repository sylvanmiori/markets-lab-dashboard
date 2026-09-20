import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { publishStatus, appendEquityPoint, appendBridgeMarker } from '../lib/publisher.js';
import { LAB_BASELINE_USD, PRE_LAB_PERSONAL_CASH_USD } from '../lib/constants.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const before = JSON.parse(readFileSync(join(__dir, 'fixtures/status_2026-09-20T150410Z.json'), 'utf8'));

describe('publisher integration', () => {
  it('publishes lab_curve_v4 fields with bridge when authoritative', () => {
    const exchangeCash = LAB_BASELINE_USD + PRE_LAB_PERSONAL_CASH_USD;
    const status = publishStatus({
      portfolio_equity_usd: before.portfolio_equity_usd,
      portfolio_cash_usd: exchangeCash,
      portfolio_positions_usd: before.portfolio_positions_usd,
      opening_allocation_verified: true,
      deposits: [{ ts: '2026-08-28', amount_usd: 200, owner: 'lab' }],
      positions: [
        { ticker: 'KXHIGHCHI-26SEP18-B76.5', qty: 20, mtm_usd: 0.96, strategy_id: 'WX_CHI' },
        { ticker: 'KXSB-27-HOU', qty: 187.52, mtm_usd: 6.56 },
      ],
      fills: [],
      resting_orders: before.resting_orders,
      allowlist: before.allowlist,
      nav_bridge_adjustments: [],
    });

    assert.equal(status.authoritative, true);
    assert.equal(status.equity_definition, 'lab_curve_v4');
    assert.ok(status.legacy_headline_v3_usd != null);
    assert.ok(status.nav_bridge);
    assert.ok(status.lab_cash_usd != null);
    assert.ok(status.personal_cash_usd != null);
    assert.ok('publish_blocked' in status);
    assert.ok('cash_reconcile' in status);
  });

  it('append-only equity history', () => {
    const hist = [{ t: '2026-09-01', equity_usd: 200, definition: 'lab_curve_v3' }];
    const h2 = appendEquityPoint(hist, 195, '2026-09-02');
    assert.equal(h2.length, 2);
    assert.equal(h2[0].equity_usd, 200);
    const h3 = appendBridgeMarker(h2, {
      bridged_at: '2026-09-20T16:00:00Z',
      from_definition: 'lab_curve_v3',
      to_definition: 'lab_curve_v4',
      from_headline_usd: 134.86,
      to_corrected_nav_usd: 144.77,
      adjustments: [],
      note: 'bridge',
    });
    assert.equal(h3.length, 3);
    assert.equal(h3[2].marker, 'nav_bridge');
  });
});
