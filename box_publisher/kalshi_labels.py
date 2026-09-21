"""Kalshi fill/order side + price labeling — never infer side from max(yes, no).

Kalshi always echoes both yes and no prices on every order/fill. The complement
price (e.g. no@94 when trading yes@6) is display-only; side must come from
outcome_side or side fields.
"""
from __future__ import annotations

from typing import Any


def _cents_from_dollars(v: Any) -> int | None:
    if v is None or v == "":
        return None
    try:
        return int(round(float(v) * 100))
    except (TypeError, ValueError):
        return None


def label_fill(row: dict[str, Any]) -> tuple[int | None, str]:
    """Map exchange fill → (price_cents, side_label e.g. buy_yes).

    Prefer outcome_side / side. NEVER choose side by max(yes_c, no_c).
    """
    yes_c = _cents_from_dollars(row.get("yes_price_dollars"))
    no_c = _cents_from_dollars(row.get("no_price_dollars"))
    side = str(row.get("side") or "").lower()
    action = str(row.get("action") or "").lower()
    outcome = str(row.get("outcome_side") or "").lower()

    if outcome == "no" or side == "no":
        return no_c, f"{action}_no" if action else "no"
    if outcome == "yes" or side == "yes":
        return yes_c, f"{action}_yes" if action else "yes"
    if no_c is not None and yes_c is None:
        return no_c, f"{action}_no" if action else "no"
    return yes_c, f"{action}_yes" if action else (side or "yes")


def label_resting_order(row: dict[str, Any]) -> tuple[str, int | None]:
    """Map exchange resting order → (side_label, price_cents).

    Prefer outcome_side / side. NEVER choose side by max(yes_c, no_c).
    """
    side = str(row.get("side") or "").lower()
    yes_c = _cents_from_dollars(row.get("yes_price_dollars"))
    no_c = _cents_from_dollars(row.get("no_price_dollars"))
    outcome = str(row.get("outcome_side") or "").lower()
    action = str(row.get("action") or "").lower()

    if side == "ask" or (action == "sell" and (outcome == "yes" or side in ("yes", "bid"))):
        return "sell_yes", yes_c
    if outcome == "no" or side == "no" or (action == "buy" and outcome == "no"):
        return "buy_no", no_c if no_c is not None else yes_c
    side_l = "buy_yes" if side in ("yes", "bid", "") or outcome == "yes" else side
    return side_l, yes_c


def cash_delta_usd(side_label: str, price_cents: int | float, qty: float) -> float:
    """Signed cash delta: buy = outflow (negative), sell = inflow."""
    notional = (float(price_cents) / 100.0) * abs(float(qty))
    return -notional if str(side_label).startswith("buy") else notional
