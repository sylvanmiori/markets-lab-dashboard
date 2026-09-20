import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeFill,
  matchRealizedPnl,
  blocksCertifiedNav,
  parseFpDollarsToCents,
} from '../lib/fill_normalize.js';
import { buildCashLedger, computeLabHeadlineV3 } from '../lib/lab_ledgers.js';
import { publishStatus } from '../lib/publisher.js';
import { LAB_BASELINE_USD, PRE_LAB_PERSONAL_CASH_USD } from '../lib/constants.js';

describe('Chief P1-1 — normalizeFill: no default complement flip', () => {
  it('legitimate buy_no@74×6 → cash −$4.44 (not flipped to buy_yes@26)', () => {
    const n = normalizeFill({
      fill_id: 'p1-buy-no',
      ticker: 'KXHIGHCHI-26SEP20-B73.5',
      side: 'buy_no',
      price_cents: 74,
      qty: 6,
      strategy_id: 'WX_CHI',
      ts: '2026-09-20T12:00:00Z',
    });
    assert.equal(n.side, 'buy_no');
    assert.equal(n.price_cents, 74);
    assert.ok(Math.abs(n.cash_delta_usd - (-4.44)) < 1e-9);
    assert.ok(Math.abs(n.cash_delta_usd - (-1.56)) > 1e-9);
    assert.equal(n.confidence, 'unverified');
  });

  it('ambiguous published complement rows stay unresolved and block certified NAV', () => {
    const n = normalizeFill({
      ticker: 'KXHIGHCHI-26SEP15-B86.5',
      side: 'buy_no',
      price_cents: 94,
      qty: 20,
      ts: '2025-09-15T10:55:08Z',
    });
    assert.equal(n.side, 'buy_no');
    assert.equal(n.price_cents, 94);
    assert.equal(n.confidence, 'unverified');
    assert.ok(blocksCertifiedNav(n));
    assert.notEqual(n.confidence, 'inferred_complement');
  });

  it('complement inference only when explicitly opted in', () => {
    const raw = { side: 'buy_no', price_cents: 94, qty: 20, fill_id: 'x', ticker: 'T' };
    const defaultN = normalizeFill(raw);
    const explicitN = normalizeFill(raw, { prefer_complement_correction: true });
    assert.equal(defaultN.side, 'buy_no');
    assert.equal(explicitN.side, 'buy_yes');
    assert.equal(explicitN.confidence, 'inferred_complement');
  });

  it('already-normalized input is not transformed twice', () => {
    const once = normalizeFill({
      fill_id: 'norm-1',
      ticker: 'T',
      side: 'buy_no',
      price_cents: 74,
      qty: 6,
      confidence: 'unverified',
      inventory_delta_yes: 0,
      inventory_delta_no: 6,
      cash_delta_usd: -4.44,
      raw: { side: 'buy_no', price_cents: 74, qty: 6 },
    });
    const twice = normalizeFill(once);
    assert.deepEqual(twice, once);
    assert.equal(twice.cash_delta_usd, -4.44);
  });
});

describe('Chief P1-2 — fixed-point API fields + incomplete acquisition rejection', () => {
  it('parses count_fp and yes_price_dollars / no_price_dollars', () => {
    assert.equal(parseFpDollarsToCents('0.74'), 74);
    const n = normalizeFill({
      fill_id: 'fp-1',
      ticker: 'KXHIGHCHI-26SEP20-B73.5',
      action: 'buy',
      side: 'no',
      count_fp: '6',
      no_price_dollars: '0.74',
      strategy_id: 'WX_CHI',
      ts: '2026-09-20T12:00:00Z',
    });
    assert.equal(n.qty, 6);
    assert.equal(n.price_cents, 74);
    assert.equal(n.side, 'buy_no');
    assert.ok(Math.abs(n.cash_delta_usd - (-4.44)) < 1e-9);
  });

  it('incomplete acquisition (null qty/price) rejects before publish', () => {
    const incomplete = normalizeFill({ fill_id: 'bad-1', ticker: 'T', side: 'buy_yes' });
    assert.ok(blocksCertifiedNav(incomplete));

    const ledger = buildCashLedger({
      deposits: [{ ts: '2026-08-28', amount_usd: LAB_BASELINE_USD, owner: 'lab' }],
      fills: [incomplete],
    });
    assert.equal(ledger.incomplete_fills.length, 1);
    assert.equal(ledger.acquisition_complete, false);
    assert.equal(ledger.entries.filter((e) => e.type === 'purchase').length, 0);

    const status = publishStatus({
      portfolio_equity_usd: 240,
      portfolio_cash_usd: 240,
      portfolio_positions_usd: 0,
      opening_allocation_verified: true,
      deposits: [{ ts: '2026-08-28', amount_usd: LAB_BASELINE_USD, owner: 'lab' }],
      fills: [{ side: 'buy_yes', ticker: 'T' }],
      positions: [],
    });
    assert.equal(status.publish_blocked, true);
    assert.ok(status.publish_blocked_reasons.includes('incomplete_acquisition'));
    assert.equal(status.equity_usd, null);
  });
});

describe('Chief P1-3 — matchRealizedPnl keyed by ticker', () => {
  it('sell on ticker B does not consume lots from ticker A', () => {
    const fills = [
      normalizeFill({
        fill_id: 'a-buy', ticker: 'MARKET-A', action: 'buy', side: 'yes',
        yes_price: 10, count: 10, ts: '1', strategy_id: 'WX',
      }),
      normalizeFill({
        fill_id: 'b-sell', ticker: 'MARKET-B', action: 'sell', side: 'yes',
        yes_price: 90, count: 10, ts: '2', strategy_id: 'WX',
      }),
    ];
    const matched = matchRealizedPnl(fills);
    const sell = matched.find((f) => f.fill_id === 'b-sell');
    assert.ok(sell);
    assert.equal(sell.pnl_kind, 'unmatched');
    assert.equal(sell.pnl_usd, null);
    assert.notEqual(sell.pnl_usd, 8);
  });
});

describe('Chief P1-4 — publishStatus cash reconcile + no synthetic $200 NAV', () => {
  it('blocks when owner cash sum ≠ exchange cash (no synthetic $200 headline)', () => {
    const status = publishStatus({
      portfolio_equity_usd: 240,
      portfolio_cash_usd: 180,
      portfolio_positions_usd: 60,
      opening_allocation_verified: true,
      deposits: [{ ts: '2026-08-28', amount_usd: LAB_BASELINE_USD, owner: 'lab' }],
      fills: [],
      positions: [],
    });

    const ownerSum = status.lab_cash_usd + status.personal_cash_usd;
    assert.notEqual(ownerSum, 180);
    assert.equal(status.cash_reconcile.reconciled, false);
    assert.equal(status.publish_blocked, true);
    assert.equal(status.equity_usd, null);
    assert.notEqual(status.equity_usd, 200);
    assert.ok(status.publish_blocked_reasons.includes('owner_cash_mismatch'));
  });

  it('authoritative only with verified opening + complete flows + exact reconcile', () => {
    const status = publishStatus({
      portfolio_equity_usd: 240,
      portfolio_cash_usd: LAB_BASELINE_USD + PRE_LAB_PERSONAL_CASH_USD,
      portfolio_positions_usd: 0,
      opening_allocation_verified: true,
      deposits: [{ ts: '2026-08-28', amount_usd: LAB_BASELINE_USD, owner: 'lab' }],
      fills: [],
      positions: [],
    });
    assert.equal(status.authoritative, true);
    assert.equal(status.equity_usd, LAB_BASELINE_USD);
    assert.equal(status.cash_reconcile.reconciled, true);
  });
});

describe('Chief P1-5 — v3 bridge portfolio_equity_usd field', () => {
  it('$225 equity, no personal marks → legacy headline $185 (not −$40)', () => {
    const v3 = computeLabHeadlineV3({
      portfolio_equity_usd: 225,
      nonlab_positions_usd: 0,
      pre_lab_cash_usd: PRE_LAB_PERSONAL_CASH_USD,
    });
    assert.equal(v3.headline_usd, 185);
    assert.notEqual(v3.headline_usd, -40);

    const status = publishStatus({
      portfolio_equity_usd: 225,
      portfolio_cash_usd: 225,
      portfolio_positions_usd: 0,
      opening_allocation_verified: true,
      deposits: [{ ts: '2026-08-28', amount_usd: LAB_BASELINE_USD, owner: 'lab' }],
      fills: [],
      positions: [],
    });
    assert.equal(status.legacy_headline_v3_usd, 185);
  });
});

describe('Chief P1-6 — entry fees allocated into realized PnL', () => {
  it('buy@50¢ +10¢ fee, sell@60¢ no exit fee → net $0 (not +$0.10)', () => {
    const fills = [
      normalizeFill({
        fill_id: 'fee-buy', ticker: 'T', action: 'buy', side: 'yes',
        yes_price: 50, count: 1, fee_cost: 0.10, ts: '1', strategy_id: 'WX',
      }),
      normalizeFill({
        fill_id: 'fee-sell', ticker: 'T', action: 'sell', side: 'yes',
        yes_price: 60, count: 1, ts: '2', strategy_id: 'WX',
      }),
    ];
    const matched = matchRealizedPnl(fills);
    const sell = matched.find((f) => f.fill_id === 'fee-sell');
    assert.ok(sell);
    assert.equal(sell.pnl_usd, 0);
    assert.notEqual(sell.pnl_usd, 0.1);
  });

  it('rebates preserve signed cash (negative fee_cost → positive rebate)', () => {
    const n = normalizeFill({
      fill_id: 'rebate', ticker: 'T', action: 'buy', side: 'yes',
      yes_price: 50, count: 1, fee_cost: -0.05, ts: '1', strategy_id: 'WX',
    });
    assert.equal(n.fee_usd, 0.05);
    assert.equal(n.cash_delta_usd, -0.45);
  });
});
