/**
 * Dashboard publisher — combines WP1 ledgers + WP2 normalization into status fields.
 */
import { LAB_BASELINE_USD, PRE_LAB_PERSONAL_CASH_USD, DEFINITION_V4 } from './constants.js';
import {
  normalizeFill,
  normalizeRestingOrder,
  matchRealizedPnl,
  toPublishedFill,
  blocksCertifiedNav,
} from './fill_normalize.js';
import {
  buildCashLedger,
  cashBalances,
  splitPositionMarks,
  computeLabNavV4,
  computeLabHeadlineV3,
  buildNavBridge,
  reconcileOwnerCash,
  reconcilePositions,
} from './lab_ledgers.js';
import { attributeOwner } from './ownership.js';

const CASH_RECONCILE_TOLERANCE_USD = 0.01;

/**
 * @param {Object} snapshot Exchange + portfolio snapshot from box recorder
 */
export function publishStatus(snapshot) {
  const allowlist = snapshot.allowlist ?? undefined;
  const rawFills = snapshot.fills ?? snapshot.recent_fills_raw ?? [];
  const normalized = rawFills.map((f) =>
    normalizeFill(f.raw ? f : { ...f }, { prefer_complement_correction: false })
  );

  const positions = (snapshot.positions ?? []).map((p) => ({
    ...p,
    owner: p.owner ?? attributeOwner(p, { allowlist }),
  }));

  const openingVerified = snapshot.opening_allocation_verified === true;
  const explicitDeposits = snapshot.deposits;
  const hasVerifiedOpening = openingVerified || (
    Array.isArray(explicitDeposits) &&
    explicitDeposits.some((d) => d.owner === 'lab' && Number(d.amount_usd ?? d.amount) === LAB_BASELINE_USD)
  );

  const ledgerResult = buildCashLedger({
    fills: normalized,
    deposits: hasVerifiedOpening
      ? (explicitDeposits ?? [
          {
            ts: snapshot.lab_deposit_ct ?? snapshot.lab_start_ts,
            amount_usd: LAB_BASELINE_USD,
            owner: 'lab',
            deposit_id: snapshot.lab_deposit_id,
            verified: true,
          },
        ])
      : (explicitDeposits ?? []),
    settlements: snapshot.settlements ?? [],
    transfers: snapshot.transfers ?? [],
    allowlist,
  });

  const balances = cashBalances(ledgerResult.entries, {
    lab_opening_usd: hasVerifiedOpening ? 0 : 0,
    personal_opening_usd: PRE_LAB_PERSONAL_CASH_USD,
  });

  const posSplit = splitPositionMarks(positions, { allowlist });
  const nav = computeLabNavV4(balances, posSplit);

  const v3 = computeLabHeadlineV3({
    portfolio_equity_usd: snapshot.portfolio_equity_usd,
    portfolio_cash_usd: snapshot.portfolio_cash_usd,
    portfolio_positions_usd: snapshot.portfolio_positions_usd,
    nonlab_positions_usd: posSplit.personal_positions_usd,
    pre_lab_cash_usd: PRE_LAB_PERSONAL_CASH_USD,
  });

  const cashReconcile = reconcileOwnerCash(balances, snapshot.portfolio_cash_usd, {
    tolerance_usd: CASH_RECONCILE_TOLERANCE_USD,
  });

  const positionReconcile = reconcilePositions(posSplit, snapshot.portfolio_positions_usd, {
    tolerance_usd: CASH_RECONCILE_TOLERANCE_USD,
  });

  const unresolvedFills = normalized.filter(blocksCertifiedNav);
  const acquisitionComplete = ledgerResult.acquisition_complete && unresolvedFills.length === 0;
  const authoritative =
    hasVerifiedOpening &&
    acquisitionComplete &&
    cashReconcile.reconciled &&
    positionReconcile.reconciled &&
    snapshot.portfolio_cash_usd != null &&
    snapshot.portfolio_positions_usd != null;

  const publishBlockedReasons = [];
  if (!hasVerifiedOpening) publishBlockedReasons.push('opening_allocation_unverified');
  if (!acquisitionComplete) publishBlockedReasons.push('incomplete_acquisition');
  if (!cashReconcile.reconciled) publishBlockedReasons.push('owner_cash_mismatch');
  if (snapshot.portfolio_cash_usd == null) publishBlockedReasons.push('exchange_cash_missing');
  if (snapshot.portfolio_positions_usd == null) publishBlockedReasons.push('exchange_positions_missing');
  if (positionReconcile.has_unknown_ownership) {
    publishBlockedReasons.push('unknown_position_ownership');
  }
  if (!positionReconcile.reconciled) publishBlockedReasons.push('position_mismatch');

  const contaminationAdj = snapshot.nav_bridge_adjustments ?? [];
  const bridge = buildNavBridge(v3.headline_usd, nav.lab_nav_usd, contaminationAdj);

  const fillsWithPnl = matchRealizedPnl(normalized);
  const recentFills = fillsWithPnl
    .slice(-30)
    .reverse()
    .map((f) => toPublishedFill(normalized.find((n) => n.fill_id === f.fill_id) ?? f, {
      pnl_usd: f.pnl_usd,
      pnl_status: f.pnl_status,
      pnl_label: f.pnl_label,
      pnl_kind: f.pnl_kind,
    }));

  const resting = (snapshot.resting_orders ?? []).map(normalizeRestingOrder);

  // Resting risk + |lab MTM| is a diagnostic heuristic only — not exchange recon worst-case.
  const openUsdV4Estimate = resting.reduce((s, o) => s + (o.risk_usd ?? 0), 0)
    + posSplit.lab_legs.reduce((s, p) => s + Math.abs(p.mtm_usd), 0);

  // Authoritative open exposure is owned by Python recon (total_open_worst_case_usd).
  const reconOpenRaw = snapshot.recon_open_usd ?? snapshot.total_open_worst_case_usd ?? null;
  const openUsd =
    reconOpenRaw != null && Number.isFinite(Number(reconOpenRaw))
      ? Math.round(Number(reconOpenRaw) * 100) / 100
      : null;

  const headlineNav = authoritative ? nav.lab_nav_usd : null;

  return {
    authoritative,
    publish_blocked: !authoritative,
    publish_blocked_reasons: publishBlockedReasons,
    equity_usd: headlineNav,
    lab_equity_usd: headlineNav,
    equity_definition: authoritative ? DEFINITION_V4 : null,
    equity_formula: authoritative
      ? 'lab_curve_v4: lab NAV = lab cash ledger + lab position marks; baseline $200 lab allocation preserved'
      : null,
    legacy_headline_v3_usd: v3.headline_usd,
    nav_bridge: bridge,
    lab_cash_usd: nav.lab_cash_usd,
    personal_cash_usd: nav.personal_cash_usd,
    personal_nav_usd: nav.personal_nav_usd,
    lab_positions_usd: nav.lab_positions_usd,
    personal_positions_usd: nav.personal_positions_usd,
    personal_legs: posSplit.personal_legs,
    nonlab_legs: posSplit.personal_legs,
    nonlab_positions_usd: posSplit.personal_positions_usd,
    portfolio_equity_usd: snapshot.portfolio_equity_usd,
    portfolio_cash_usd: snapshot.portfolio_cash_usd,
    portfolio_positions_usd: snapshot.portfolio_positions_usd,
    cash_reconcile: cashReconcile,
    position_reconcile: positionReconcile,
    opening_allocation_verified: hasVerifiedOpening,
    acquisition_complete: acquisitionComplete,
    incomplete_fill_ids: ledgerResult.incomplete_fills,
    unresolved_fill_count: unresolvedFills.length,
    starting_bankroll_usd: LAB_BASELINE_USD,
    lab_deposit_usd: hasVerifiedOpening ? LAB_BASELINE_USD : null,
    pre_lab_cash_usd: PRE_LAB_PERSONAL_CASH_USD,
    delta_vs_start_usd: authoritative ? nav.delta_vs_baseline_usd : null,
    cash_ledger_entries: ledgerResult.entries.length,
    recent_fills: recentFills,
    resting_orders: resting.map((o) => ({
      ticker: o.ticker,
      side: o.side,
      price_cents: o.price_cents,
      qty: o.qty,
      risk_usd: o.risk_usd,
      order_id_short: String(o.order_id).slice(0, 18),
      normalization_source: o.normalization_source,
    })),
    open_usd: openUsd,
    open_usd_v4_estimate: Math.round(openUsdV4Estimate * 100) / 100,
    allowlist: snapshot.allowlist,
  };
}

/**
 * Append equity history point — never rewrite prior points.
 * @param {Array<Record<string, unknown>>} history
 * @param {number} navUsd
 * @param {string} ts
 */
export function appendEquityPoint(history, navUsd, ts, extra = {}) {
  const point = {
    t: ts,
    equity_usd: navUsd,
    source: DEFINITION_V4,
    definition: DEFINITION_V4,
    ...extra,
  };
  const last = history[history.length - 1];
  if (last && last.t === ts && last.equity_usd === navUsd) return history;
  return [...history, point];
}

/**
 * Append bridge marker to history (append-only correction annotation).
 */
export function appendBridgeMarker(history, bridge) {
  return [
    ...history,
    {
      t: bridge.bridged_at,
      marker: 'nav_bridge',
      from_definition: bridge.from_definition,
      to_definition: bridge.to_definition,
      from_headline_usd: bridge.from_headline_usd,
      to_corrected_nav_usd: bridge.to_corrected_nav_usd,
      adjustments: bridge.adjustments,
      note: bridge.note,
    },
  ];
}
