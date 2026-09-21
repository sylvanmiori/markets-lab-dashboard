import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildCashLedger,
  cashBalances,
  computeLabNavV4,
  computeLabHeadlineV3,
  buildNavBridge,
  diagnoseV3Contamination,
  splitPositionMarks,
} from '../lib/lab_ledgers.js';
import { attributeOwner } from '../lib/ownership.js';
import { normalizeFill } from '../lib/fill_normalize.js';
import { LAB_BASELINE_USD } from '../lib/constants.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const before = JSON.parse(readFileSync(join(__dir, 'fixtures/status_2026-09-20T150410Z.json'), 'utf8'));
const after = JSON.parse(readFileSync(join(__dir, 'fixtures/status_2026-09-20T150745Z.json'), 'utf8'));

describe('ownership attribution', () => {
  it('strategy_id → lab', () => {
    assert.equal(attributeOwner({ ticker: 'KXHIGHCHI-26SEP15-B86.5', strategy_id: 'WX_CHI' }), 'lab');
  });

  it('NFL ticker → personal even if allowlisted prefix absent', () => {
    assert.equal(attributeOwner({ ticker: 'KXNFLGAME-26SEP20CINHOU-HOU' }), 'personal');
  });

  it('allowlist alone insufficient for ambiguous ticker', () => {
    assert.equal(attributeOwner({ ticker: 'KXHIGHCHI-26SEP20-B73.5' }), 'lab');
    assert.equal(attributeOwner({ ticker: 'RANDOM-XYZ' }), 'unknown');
  });

  it('explicit owner wins', () => {
    assert.equal(attributeOwner({ ticker: 'KXHIGHCHI-X', owner: 'personal' }), 'personal');
  });
});

describe('lab vs personal cash ledgers', () => {
  it('personal NFL purchase does not debit lab cash', () => {
    const nflBuy = normalizeFill({
      fill_id: 'nfl-1',
      ticker: 'KXNFLGAME-26SEP20CINHOU-HOU',
      action: 'buy',
      side: 'yes',
      yes_price: 60,
      count: 16.47,
      created_time: '2026-09-20T15:05:00Z',
    });
    const ledger = buildCashLedger({ fills: [nflBuy] });
    const labEntries = ledger.entries.filter((e) => e.owner === 'lab');
    const personalEntries = ledger.entries.filter((e) => e.owner === 'personal');
    assert.equal(labEntries.length, 0);
    assert.equal(personalEntries.length, 1);
    assert.ok(personalEntries[0].amount_usd < 0);
  });

  it('lab weather fill debits lab only', () => {
    const wx = normalizeFill({
      fill_id: 'wx-1',
      ticker: 'KXHIGHCHI-26SEP15-B86.5',
      action: 'buy',
      side: 'yes',
      yes_price: 6,
      count: 20,
      strategy_id: 'WX_CHI_D1',
      created_time: '2025-09-15T10:55:00Z',
    });
    const ledger = buildCashLedger({ fills: [wx] });
    assert.equal(ledger.entries[0].owner, 'lab');
  });
});

describe('NFL contamination regression — 10:04 vs 10:07 CT', () => {
  it('diagnoses ~$9.91 headline drop as attribution contamination', () => {
    const d = diagnoseV3Contamination(before, after);
    assert.ok(d.is_contamination);
    assert.ok(Math.abs(d.headline_drop_usd - 9.9112) < 0.1);
    assert.ok(Math.abs(d.account_equity_drop_usd - 0.2762) < 0.2);
    assert.ok(Math.abs(d.new_personal_mark_usd - 9.6349) < 0.1);
    assert.ok(d.new_personal_tickers.includes('KXNFLGAME-26SEP20CINHOU-HOU'));
  });

  it('v4 NAV stable across personal NFL purchase when ledger correct', () => {
    const labPos = (before.portfolio_positions_usd ?? 0) - 0; // all weather in lab marks
    const personalBefore = (before.nonlab_legs ?? []).map((p) => ({ ...p, owner: 'personal' }));
    const personalAfter = (after.nonlab_legs ?? []).map((p) => ({ ...p, owner: 'personal' }));

    const nflBuyCost = 9.9962; // cash drop from account
    const ledgerBefore = buildCashLedger({
      deposits: [{ ts: '2026-08-28', amount_usd: LAB_BASELINE_USD, owner: 'lab' }],
      fills: [],
    });
    const ledgerAfter = buildCashLedger({
      deposits: [{ ts: '2026-08-28', amount_usd: LAB_BASELINE_USD, owner: 'lab' }],
      fills: [
        normalizeFill({
          fill_id: 'nfl-buy',
          ticker: 'KXNFLGAME-26SEP20CINHOU-HOU',
          action: 'buy',
          side: 'yes',
          yes_price: Math.round((nflBuyCost / 16.47) * 100),
          count: 16.47,
          created_time: after.updated_at,
        }),
      ],
    });

    const balBefore = cashBalances(ledgerBefore.entries, { lab_opening_usd: 0, personal_opening_usd: 40 });
    const balAfter = cashBalances(ledgerAfter.entries, { lab_opening_usd: 0, personal_opening_usd: 40 });

    const splitBefore = splitPositionMarks([
      ...personalBefore,
      { ticker: 'KXHIGHCHI-LAB', qty: 1, mtm_usd: labPos, owner: 'lab' },
    ]);
    const splitAfter = splitPositionMarks([
      ...personalAfter,
      { ticker: 'KXHIGHCHI-LAB', qty: 1, mtm_usd: labPos + 0.72, owner: 'lab' },
    ]);

    const navBefore = computeLabNavV4(balBefore, splitBefore);
    const navAfter = computeLabNavV4(balAfter, splitAfter);

    const labNavChange = navAfter.lab_nav_usd - navBefore.lab_nav_usd;
    assert.ok(Math.abs(labNavChange) < 1, `lab NAV should not drop ~$10; got ${labNavChange}`);
    assert.ok(navAfter.personal_cash_usd < navBefore.personal_cash_usd);
  });
});

describe('NAV bridge', () => {
  it('bridges v3 headline to v4 corrected NAV with explicit adjustments', () => {
    const v3 = computeLabHeadlineV3(after);
    const adjustments = [
      { reason: 'personal_nfl_purchase_not_lab_loss', amount_usd: 9.91, ref: 'KXNFLGAME-26SEP20CINHOU-HOU' },
    ];
    const correctedNav = v3.headline_usd + 9.91;
    const bridge = buildNavBridge(v3.headline_usd, correctedNav, adjustments);
    assert.equal(bridge.from_definition, 'lab_curve_v3');
    assert.equal(bridge.to_definition, 'lab_curve_v4');
    assert.equal(bridge.to_corrected_nav_usd, correctedNav);
    assert.ok(Math.abs(bridge.unexplained_residual_usd) < 1e-9);
    assert.ok(bridge.note.includes('superseded'));
  });

  it('preserves $200 baseline semantics', () => {
    const nav = computeLabNavV4(
      { lab_cash_usd: 195, personal_cash_usd: 50 },
      { lab_positions_usd: 10, personal_positions_usd: 20, lab_legs: [], personal_legs: [] }
    );
    assert.equal(nav.delta_vs_baseline_usd, 5);
  });
});
