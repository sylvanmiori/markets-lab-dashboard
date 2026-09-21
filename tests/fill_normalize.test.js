import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  normalizeFill,
  normalizeRestingOrder,
  matchRealizedPnl,
  cashDeltaUsd,
  inventoryDelta,
  blocksCertifiedNav,
} from '../lib/fill_normalize.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const sep15 = JSON.parse(readFileSync(join(__dir, 'fixtures/sep15_scalp_raw.json'), 'utf8'));
const sep21 = JSON.parse(readFileSync(join(__dir, 'fixtures/sep21_resting.json'), 'utf8'));

describe('fill normalization — acceptance matrix', () => {
  const cases = [
    { action: 'buy', side: 'yes', price: 50, qty: 10, cash: -5, inv: { yes: 10, no: 0 } },
    { action: 'sell', side: 'yes', price: 60, qty: 10, cash: 6, inv: { yes: -10, no: 0 } },
    { action: 'buy', side: 'no', price: 40, qty: 5, cash: -2, inv: { yes: 0, no: 5 } },
    { action: 'sell', side: 'no', price: 55, qty: 5, cash: 2.75, inv: { yes: 0, no: -5 } },
  ];

  for (const c of cases) {
    it(`${c.action} ${c.side}`, () => {
      const raw = {
        fill_id: `t-${c.action}-${c.side}`,
        ticker: 'TEST',
        action: c.action,
        side: c.side,
        yes_price: c.side === 'yes' ? c.price : undefined,
        no_price: c.side === 'no' ? c.price : undefined,
        count: c.qty,
      };
      const n = normalizeFill(raw);
      assert.equal(n.side, `${c.action}_${c.side}`);
      assert.equal(n.price_cents, c.price);
      assert.equal(n.cash_delta_usd, c.cash);
      assert.deepEqual(
        { yes: n.inventory_delta_yes, no: n.inventory_delta_no },
        c.inv
      );
    });
  }

  it('partial fills accumulate inventory', () => {
    const a = normalizeFill({ action: 'buy', side: 'yes', yes_price: 30, count: 3.5, fill_id: 'p1', ticker: 'T' });
    const b = normalizeFill({ action: 'buy', side: 'yes', yes_price: 32, count: 1.5, fill_id: 'p2', ticker: 'T' });
    assert.equal(a.inventory_delta_yes, 3.5);
    assert.equal(b.inventory_delta_yes, 1.5);
  });

  it('fractional counts', () => {
    const n = normalizeFill({ action: 'sell', side: 'no', no_price: 63, count: 4.89, fill_id: 'f', ticker: 'T' });
    assert.equal(n.qty, 4.89);
    assert.equal(n.inventory_delta_no, -4.89);
  });

  it('fees reduce cash delta', () => {
    const n = normalizeFill({
      action: 'buy', side: 'yes', yes_price: 10, count: 1, fee_cost: 0.02, fill_id: 'fee', ticker: 'T',
    });
    assert.equal(n.fee_usd, -0.02);
    assert.ok(Math.abs(n.cash_delta_usd - (-0.12)) < 1e-9);
  });

  it('missing fields → unknown, never fabricated 0', () => {
    const n = normalizeFill({ ticker: 'T', side: 'buy_yes' });
    assert.equal(n.price_cents, null);
    assert.equal(n.cash_delta_usd, null);
    assert.equal(n.confidence, 'unknown');
  });

  it('settlement cash inflow', () => {
    const n = normalizeFill({
      action: 'sell', side: 'yes', yes_price: 100, count: 10, fill_id: 'settle', ticker: 'T',
    });
    assert.equal(n.cash_delta_usd, 10);
    assert.equal(n.inventory_delta_yes, -10);
  });
});

describe('SEP15 scalp — +$1 not −$1', () => {
  it('raw exchange buy YES@6 / sell YES@11 → +$1 realized', () => {
    const fills = sep15.fills.map(normalizeFill);
    const matched = matchRealizedPnl(fills);
    const sell = matched.find((f) => f.side === 'sell_yes');
    assert.ok(sell);
    assert.equal(sell.pnl_usd, 1);
    assert.equal(sell.pnl_kind, 'realized');
    assert.equal(sell.pnl_status, 'win');
  });

  it('wrong published complement rows stay unresolved by default (Chief P1-1)', () => {
    const unresolved = sep15.published_wrong.map((p) => normalizeFill(p));
    for (const n of unresolved) {
      assert.ok(['unverified', 'unknown'].includes(n.confidence));
      assert.notEqual(n.confidence, 'inferred_complement');
    }
  });

  it('wrong published complement rows corrected only when explicitly opted in', () => {
    const corrected = sep15.published_wrong.map((p) =>
      normalizeFill(p, { prefer_complement_correction: true })
    );
    const matched = matchRealizedPnl(corrected);
    const sell = matched.find((f) => f.side === 'sell_yes');
    assert.ok(sell);
    assert.equal(sell.pnl_usd, 1);
    assert.notEqual(sell.pnl_usd, -1);
  });

  it('preserves raw fields on output', () => {
    const n = normalizeFill(sep15.fills[0]);
    assert.ok(n.raw);
    assert.equal(n.raw.yes_price, 6);
    assert.equal(n.strategy_id, 'WX_CHI_D1_NBM_BIASCORR_v0');
  });
});

describe('Gate-3 SEP21 complement poison — buy_yes@6 not buy_no@94', () => {
  const sep21ExchangeFill = {
    fill_id: '01a0bf20',
    ticker: 'KXHIGHCHI-26SEP21-B67.5',
    action: 'buy',
    side: 'yes',
    outcome_side: 'yes',
    yes_price_dollars: '0.0600',
    no_price_dollars: '0.9400',
    count_fp: '20',
    ts: '2026-09-20T23:33:21Z',
  };

  it('raw exchange fill → buy_yes@6 cash −$1.20', () => {
    const n = normalizeFill(sep21ExchangeFill);
    assert.equal(n.side, 'buy_yes');
    assert.equal(n.price_cents, 6);
    assert.ok(Math.abs(n.cash_delta_usd - (-1.20)) < 1e-9);
    assert.equal(n.confidence, 'verified');
    assert.equal(n.inventory_delta_yes, 20);
  });

  it('poisoned published buy_no@94 recovers when outcome_side=yes present', () => {
    const poisoned = {
      side: 'buy_no',
      price_cents: 94,
      qty: 20,
      ticker: 'KXHIGHCHI-26SEP21-B67.5',
      action: 'buy',
      outcome_side: 'yes',
      yes_price_dollars: '0.0600',
      no_price_dollars: '0.9400',
      fill_id: 'poisoned-1',
      ts: '2026-09-20T23:33:21Z',
    };
    const n = normalizeFill(poisoned);
    assert.equal(n.side, 'buy_yes');
    assert.equal(n.price_cents, 6);
    assert.ok(Math.abs(n.cash_delta_usd - (-1.20)) < 1e-9);
    assert.equal(n.confidence, 'verified');
    assert.ok(!blocksCertifiedNav(n));
  });

  it('poisoned row without outcome_side stays fail-closed', () => {
    const poisoned = {
      side: 'buy_no',
      price_cents: 94,
      qty: 20,
      ticker: 'KXHIGHCHI-26SEP21-B67.5',
      fill_id: 'poisoned-2',
      ts: '2026-09-20T23:33:21Z',
    };
    const n = normalizeFill(poisoned);
    assert.equal(n.side, 'buy_no');
    assert.equal(n.price_cents, 94);
    assert.equal(n.confidence, 'unverified');
    assert.ok(blocksCertifiedNav(n));
  });

  it('genuine buy_no@74 unchanged', () => {
    const n = normalizeFill({
      action: 'buy',
      side: 'no',
      outcome_side: 'no',
      no_price_dollars: '0.74',
      yes_price_dollars: '0.26',
      count_fp: '6',
      fill_id: 'genuine-no',
      ticker: 'KXHIGHCHI-26SEP20-B73.5',
      ts: '2026-09-20T12:00:00Z',
    });
    assert.equal(n.side, 'buy_no');
    assert.equal(n.price_cents, 74);
    assert.ok(Math.abs(n.cash_delta_usd - (-4.44)) < 1e-9);
  });

  it('sell_yes OK with complement echo', () => {
    const n = normalizeFill({
      action: 'sell',
      side: 'yes',
      outcome_side: 'yes',
      yes_price_dollars: '0.11',
      no_price_dollars: '0.89',
      count_fp: '20',
      fill_id: 'sell-yes',
      ticker: 'KXHIGHCHI-26SEP15-B86.5',
      ts: '2025-09-15T11:00:00Z',
    });
    assert.equal(n.side, 'sell_yes');
    assert.equal(n.price_cents, 11);
    assert.ok(Math.abs(n.cash_delta_usd - 2.20) < 1e-9);
  });
});

describe('SEP21 resting order — $1.20 risk not $18.80', () => {
  it('risk-matched complement resolves buy_yes@6', () => {
    const n = normalizeRestingOrder(sep21.published);
    assert.equal(n.side, 'buy_yes');
    assert.equal(n.price_cents, 6);
    assert.equal(n.risk_usd, 1.2);
  });

  it('raw exchange order unchanged', () => {
    const n = normalizeRestingOrder(sep21.raw_exchange);
    assert.equal(n.side, 'buy_yes');
    assert.equal(n.price_cents, 6);
    assert.equal(n.risk_usd, 1.2);
  });
});

describe('close-to-flat and oversell', () => {
  it('close-to-flat realizes small P&L', () => {
    const fills = [
      normalizeFill({ action: 'buy', side: 'yes', yes_price: 40, count: 5, fill_id: '1', ticker: 'T', ts: '1' }),
      normalizeFill({ action: 'sell', side: 'yes', yes_price: 42, count: 5, fill_id: '2', ticker: 'T', ts: '2' }),
    ];
    const m = matchRealizedPnl(fills);
    assert.equal(m[1].pnl_usd, 0.1);
  });

  it('overselling unmatched portion', () => {
    const fills = [
      normalizeFill({ action: 'buy', side: 'yes', yes_price: 50, count: 5, fill_id: '1', ticker: 'T', ts: '1' }),
      normalizeFill({ action: 'sell', side: 'yes', yes_price: 60, count: 8, fill_id: '2', ticker: 'T', ts: '2' }),
    ];
    const m = matchRealizedPnl(fills);
    assert.equal(m[1].pnl_kind, 'unmatched');
  });
});
