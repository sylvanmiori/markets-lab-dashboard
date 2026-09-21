/** Original lab allocation semantics — preserved across curve definitions. */
export const LAB_BASELINE_USD = 200;
export const PRE_LAB_PERSONAL_CASH_USD = 40;
export const LAB_DEPOSIT_ID = '01a048a4-e740-7e02-bd42-dc6f4b8c35d2';

/** Headline equity definitions. */
export const DEFINITION_V3 = 'lab_curve_v3';
export const DEFINITION_V4 = 'lab_curve_v4';

/** Ticker prefixes that are never lab strategy positions (personal / legacy). */
export const PERSONAL_TICKER_PREFIXES = [
  'KXNFLGAME-',
  'KXSB-',
  'KXMLB-',
  'SENATETX-',
];

/** Default weather / trial allowlist prefixes (insufficient alone for ownership). */
export const DEFAULT_ALLOWLIST = [
  'KXHIGHCHI',
  'KXHIGHNY',
  'KXHIGHLAX',
  'KXBTCD',
  'KXFEDDECISION',
  'KXAAAGASD',
];
