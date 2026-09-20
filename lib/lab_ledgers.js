/**
 * WP1 — Separate lab vs personal cash-flow ledgers and corrected NAV.
 */
import {
  LAB_BASELINE_USD,
  PRE_LAB_PERSONAL_CASH_USD,
  DEFINITION_V3,
  DEFINITION_V4,
} from './constants.js';
import { attributeOwner } from './ownership.js';
import { normalizeFill, cashDeltaUsd } from './fill_normalize.js';

/**
 * @typedef {Object} LedgerEntry
 * @property {string} ts
 * @property {'deposit'|'withdrawal'|'transfer'|'purchase'|'sale'|'fee'|'settlement'|'mark'} type
 * @property {'lab'|'personal'} owner
 * @property {number} amount_usd
 * @property {string} [ticker]
 * @property {string} [strategy_id]
 * @property {string} [fill_id]
 * @property {string} [note]
 */

/**
 * Build cash ledger entries from normalized fills, deposits, settlements.
 * @param {Object} input
 * @param {ReturnType<typeof normalizeFill>[]} [input.fills]
 * @param {Array<Record<string, unknown>>} [input.deposits]
 * @param {Array<Record<string, unknown>>} [input.settlements]
 * @param {Array<Record<string, unknown>>} [input.transfers]
 * @param {string[]} [input.allowlist]
 */
export function buildCashLedger(input) {
  const entries = /** @type {LedgerEntry[]} */ ([]);

  for (const d of input.deposits ?? []) {
    const owner = d.owner === 'personal' ? 'personal' : 'lab';
    const amt = Number(d.amount_usd ?? d.amount ?? 0);
    entries.push({
      ts: String(d.ts ?? d.created_time ?? ''),
      type: 'deposit',
      owner,
      amount_usd: amt,
      fill_id: d.deposit_id ?? d.id ?? null,
      note: d.note ?? null,
    });
  }

  for (const t of input.transfers ?? []) {
    entries.push({
      ts: String(t.ts ?? ''),
      type: 'transfer',
      owner: t.to_owner === 'personal' ? 'personal' : 'lab',
      amount_usd: Number(t.amount_usd ?? 0),
      note: `from ${t.from_owner ?? 'unknown'}`,
    });
    entries.push({
      ts: String(t.ts ?? ''),
      type: 'transfer',
      owner: t.from_owner === 'personal' ? 'personal' : 'lab',
      amount_usd: -Number(t.amount_usd ?? 0),
      note: `to ${t.to_owner ?? 'unknown'}`,
    });
  }

  for (const raw of input.fills ?? []) {
    const f = typeof raw.confidence === 'string' ? raw : normalizeFill(raw);
    const owner = attributeOwner(f, { allowlist: input.allowlist });
    if (owner === 'unknown') continue;

    const cash = f.cash_delta_usd;
    if (cash == null) continue;

    const [action] = String(f.side).split('_');
    entries.push({
      ts: String(f.ts ?? ''),
      type: action === 'buy' ? 'purchase' : 'sale',
      owner,
      amount_usd: cash,
      ticker: f.ticker,
      strategy_id: f.strategy_id ?? undefined,
      fill_id: f.fill_id,
    });
  }

  for (const s of input.settlements ?? []) {
    const owner = attributeOwner(s, { allowlist: input.allowlist });
    if (owner === 'unknown') continue;
    entries.push({
      ts: String(s.ts ?? s.settled_time ?? ''),
      type: 'settlement',
      owner,
      amount_usd: Number(s.revenue_usd ?? s.payout_usd ?? s.amount_usd ?? 0),
      ticker: s.ticker ?? s.market_ticker,
      note: `result=${s.market_result ?? s.result ?? '?'}`,
    });
  }

  entries.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return entries;
}

/**
 * Sum cash balance per owner from ledger entries + opening balances.
 * @param {LedgerEntry[]} entries
 * @param {{ lab_opening_usd?: number, personal_opening_usd?: number }} openings
 */
export function cashBalances(entries, openings = {}) {
  const labOpening = openings.lab_opening_usd ?? LAB_BASELINE_USD;
  const personalOpening = openings.personal_opening_usd ?? PRE_LAB_PERSONAL_CASH_USD;
  let lab = labOpening;
  let personal = personalOpening;
  for (const e of entries) {
    if (e.owner === 'lab') lab += e.amount_usd;
    else if (e.owner === 'personal') personal += e.amount_usd;
  }
  return { lab_cash_usd: lab, personal_cash_usd: personal };
}

/**
 * Position marks split by owner.
 * @param {Array<{ ticker: string, qty: number, mtm_usd: number, owner?: string }>} positions
 * @param {{ allowlist?: string[] }} [ctx]
 */
export function splitPositionMarks(positions, ctx = {}) {
  let lab = 0;
  let personal = 0;
  const labLegs = [];
  const personalLegs = [];
  for (const p of positions) {
    const owner = p.owner ?? attributeOwner(p, ctx);
    const leg = { ticker: p.ticker, qty: p.qty, mtm_usd: p.mtm_usd, owner };
    if (owner === 'lab') {
      lab += p.mtm_usd;
      labLegs.push(leg);
    } else {
      personal += p.mtm_usd;
      personalLegs.push(leg);
    }
  }
  return {
    lab_positions_usd: lab,
    personal_positions_usd: personal,
    lab_legs: labLegs,
    personal_legs: personalLegs,
  };
}

/**
 * Corrected lab NAV (v4): lab cash + lab position marks.
 * Baseline $200 preserved as starting_bankroll_usd / lab_deposit semantics.
 */
export function computeLabNavV4(cashBalances, positionSplit) {
  const nav = cashBalances.lab_cash_usd + positionSplit.lab_positions_usd;
  return {
    definition: DEFINITION_V4,
    lab_nav_usd: Math.round(nav * 10000) / 10000,
    lab_cash_usd: Math.round(cashBalances.lab_cash_usd * 10000) / 10000,
    lab_positions_usd: Math.round(positionSplit.lab_positions_usd * 10000) / 10000,
    personal_nav_usd: Math.round(
      (cashBalances.personal_cash_usd + positionSplit.personal_positions_usd) * 10000
    ) / 10000,
    personal_cash_usd: Math.round(cashBalances.personal_cash_usd * 10000) / 10000,
    personal_positions_usd: Math.round(positionSplit.personal_positions_usd * 10000) / 10000,
    delta_vs_baseline_usd: Math.round((nav - LAB_BASELINE_USD) * 10000) / 10000,
  };
}

/**
 * Legacy lab_curve_v3 headline (for bridge — do not use as truth).
 * lab = portfolio_equity - nonlab_position_marks - pre_lab_cash
 */
export function computeLabHeadlineV3(portfolio) {
  // v3 formula uses full account equity (cash + all marks), not the already-computed lab headline.
  const equity = Number(
    portfolio.portfolio_equity_usd ??
      (Number(portfolio.portfolio_cash_usd ?? 0) + Number(portfolio.portfolio_positions_usd ?? 0)) ??
      0
  );
  const nonlab = Number(portfolio.nonlab_positions_usd ?? 0);
  const preLab = Number(portfolio.pre_lab_cash_usd ?? PRE_LAB_PERSONAL_CASH_USD);
  const headline = equity - nonlab - preLab;
  return {
    definition: DEFINITION_V3,
    headline_usd: Math.round(headline * 10000) / 10000,
    portfolio_equity_usd: equity,
    nonlab_positions_usd: nonlab,
    pre_lab_cash_usd: preLab,
  };
}

/**
 * Bridge from superseded v3 headline to corrected v4 NAV.
 * @param {number} v3Headline
 * @param {number} v4Nav
 * @param {Array<{ reason: string, amount_usd: number, ref?: string }>} adjustments
 */
export function buildNavBridge(v3Headline, v4Nav, adjustments = []) {
  const explained = adjustments.reduce((s, a) => s + a.amount_usd, 0);
  const gap = Math.round((v4Nav - v3Headline - explained) * 10000) / 10000;
  return {
    from_definition: DEFINITION_V3,
    to_definition: DEFINITION_V4,
    from_headline_usd: v3Headline,
    to_corrected_nav_usd: v4Nav,
    adjustments,
    unexplained_residual_usd: gap,
    bridged_at: new Date().toISOString(),
    note:
      'v3 headline superseded — personal cash purchases were charged to lab scoreboard. v4 uses owner cash ledgers.',
  };
}

/**
 * Detect v3 attribution contamination when personal position appears.
 * Regression helper for NFL 10:04→10:07 CT snapshots.
 */
export function diagnoseV3Contamination(before, after) {
  const v3Before = computeLabHeadlineV3(before);
  const v3After = computeLabHeadlineV3(after);
  const headlineDrop = v3Before.headline_usd - v3After.headline_usd;

  const cashBefore = Number(before.portfolio_cash_usd ?? 0);
  const cashAfter = Number(after.portfolio_cash_usd ?? 0);
  const posBefore = Number(before.portfolio_positions_usd ?? 0);
  const posAfter = Number(after.portfolio_positions_usd ?? 0);
  const accountBefore = cashBefore + posBefore;
  const accountAfter = cashAfter + posAfter;
  const accountDrop = accountBefore - accountAfter;

  const newPersonal = (after.nonlab_legs ?? []).filter(
    (p) => !(before.nonlab_legs ?? []).some((b) => b.ticker === p.ticker)
  );
  const newPersonalMark = newPersonal.reduce((s, p) => s + Number(p.mtm_usd ?? 0), 0);

  const attributedToLab = headlineDrop - accountDrop;
  return {
    headline_drop_usd: Math.round(headlineDrop * 10000) / 10000,
    account_equity_drop_usd: Math.round(accountDrop * 10000) / 10000,
    new_personal_mark_usd: Math.round(newPersonalMark * 10000) / 10000,
    contamination_usd: Math.round(attributedToLab * 10000) / 10000,
    is_contamination:
      Math.abs(attributedToLab - newPersonalMark) < 0.5 && headlineDrop > accountDrop + 1,
    new_personal_tickers: newPersonal.map((p) => p.ticker),
  };
}
