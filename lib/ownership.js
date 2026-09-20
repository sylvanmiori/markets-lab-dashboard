/**
 * Lot ownership attribution — allowlist alone is insufficient.
 */
import { DEFAULT_ALLOWLIST, PERSONAL_TICKER_PREFIXES } from './constants.js';

/**
 * @param {string} ticker
 */
export function isPersonalTicker(ticker) {
  const t = String(ticker ?? '');
  return PERSONAL_TICKER_PREFIXES.some((p) => t.startsWith(p));
}

/**
 * @param {string} ticker
 * @param {string[]} [allowlist]
 */
export function isAllowlistedTicker(ticker, allowlist = DEFAULT_ALLOWLIST) {
  const t = String(ticker ?? '');
  return allowlist.some((p) => t.startsWith(p));
}

/**
 * Attribute owner for a fill/lot.
 * Priority: explicit owner > strategy_id → lab > personal ticker patterns > allowlist → unknown
 * @param {Record<string, unknown>} item
 * @param {{ allowlist?: string[] }} [ctx]
 * @returns {'lab'|'personal'|'unknown'}
 */
export function attributeOwner(item, ctx = {}) {
  const explicit = item.ownership ?? item.owner;
  if (explicit === 'lab' || explicit === 'personal') return explicit;

  if (item.strategy_id || item.strategy) return 'lab';

  const ticker = String(item.ticker ?? item.market_ticker ?? '');
  if (isPersonalTicker(ticker)) return 'personal';

  if (isAllowlistedTicker(ticker, ctx.allowlist)) return 'lab';

  return 'unknown';
}
