/**
 * WP2 — Canonical fill/order normalization.
 * Preserves raw exchange fields; derives ONE representation verified against cash + inventory.
 */

const SIDE_ACTIONS = new Set(['buy_yes', 'sell_yes', 'buy_no', 'sell_no']);

/**
 * @param {unknown} v
 * @returns {number|null}
 */
export function toNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse Kalshi fixed-point count fields (count_fp, remaining_count_fp).
 * @param {unknown} v
 * @returns {number|null}
 */
export function parseFpCount(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse Kalshi fixed-point dollar price fields → cents.
 * @param {unknown} v
 * @returns {number|null}
 */
/**
 * Parse Kalshi fixed-point dollar fields → exact USD (no rounding).
 * @param {unknown} v
 * @returns {number|null}
 */
export function parseFpDollars(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse Kalshi fixed-point dollar fields → cents (fractional allowed).
 * Never rounds mid-ledger — 0.7450 → 74.5¢ not 75¢.
 * @param {unknown} v
 * @returns {number|null}
 */
export function parseFpDollarsToCents(v) {
  const dollars = parseFpDollars(v);
  if (dollars == null) return null;
  return dollars * 100;
}

/**
 * @param {Record<string, unknown>} raw
 * @returns {number|null}
 */
export function extractQty(raw) {
  return toNum(raw.count ?? raw.qty ?? raw.quantity) ?? parseFpCount(raw.count_fp);
}

/**
 * @param {Record<string, unknown>} raw
 * @returns {'yes'|'no'|null}
 */
export function rawSide(raw) {
  const outcome = String(raw.outcome_side ?? '').toLowerCase();
  if (outcome === 'yes' || outcome === 'no') return outcome;
  const s = String(raw.side ?? raw.contract_side ?? '').toLowerCase();
  if (s === 'yes' || s === 'no') return s;
  const combined = String(raw.side ?? '').toLowerCase();
  if (combined.includes('yes')) return 'yes';
  if (combined.includes('no')) return 'no';
  return null;
}

/**
 * @param {Record<string, unknown>} raw
 * @returns {'buy'|'sell'|null}
 */
export function rawAction(raw) {
  const a = String(raw.action ?? '').toLowerCase();
  if (a === 'buy' || a === 'sell') return a;
  const combined = String(raw.side ?? '').toLowerCase();
  if (combined.startsWith('buy_')) return 'buy';
  if (combined.startsWith('sell_')) return 'sell';
  return null;
}

/**
 * Price in cents for the quoted side from raw Kalshi-shaped fields.
 * @param {Record<string, unknown>} raw
 * @param {'yes'|'no'} side
 * @returns {number|null}
 */
export function rawPriceCents(raw, side) {
  const fpDollars = side === 'yes' ? raw.yes_price_dollars : raw.no_price_dollars;
  const fromFp = parseFpDollarsToCents(fpDollars);
  if (fromFp != null) return fromFp;

  const direct = side === 'yes'
    ? toNum(raw.yes_price ?? raw.yes_price_cents)
    : toNum(raw.no_price ?? raw.no_price_cents);
  if (direct != null) return direct;

  const pc = toNum(raw.price_cents ?? raw.price);
  if (pc == null) return null;

  const quoted = rawSide(raw);
  const action = rawAction(raw);
  if (quoted === side) return pc;

  // Raw exchange complement math only — never applied to published combined sides.
  if (quoted != null && quoted !== side && pc >= 0 && pc <= 100 && !SIDE_ACTIONS.has(String(raw.side ?? '').toLowerCase())) {
    return 100 - pc;
  }
  if (action && quoted == null && pc >= 0 && pc <= 100) return pc;
  return pc;
}

/**
 * @param {'buy'|'sell'} action
 * @param {'yes'|'no'} side
 * @returns {string}
 */
export function canonicalSideKey(action, side) {
  return `${action}_${side}`;
}

/**
 * Signed inventory delta on YES and NO legs from a canonical fill.
 * @param {'buy'|'sell'} action
 * @param {'yes'|'no'} side
 * @param {number} qty
 * @returns {{ yes: number, no: number }}
 */
export function inventoryDelta(action, side, qty) {
  const q = Math.abs(qty);
  if (action === 'buy' && side === 'yes') return { yes: q, no: 0 };
  if (action === 'sell' && side === 'yes') return { yes: -q, no: 0 };
  if (action === 'buy' && side === 'no') return { yes: 0, no: q };
  if (action === 'sell' && side === 'no') return { yes: 0, no: -q };
  return { yes: 0, no: 0 };
}

/**
 * Cash delta in USD (negative = outflow). Excludes fees — add separately.
 * @param {'buy'|'sell'} action
 * @param {number} priceCents
 * @param {number} qty
 */
export function cashDeltaUsd(action, priceCents, qty) {
  const notional = (priceCents / 100) * Math.abs(qty);
  return action === 'buy' ? -notional : notional;
}

/**
 * Signed fee cash delta. Negative = outflow (fee paid); positive = rebate.
 * @param {Record<string, unknown>} raw
 */
export function signedFeeUsd(raw) {
  if (raw.fee_usd != null) return toNum(raw.fee_usd);
  if (raw.fees_usd != null) return toNum(raw.fees_usd);
  const cost = toNum(raw.fee_cost);
  if (cost == null) return null;
  return cost > 0 ? -cost : Math.abs(cost);
}

/**
 * True when input is already a normalized fill — do not re-transform.
 * @param {Record<string, unknown>} raw
 */
export function isAlreadyNormalized(raw) {
  return (
    typeof raw.confidence === 'string' &&
    raw.side != null &&
    SIDE_ACTIONS.has(String(raw.side)) &&
    (raw.inventory_delta_yes != null || raw.inventory_delta_no != null || raw.cash_delta_usd != null)
  );
}

/**
 * Detect complement-book mislabel: e.g. published buy_no@94 when raw is buy_yes@6.
 * @param {Record<string, unknown>} raw
 * @returns {{ action: 'buy'|'sell', side: 'yes'|'no', price_cents: number, source: string }|null}
 */
export function resolveFromRawExchange(raw) {
  const combined = String(raw.side ?? '').toLowerCase();
  // Dashboard-published combined sides (buy_no) are not raw exchange — may need complement correction.
  if (SIDE_ACTIONS.has(combined)) return null;

  const action = rawAction(raw);
  const side = rawSide(raw);
  if (!action || !side) return null;
  const price = rawPriceCents(raw, side);
  if (price == null) return null;
  return { action, side, price_cents: price, source: 'raw_exchange' };
}

/**
 * Recover poisoned publisher rows when exchange outcome_side / bare side is present.
 * Never infers side from max(yes_price, no_price). Fail-closed without outcome fields.
 * @param {Record<string, unknown>} raw
 */
export function resolveFromExchangeOutcome(raw) {
  const outcome = String(raw.outcome_side ?? '').toLowerCase();
  const bareSide = String(raw.side ?? '').toLowerCase();
  const hasOutcome = outcome === 'yes' || outcome === 'no';
  const hasBareSide = bareSide === 'yes' || bareSide === 'no';
  if (!hasOutcome && !hasBareSide) return null;

  const action = rawAction(raw);
  const side = hasOutcome ? outcome : bareSide;
  if (!action || !side) return null;
  const price = rawPriceCents(raw, side);
  if (price == null) return null;

  const combined = String(raw.side ?? '').toLowerCase();
  const publishedPrice = toNum(raw.price_cents);
  if (SIDE_ACTIONS.has(combined) && publishedPrice != null) {
    const [pubAction, pubSide] = combined.split('_');
    if (pubAction === action && pubSide === side && Math.abs(publishedPrice - price) < 0.01) {
      return null;
    }
  }

  return {
    action,
    side,
    price_cents: price,
    source: 'exchange_outcome',
    note: hasOutcome
      ? `Recovered from outcome_side=${outcome} (not max price)`
      : `Recovered from exchange side=${bareSide} (not max price)`,
  };
}

/**
 * Infer canonical side from a wrongly-published dashboard row (complement flip).
 * Only when explicitly requested — never default into accounting.
 * @param {Record<string, unknown>} published
 */
export function resolveFromPublishedComplement(published) {
  const combined = String(published.side ?? '').toLowerCase();
  if (!SIDE_ACTIONS.has(combined)) return null;
  const [action, side] = combined.split('_');
  const price = toNum(published.price_cents);
  const qty = extractQty(published);
  if (price == null || qty == null) return null;

  const flippedSide = side === 'yes' ? 'no' : 'yes';
  const flippedPrice = 100 - price;
  return {
    action,
    side: flippedSide,
    price_cents: flippedPrice,
    source: 'complement_inferred',
    note: `Corrected complement mislabel ${combined}@${price}¢ → ${action}_${flippedSide}@${flippedPrice}¢`,
  };
}

/**
 * Whether a normalized fill blocks certified NAV publication.
 * @param {ReturnType<typeof normalizeFill>} fill
 */
export function blocksCertifiedNav(fill) {
  return (
    fill.confidence === 'unknown' ||
    fill.confidence === 'unverified' ||
    fill.confidence === 'inferred_complement' ||
    fill.qty == null ||
    fill.price_cents == null ||
    fill.cash_delta_usd == null ||
    fill.side === 'unknown'
  );
}

/**
 * Normalize one fill. Raw fields are always preserved on output.
 * @param {Record<string, unknown>} raw
 * @param {{ prefer_complement_correction?: boolean }} [opts]
 */
export function normalizeFill(raw, opts = {}) {
  if (isAlreadyNormalized(raw)) {
    return { ...raw };
  }

  const fillId = raw.fill_id ?? raw.trade_id ?? raw.id ?? null;
  const orderId = raw.order_id ?? null;
  const qty = extractQty(raw);
  const feeUsd = signedFeeUsd(raw);

  const fromRaw = resolveFromRawExchange(raw);
  let canonical = fromRaw;
  let confidence = fromRaw ? 'verified' : 'unknown';

  if (!canonical) {
    const fromOutcome = resolveFromExchangeOutcome(raw);
    if (fromOutcome) {
      canonical = fromOutcome;
      confidence = 'verified';
    }
  }

  if (!canonical && opts.prefer_complement_correction === true) {
    const inferred = resolveFromPublishedComplement(raw);
    if (inferred) {
      canonical = inferred;
      confidence = 'inferred_complement';
    }
  }

  if (!canonical) {
    const combined = String(raw.side ?? '').toLowerCase();
    if (SIDE_ACTIONS.has(combined)) {
      const [action, side] = combined.split('_');
      const price = toNum(raw.price_cents) ?? rawPriceCents(raw, side);
      if (price != null && qty != null) {
        canonical = { action, side, price_cents: price, source: 'published_as_is' };
        confidence = 'unverified';
      }
    }
  }

  const sideKey = canonical
    ? canonicalSideKey(canonical.action, canonical.side)
    : (raw.side != null ? String(raw.side) : 'unknown');

  const priceCents = canonical?.price_cents ?? toNum(raw.price_cents) ?? (
    rawSide(raw) ? rawPriceCents(raw, rawSide(raw)) : null
  );
  const inv = canonical && qty != null
    ? inventoryDelta(canonical.action, canonical.side, qty)
    : { yes: null, no: null };
  const cash = canonical && qty != null && priceCents != null
    ? cashDeltaUsd(canonical.action, priceCents, qty)
    : null;

  const cashWithFees = cash != null && feeUsd != null ? cash + feeUsd : cash;

  return {
    fill_id: fillId ?? 'unknown',
    order_id: orderId ?? 'unknown',
    ticker: raw.ticker ?? raw.market_ticker ?? 'unknown',
    ts: raw.ts ?? raw.created_time ?? raw.fill_time ?? null,
    strategy_id: raw.strategy_id ?? raw.strategy ?? null,
    ownership: raw.ownership ?? raw.owner ?? null,
    qty: qty ?? null,
    side: sideKey,
    price_cents: priceCents,
    inventory_delta_yes: inv.yes,
    inventory_delta_no: inv.no,
    cash_delta_usd: cashWithFees,
    fee_usd: feeUsd,
    confidence,
    raw: { ...raw },
    normalization_note: canonical?.note ?? null,
  };
}

/**
 * Resting order quantity — prefer remaining (open) size over original count.
 * @param {Record<string, unknown>} raw
 * @returns {number|null}
 */
export function extractRestingQty(raw) {
  const remFp = parseFpCount(raw.remaining_count_fp);
  if (remFp != null) return remFp;
  const rem = parseFpCount(raw.remaining_count);
  if (rem != null) return rem;
  return extractQty(raw);
}

/**
 * Normalize resting order; risk uses canonical side (resolves SEP21 $1.20 vs $18.80).
 * @param {Record<string, unknown>} raw
 */
export function normalizeRestingOrder(raw) {
  const qty = extractRestingQty(raw);
  let canonical = resolveFromRawExchange(raw);

  if (!canonical) {
    canonical = resolveFromExchangeOutcome(raw);
  }

  if (!canonical) {
    const combined = String(raw.side ?? '').toLowerCase();
    if (SIDE_ACTIONS.has(combined)) {
      const [action, side] = combined.split('_');
      const price = toNum(raw.price_cents) ?? rawPriceCents(raw, side);
      const declaredRisk = toNum(raw.risk_usd ?? raw.open_risk_usd);
      if (price != null) {
        const complement = {
          action,
          side: side === 'yes' ? 'no' : 'yes',
          price_cents: 100 - price,
        };
        const literalRisk = (price / 100) * (qty ?? 0);
        const complementRisk = (complement.price_cents / 100) * (qty ?? 0);
        if (
          action === 'buy' &&
          declaredRisk != null &&
          Math.abs(literalRisk - declaredRisk) > 0.5 &&
          Math.abs(complementRisk - declaredRisk) < 0.5
        ) {
          canonical = { ...complement, source: 'risk_matched_complement' };
        } else if (action === 'buy' && declaredRisk != null && price > 50) {
          const inferred = resolveFromPublishedComplement(raw);
          if (inferred && Math.abs(complementRisk - declaredRisk) < 0.5) {
            canonical = { ...inferred, source: 'risk_matched_complement' };
          } else {
            canonical = { action, side, price_cents: price, source: 'published_as_is' };
          }
        } else {
          canonical = { action, side, price_cents: price, source: 'published_as_is' };
        }
      }
    }
  }

  const priceCents = canonical?.price_cents ?? toNum(raw.price_cents) ?? (
    rawSide(raw) ? rawPriceCents(raw, rawSide(raw)) : null
  );
  const sideKey = canonical
    ? canonicalSideKey(canonical.action, canonical.side)
    : String(raw.side ?? 'unknown');
  const riskUsd = priceCents != null && qty != null && canonical?.action === 'buy'
    ? (priceCents / 100) * qty
    : null;

  return {
    order_id: raw.order_id ?? raw.id ?? 'unknown',
    ticker: raw.ticker ?? raw.market_ticker ?? 'unknown',
    side: sideKey,
    price_cents: priceCents,
    qty: qty ?? null,
    risk_usd: riskUsd,
    raw: { ...raw },
    normalization_source: canonical?.source ?? 'unknown',
  };
}

/**
 * Lot key for FIFO matching — scoped by ticker, owner, and contract side.
 * @param {ReturnType<typeof normalizeFill>} fill
 * @param {'yes'|'no'} side
 */
export function lotKey(fill, side) {
  const owner = fill.ownership ?? 'unknown';
  return `${fill.ticker}|${owner}|${side}`;
}

/**
 * FIFO realized P&L for normalized fills, keyed by ticker/owner/side.
 * Entry (buy) fees are allocated into realized P&L on match; rebates preserve sign.
 * @param {ReturnType<typeof normalizeFill>[]} fills
 */
export function matchRealizedPnl(fills) {
  const sorted = [...fills].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  /** @type {Map<string, Array<{ side: string, qty: number, original_qty: number, price_cents: number, fee: number }>>} */
  const lotsByKey = new Map();
  const results = [];

  for (const f of sorted) {
    if (!f.qty || f.price_cents == null || f.side === 'unknown') {
      results.push({ ...f, pnl_usd: null, pnl_kind: 'unmatched', pnl_status: 'flat' });
      continue;
    }
    const [action, side] = f.side.split('_');
    const key = lotKey(f, side);

    if (action === 'buy') {
      const lots = lotsByKey.get(key) ?? [];
      lots.push({
        side,
        qty: f.qty,
        original_qty: f.qty,
        price_cents: f.price_cents,
        fee: f.fee_usd ?? 0,
      });
      lotsByKey.set(key, lots);
      results.push({ ...f, pnl_usd: null, pnl_kind: 'open_unrealized', pnl_status: 'open', pnl_label: 'open' });
      continue;
    }

    const lots = lotsByKey.get(key) ?? [];
    let remaining = f.qty;
    let pnl = f.fee_usd ?? 0;
    let matchedQty = 0;

    while (remaining > 0 && lots.length) {
      const lot = lots[0];
      if (lot.side !== side) break;
      const m = Math.min(remaining, lot.qty);
      pnl += m * ((f.price_cents - lot.price_cents) / 100);
      const feeShare = lot.original_qty > 0 ? (m / lot.original_qty) * lot.fee : 0;
      pnl += feeShare;
      matchedQty += m;
      lot.qty -= m;
      remaining -= m;
      if (lot.qty <= 1e-9) lots.shift();
    }

    const kind = remaining > 1e-9 ? 'unmatched' : 'realized';
    const status = kind === 'realized' ? (pnl >= 0 ? 'win' : 'lose') : 'flat';
    results.push({
      ...f,
      pnl_usd: kind === 'realized' ? Math.round(pnl * 10000) / 10000 : null,
      pnl_kind: kind,
      pnl_status: status,
      pnl_label: kind === 'realized' ? status : 'uncertain',
      matched_qty: matchedQty,
      unmatched_qty: remaining > 1e-9 ? remaining : 0,
    });
  }
  return results;
}

/**
 * Publish-ready fill row from normalized fill + optional P&L overlay.
 */
export function toPublishedFill(normalized, pnlOverlay = {}) {
  return {
    fill_id: normalized.fill_id,
    order_id: normalized.order_id,
    ticker: normalized.ticker,
    side: normalized.side,
    price_cents: normalized.price_cents,
    qty: normalized.qty,
    ts: normalized.ts,
    strategy_id: normalized.strategy_id ?? null,
    ownership: normalized.ownership ?? 'unknown',
    fee_usd: normalized.fee_usd,
    inventory_delta_yes: normalized.inventory_delta_yes,
    inventory_delta_no: normalized.inventory_delta_no,
    cash_delta_usd: normalized.cash_delta_usd,
    normalization_confidence: normalized.confidence,
    raw_side: normalized.raw.side ?? normalized.raw.action,
    raw_price_cents: normalized.raw.yes_price ?? normalized.raw.no_price ?? normalized.raw.price_cents,
    ...pnlOverlay,
  };
}
