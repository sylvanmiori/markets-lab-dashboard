import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeFill,
  blocksCertifiedNav,
  normalizeRestingOrder,
} from '../lib/fill_normalize.js';
import { publishStatus } from '../lib/publisher.js';
import { reconcilePositions, splitPositionMarks } from '../lib/lab_ledgers.js';
import { LAB_BASELINE_USD, PRE_LAB_PERSONAL_CASH_USD } from '../lib/constants.js';

const OPENING = {
  opening_allocation_verified: true,
  deposits: [{ ts: '2026-08-28', amount_usd: LAB_BASELINE_USD, owner: 'lab' }],
};

describe('D1 P1 — cash equality alone must NOT certify NAV', () => {
  it('empty position list with exchange positions $10 blocks authoritative', () => {
    const status = publishStatus({
      ...OPENING,
      portfolio_equity_usd: 250,
      portfolio_cash_usd: LAB_BASELINE_USD + PRE_LAB_PERSONAL_CASH_USD,
      portfolio_positions_usd: 10,
      fills: [],
      positions: [],
    });

    assert.equal(status.cash_reconcile.reconciled, true);
    assert.equal(status.authoritative, false);
    assert.equal(status.publish_blocked, true);
    assert.equal(status.equity_usd, null);
    assert.ok(status.publish_blocked_reasons.includes('position_mismatch'));
  });

  it('empty-ticker position blocks certification (unknown ownership, not personal dump)', () => {
    const status = publishStatus({
      ...OPENING,
      portfolio_equity_usd: 250,
      portfolio_cash_usd: LAB_BASELINE_USD + PRE_LAB_PERSONAL_CASH_USD,
      portfolio_positions_usd: 10,
      fills: [],
      positions: [{ ticker: '', qty: 10, mtm_usd: 10 }],
    });

    assert.equal(status.personal_positions_usd, 0);
    assert.equal(status.authoritative, false);
    assert.ok(status.publish_blocked_reasons.includes('unknown_position_ownership'));
  });

  it('reconcilePositions requires complete owner marks matching exchange', () => {
    const split = splitPositionMarks([
      { ticker: 'KXHIGHCHI-26SEP18-B76.5', qty: 20, mtm_usd: 10, strategy_id: 'WX_CHI' },
    ]);
    const ok = reconcilePositions(split, 10);
    assert.equal(ok.reconciled, true);

    const empty = splitPositionMarks([]);
    const bad = reconcilePositions(empty, 10);
    assert.equal(bad.reconciled, false);
    assert.equal(bad.missing_positions, true);
  });
});

describe('D2 P1 — pre-normalized inferred_complement must ALWAYS block', () => {
  it('opt-in complement → inferred_complement blocks certified NAV', () => {
    const inferred = normalizeFill(
      { side: 'buy_no', price_cents: 94, qty: 20, fill_id: 'd2', ticker: 'T' },
      { prefer_complement_correction: true }
    );
    assert.equal(inferred.confidence, 'inferred_complement');
    assert.equal(blocksCertifiedNav(inferred), true);
  });

  it('normalize → persist/reload → publish blocks even when cash reconciles', () => {
    const inferred = normalizeFill(
      { side: 'buy_no', price_cents: 94, qty: 20, fill_id: 'd2-persist', ticker: 'T' },
      { prefer_complement_correction: true }
    );
    const persisted = JSON.parse(JSON.stringify(inferred));
    const reloaded = normalizeFill(persisted);

    assert.equal(reloaded.confidence, 'inferred_complement');
    assert.equal(blocksCertifiedNav(reloaded), true);

    const status = publishStatus({
      ...OPENING,
      portfolio_equity_usd: LAB_BASELINE_USD + PRE_LAB_PERSONAL_CASH_USD,
      portfolio_cash_usd: LAB_BASELINE_USD + PRE_LAB_PERSONAL_CASH_USD,
      portfolio_positions_usd: 0,
      fills: [reloaded],
      positions: [],
    });

    assert.equal(status.authoritative, false);
    assert.equal(status.unresolved_fill_count, 1);
    assert.ok(status.publish_blocked_reasons.includes('incomplete_acquisition'));
  });

  it('unverified and unknown confidence also block certified publication', () => {
    const unverified = normalizeFill({ side: 'buy_no', price_cents: 94, qty: 20, fill_id: 'u', ticker: 'T' });
    assert.equal(blocksCertifiedNav(unverified), true);

    const unknown = normalizeFill({ side: 'buy_yes', ticker: 'T' });
    assert.equal(blocksCertifiedNav(unknown), true);
  });
});

describe('D3 P1 — exact decimal arithmetic (no mid-ledger rounding)', () => {
  it('six NO @ no_price_dollars=0.7450 → cash outflow exactly $4.47', () => {
    const n = normalizeFill({
      fill_id: 'd3-fp',
      ticker: 'KXHIGHCHI-26SEP20-B73.5',
      action: 'buy',
      side: 'no',
      count_fp: '6',
      no_price_dollars: '0.7450',
      ts: '2026-09-20T12:00:00Z',
    });

    assert.equal(n.price_cents, 74.5);
    assert.equal(n.cash_delta_usd, -4.47);
    assert.notEqual(n.cash_delta_usd, -4.5);
  });
});

describe('D4 P2 — resting risk uses remaining_count_fp', () => {
  it('remaining_count_fp=5 on count_fp=20 @ 6¢ → risk $0.30 not $1.20', () => {
    const n = normalizeRestingOrder({
      side: 'buy_yes',
      price_cents: 6,
      count_fp: '20',
      remaining_count_fp: '5',
      order_id: 'd4-fp',
      ticker: 'T',
    });

    assert.equal(n.qty, 5);
    assert.equal(n.risk_usd, 0.3);
    assert.notEqual(n.risk_usd, 1.2);
  });

  it('legacy remaining_count preferred over count_fp', () => {
    const n = normalizeRestingOrder({
      side: 'buy_yes',
      price_cents: 6,
      count_fp: '20',
      remaining_count: 3,
      order_id: 'd4-legacy',
      ticker: 'T',
    });

    assert.equal(n.qty, 3);
    assert.equal(n.risk_usd, 0.18);
  });
});
