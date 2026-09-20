#!/usr/bin/env node
/**
 * Chief joint re-review probes — D1–D4 counterexample harness.
 * Run: node joint_rereview_probes.mjs
 */
import {
  normalizeFill,
  blocksCertifiedNav,
  normalizeRestingOrder,
} from './lib/fill_normalize.js';
import { publishStatus } from './lib/publisher.js';
import { LAB_BASELINE_USD, PRE_LAB_PERSONAL_CASH_USD } from './lib/constants.js';

const OPENING = {
  opening_allocation_verified: true,
  deposits: [{ ts: '2026-08-28', amount_usd: LAB_BASELINE_USD, owner: 'lab' }],
};

function row(id, pass, detail) {
  return { id, pass, detail };
}

const results = [];

// D1 — cash equality alone must NOT certify NAV
const d1 = publishStatus({
  ...OPENING,
  portfolio_equity_usd: 250,
  portfolio_cash_usd: 240,
  portfolio_positions_usd: 10,
  fills: [],
  positions: [],
});
results.push(row(
  'D1a',
  !d1.authoritative && d1.cash_reconcile.reconciled,
  `cash_reconciled=${d1.cash_reconcile.reconciled} authoritative=${d1.authoritative} reasons=${d1.publish_blocked_reasons.join(',')}`
));

const d1b = publishStatus({
  ...OPENING,
  portfolio_equity_usd: 250,
  portfolio_cash_usd: 240,
  portfolio_positions_usd: 10,
  fills: [],
  positions: [{ ticker: 'RANDOM-UNKNOWN', qty: 10, mtm_usd: 10 }],
});
results.push(row(
  'D1b',
  !d1b.authoritative && d1b.personal_positions_usd === 0,
  `authoritative=${d1b.authoritative} personal_positions=${d1b.personal_positions_usd}`
));

// D2 — inferred_complement always blocks
const inferred = normalizeFill(
  { side: 'buy_no', price_cents: 94, qty: 20, fill_id: 'd2', ticker: 'T' },
  { prefer_complement_correction: true }
);
const reloaded = normalizeFill(JSON.parse(JSON.stringify(inferred)));
const d2 = publishStatus({
  ...OPENING,
  portfolio_equity_usd: 240,
  portfolio_cash_usd: 240,
  portfolio_positions_usd: 0,
  fills: [reloaded],
  positions: [],
});
results.push(row(
  'D2',
  blocksCertifiedNav(reloaded) && !d2.authoritative,
  `blocks=${blocksCertifiedNav(reloaded)} authoritative=${d2.authoritative} confidence=${reloaded.confidence}`
));

// D3 — exact decimal arithmetic
const d3 = normalizeFill({
  action: 'buy', side: 'no', count_fp: '6', no_price_dollars: '0.7450', fill_id: 'd3', ticker: 'T',
});
results.push(row(
  'D3',
  d3.cash_delta_usd === -4.47 && d3.price_cents === 74.5,
  `cash=${d3.cash_delta_usd} price_cents=${d3.price_cents}`
));

// D4 — resting risk uses remaining_count_fp
const d4 = normalizeRestingOrder({
  side: 'buy_yes', price_cents: 6, count_fp: '20', remaining_count_fp: '5', order_id: 'd4', ticker: 'T',
});
results.push(row(
  'D4',
  d4.qty === 5 && d4.risk_usd === 0.3,
  `qty=${d4.qty} risk_usd=${d4.risk_usd}`
));

console.log('Chief joint re-review probes — D1–D4');
console.log('─'.repeat(60));
for (const r of results) {
  console.log(`${r.id}  ${r.pass ? 'PASS' : 'FAIL'}  ${r.detail}`);
}
console.log('─'.repeat(60));
const allPass = results.every((r) => r.pass);
console.log(`Overall: ${allPass ? 'ALL PASS' : 'FAILURES DETECTED'} (${results.filter((r) => r.pass).length}/${results.length})`);
process.exit(allPass ? 0 : 1);
