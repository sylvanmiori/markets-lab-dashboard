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
import { normalizeFill, blocksCertifiedNav } from './fill_normalize.js';

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
 * Returns entries plus acquisition completeness diagnostics.
 * @param {Object} input
 * @param {ReturnType<typeof normalizeFill>[]} [input.fills]
 * @param {Array<Record<string, unknown>>} [input.deposits]
 * @param {Array<Record<string, unknown>>} [input.settlements]
 * @param {Array<Record<string, unknown>>} [input.transfers]
 * @param {string[]} [input.allowlist]
 */
export function buildCashLedger(input) {
  const entries = /** @type {LedgerEntry[]} */ ([]);
  const incompleteFills = /** @type {string[]} */ ([]);
  const skippedFills = /** @type {string[]} */ ([]);
  // Open (unsettled) position tickers: fees_paid accrued on position are NOT yet in
  // balance_dollars. Defer until settlement (Gate3 cash identity).
  const openTickers = new Set(
    (input.positions ?? [])
      .filter((pos) => Number(pos.qty ?? pos.position_fp ?? pos.position ?? 0) !== 0)
      .map((pos) => String(pos.ticker ?? pos.market_ticker ?? ''))
      .filter(Boolean)
  );

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

    if (blocksCertifiedNav(f)) {
      incompleteFills.push(String(f.fill_id ?? 'unknown'));
      continue;
    }

    if (owner === 'unknown') {
      incompleteFills.push(String(f.fill_id ?? 'unknown'));
      skippedFills.push(String(f.fill_id ?? 'unknown'));
      continue;
    }

    let cash = f.cash_delta_usd;
    if (cash == null) {
      incompleteFills.push(String(f.fill_id ?? 'unknown'));
      continue;
    }

    // Strip fee from cash_delta for still-open tickers (fee not in balance_dollars yet).
    let note = null;
    const ticker = String(f.ticker ?? '');
    if (openTickers.has(ticker) && f.fee_usd != null && Number(f.fee_usd) !== 0) {
      cash = Number(cash) - Number(f.fee_usd);
      note = `open_fee_deferred:${Number(f.fee_usd)}`;
    }

    const [action] = String(f.side).split('_');
    entries.push({
      ts: String(f.ts ?? ''),
      type: action === 'buy' ? 'purchase' : 'sale',
      owner,
      amount_usd: cash,
      ticker: f.ticker,
      strategy_id: f.strategy_id ?? undefined,
      fill_id: f.fill_id,
      note,
    });
  }

  for (const s of input.settlements ?? []) {
    const owner = attributeOwner(s, { allowlist: input.allowlist });
    if (owner === 'unknown') continue;
    // Prefer amount_usd (writer sets gross winning-side × $1). fee_cost on settlements
    // echoes fill trading fees already in cash_delta — do not net again.
    const gross = Number(s.revenue_usd ?? s.payout_usd ?? 0);
    const net = s.amount_usd != null && s.amount_usd !== ''
      ? Number(s.amount_usd)
      : gross;
    entries.push({
      ts: String(s.ts ?? s.settled_time ?? ''),
      type: 'settlement',
      owner,
      amount_usd: net,
      ticker: s.ticker ?? s.market_ticker,
      note: `result=${s.market_result ?? s.result ?? '?'}`,
    });
  }

  entries.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return {
    entries,
    incomplete_fills: incompleteFills,
    skipped_fills: skippedFills,
    acquisition_complete: incompleteFills.length === 0,
  };
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
  let unknown = 0;
  const labLegs = [];
  const personalLegs = [];
  const unknownLegs = [];
  for (const p of positions) {
    const owner = p.owner ?? attributeOwner(p, ctx);
    const leg = { ticker: p.ticker, qty: p.qty, mtm_usd: p.mtm_usd, owner };
    if (owner === 'lab') {
      lab += p.mtm_usd;
      labLegs.push(leg);
    } else if (owner === 'personal') {
      personal += p.mtm_usd;
      personalLegs.push(leg);
    } else {
      unknown += p.mtm_usd;
      unknownLegs.push(leg);
    }
  }
  return {
    lab_positions_usd: lab,
    personal_positions_usd: personal,
    unknown_positions_usd: unknown,
    lab_legs: labLegs,
    personal_legs: personalLegs,
    unknown_legs: unknownLegs,
    has_unknown_ownership: unknownLegs.length > 0,
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
 * Reconcile owner cash ledgers against exchange-reported cash.
 * @param {{ lab_cash_usd: number, personal_cash_usd: number }} balances
 * @param {number|null|undefined} exchangeCashUsd
 * @param {{ tolerance_usd?: number }} [opts]
 */
/**
 * Reconcile owner position marks against exchange-reported position value.
 * Unknown ownership or missing positions block certified publication.
 * @param {ReturnType<typeof splitPositionMarks>} positionSplit
 * @param {number|null|undefined} exchangePositionsUsd
 * @param {{ tolerance_usd?: number }} [opts]
 */
export function reconcilePositions(positionSplit, exchangePositionsUsd, opts = {}) {
  const tolerance = opts.tolerance_usd ?? 0.01;
  const ownerSum = Math.round(
    (positionSplit.lab_positions_usd +
      positionSplit.personal_positions_usd +
      (positionSplit.unknown_positions_usd ?? 0)) *
      10000
  ) / 10000;
  const exchange = exchangePositionsUsd != null ? Number(exchangePositionsUsd) : null;
  const gap = exchange != null ? Math.round((ownerSum - exchange) * 10000) / 10000 : null;
  const hasUnknown = positionSplit.has_unknown_ownership === true;
  const missingPositions =
    exchange != null && exchange > tolerance && ownerSum < exchange - tolerance;
  const reconciled =
    exchange != null &&
    gap != null &&
    Math.abs(gap) <= tolerance &&
    !hasUnknown &&
    !missingPositions;

  return {
    owner_positions_sum_usd: ownerSum,
    exchange_positions_usd: exchange,
    positions_gap_usd: gap,
    has_unknown_ownership: hasUnknown,
    missing_positions: missingPositions || (exchange != null && gap != null && Math.abs(gap) > tolerance),
    reconciled,
  };
}

export function reconcileOwnerCash(balances, exchangeCashUsd, opts = {}) {
  const tolerance = opts.tolerance_usd ?? 0.01;
  const ownerSum = balances.lab_cash_usd + balances.personal_cash_usd;
  const exchange = exchangeCashUsd != null ? Number(exchangeCashUsd) : null;
  const gap = exchange != null ? Math.round((ownerSum - exchange) * 10000) / 10000 : null;
  return {
    owner_cash_sum_usd: Math.round(ownerSum * 10000) / 10000,
    exchange_cash_usd: exchange,
    cash_gap_usd: gap,
    reconciled: exchange != null && gap != null && Math.abs(gap) <= tolerance,
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
