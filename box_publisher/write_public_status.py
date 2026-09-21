#!/usr/bin/env python3
"""Sanitized public status + equity history for Pages. No secrets."""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from kalshi_labels import label_fill, label_resting_order

TRADER_DIR = Path("/home/box/agent-data/shared/kalshi-trader")
DASH = TRADER_DIR / "dashboard"
OUT = DASH / "public-status.json"
SNAP = DASH / "publisher_snapshot.json"
HIST = DASH / "equity_history.json"
STATE = DASH / "equity_state.json"
HB = TRADER_DIR / "heartbeat.json"
YAML = TRADER_DIR / "trader.yaml"
ALLOWLIST_JSON = Path("/home/box/agent-data/shared/phase0/ENGINEER_ALLOWLIST_v0.1.json")
REPO = Path("/workspace/grok-kalshi-weather")
START = 200.0
CT = ZoneInfo("America/Chicago")
HIST_MAX_POINTS = int(14 * 24 * 60 / 3) + 50  # ~14d @ 3min
FORMULA = (
    "lab equity = Kalshi total − non-lab positions − $40 pre-lab cash; "
    "baseline $200 from first fill 2026-09-03 (not full account)"
)
EQUITY_DEFINITION_CHANGED_AT = "2026-09-03T23:53:16Z"
EQUITY_HISTORY_NOTE = (
    "lab_curve_v3: curve starts 2026-09-03 at $200. equity_usd excludes personal "
    "non-lab positions and $40 pre-lab cash. Older points deleted as wrong."
)
NONLAB_PREFIXES = (
    "KXSB-", "KXMLB-", "SENATETX-", "KXNFLWINS-", "KXNFLGAME-", "KXWCADVANCE-",
)
LAB_DEPOSIT_USD = 200.0
LAB_DEPOSIT_ID = "01a048a4-e740-7e02-bd42-dc6f4b8c35d2"
LAB_DEPOSIT_CT = "2026-08-28T08:52:50-05:00"
# Steven: ~$40 cash already in Kalshi before the $200 lab deposit (excluded from lab equity).
PRE_LAB_CASH_USD = 40.0
LAB_START_TS = "2026-09-03T23:53:16Z"  # first lab fill



def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def _mtime_utc(path: Path) -> str | None:
    try:
        if not path.exists():
            return None
        return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except Exception:
        return None


def _min_iso(*vals: str | None) -> str | None:
    parsed = []
    for v in vals:
        if not v:
            continue
        try:
            parsed.append(datetime.fromisoformat(str(v).replace("Z", "+00:00")))
        except Exception:
            continue
    if not parsed:
        return None
    return min(parsed).strftime("%Y-%m-%dT%H:%M:%SZ")



def _parse_yaml_allowlist(text: str) -> list[str]:
    out: list[str] = []
    in_block = False
    for line in text.splitlines():
        if line.strip().startswith("series_allowlist:"):
            in_block = True
            continue
        if in_block:
            if line.startswith(" ") or line.startswith("\t"):
                s = line.strip()
                if s.startswith("- "):
                    out.append(s[2:].strip().strip("\"'"))
                elif s and not s.startswith("#"):
                    break
            elif line.strip() and not line.strip().startswith("#"):
                break
    return out


def _allowed(ticker: str, allow: list[str]) -> bool:
    t = str(ticker or "")
    return any(t == a or t.startswith(a + "-") or t.startswith(a) for a in allow)


def _is_nonlab(ticker: str) -> bool:
    t = str(ticker or "")
    return any(t.startswith(p) for p in NONLAB_PREFIXES)


def _heartbeat_age(hb: dict) -> float | None:
    ts = hb.get("last_tick_utc") or hb.get("written_at_utc")
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        return max(0.0, (datetime.now(timezone.utc) - dt).total_seconds())
    except Exception:
        return None


def _dollars(v) -> float | None:
    try:
        if v is None or v == "":
            return None
        return float(v)
    except (TypeError, ValueError):
        return None


def _cents_from_dollars(v) -> int | None:
    d = _dollars(v)
    if d is None:
        return None
    return int(round(d * 100))


def _short_oid(oid: str) -> str:
    oid = str(oid or "")
    return oid[:18] if oid else ""



def _resting_notional_usd(o: dict) -> float:
    """Match recon: remaining_count_fp; buy-NO cost uses no_price."""
    try:
        qty = float(o.get("remaining_count_fp") or o.get("remaining_count") or o.get("count") or 0)
    except (TypeError, ValueError):
        qty = 0.0
    if qty <= 0:
        return 0.0
    outcome = str(o.get("outcome_side") or "").lower()
    action = str(o.get("action") or "").lower()
    side = str(o.get("side") or "").lower()
    if action == "sell" and outcome == "yes":
        return 0.0

    def _d(v):
        if v is None:
            return None
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    yes_d = _d(o.get("yes_price_dollars"))
    no_d = _d(o.get("no_price_dollars"))
    is_buy_no = outcome == "no" or (action == "sell" and side == "yes" and outcome != "yes")
    if is_buy_no:
        px = no_d if no_d is not None else (max(0.0, 1.0 - yes_d) if yes_d is not None else 0.5)
    else:
        px = yes_d if yes_d is not None else (max(0.0, 1.0 - no_d) if no_d is not None else 0.0)
    return float(qty) * float(px)


def mid_yes(adapter, ticker: str) -> float | None:
    try:
        from collectors.orderbook import parse_top_of_book

        raw = adapter.get_orderbook(ticker, depth=1)
        m = adapter.get_market(ticker)
        market = m.get("market") if isinstance(m.get("market"), dict) else m
        top = parse_top_of_book(raw if isinstance(raw, dict) else {}, market if isinstance(market, dict) else {})
        bid, ask = top.get("yes_bid"), top.get("yes_ask")
        if bid is not None and ask is not None:
            return (float(bid) + float(ask)) / 2.0
        if bid is not None:
            return float(bid)
        if ask is not None:
            return float(ask)
        # fallback market fields
        yb = market.get("yes_bid_dollars") or market.get("yes_bid")
        ya = market.get("yes_ask_dollars") or market.get("yes_ask")
        if yb is not None and ya is not None:
            return (float(yb) + float(ya)) / 2.0
    except Exception:
        return None
    return None



def _fill_leg(side_l: str) -> str:
    s = str(side_l or "").lower()
    if s.endswith("_no") or s == "no":
        return "no"
    return "yes"


def _fill_action(side_l: str) -> str:
    s = str(side_l or "").lower()
    if s.startswith("sell"):
        return "sell"
    return "buy"


def annotate_fills_pnl(fills: list[dict], mids: dict[str, float]) -> list[dict]:
    """FIFO match buy↔sell on same ticker+leg; attach pnl_usd + pnl_status."""
    # work oldest-first
    chron = sorted(fills, key=lambda x: str(x.get("ts") or ""))
    # open lots: ticker|leg -> list of {qty_left, price_cents, idx}
    books: dict[str, list[dict]] = {}
    # results keyed by id(row)
    out_map: dict[int, dict] = {}

    for row in chron:
        ticker = str(row.get("ticker") or "")
        leg = _fill_leg(row.get("side"))
        action = _fill_action(row.get("side"))
        qty = float(row.get("qty") or 0)
        px = row.get("price_cents")
        if not ticker or qty <= 0 or px is None:
            r = dict(row)
            r["pnl_usd"] = None
            r["pnl_status"] = "flat"
            r["pnl_label"] = "uncertain"
            out_map[id(row)] = r
            continue
        key = f"{ticker}|{leg}"
        r = dict(row)
        if action == "buy":
            books.setdefault(key, []).append({"qty": qty, "px": int(px), "row_id": id(row)})
            # mark open for now; may get closed by later sells
            r["pnl_usd"] = None
            r["pnl_status"] = "open"
            r["pnl_label"] = "open"
            out_map[id(row)] = r
        else:
            # sell: match FIFO buys
            need = qty
            realized = 0.0
            matched = 0.0
            lot_list = books.get(key) or []
            while need > 1e-9 and lot_list:
                lot = lot_list[0]
                take = min(need, lot["qty"])
                # sell proceeds - buy cost, same leg price in cents
                realized += take * (int(px) - int(lot["px"])) / 100.0
                lot["qty"] -= take
                need -= take
                matched += take
                if lot["qty"] <= 1e-9:
                    lot_list.pop(0)
            books[key] = lot_list
            if matched <= 1e-9:
                r["pnl_usd"] = None
                r["pnl_status"] = "flat"
                r["pnl_label"] = "uncertain"
            else:
                # if partial unmatched sell, still show realized on matched portion
                pnl = round(realized, 4)
                r["pnl_usd"] = pnl
                if abs(pnl) < 0.005:
                    r["pnl_status"] = "flat"
                    r["pnl_label"] = "flat"
                elif pnl > 0:
                    r["pnl_status"] = "win"
                    r["pnl_label"] = "win"
                else:
                    r["pnl_status"] = "lose"
                    r["pnl_label"] = "lose"
            out_map[id(row)] = r

    # unrealized MTM for leftover open buys
    for key, lots in books.items():
        ticker, leg = key.split("|", 1)
        mid_yes = mids.get(ticker)
        for lot in lots:
            r = out_map.get(lot["row_id"])
            if not r:
                continue
            if mid_yes is None:
                r["pnl_usd"] = None
                r["pnl_status"] = "open"
                r["pnl_label"] = "open"
                continue
            if leg == "yes":
                mtm = (mid_yes * 100.0 - lot["px"]) / 100.0 * lot["qty"]
            else:
                no_mid = (1.0 - mid_yes) * 100.0
                mtm = (no_mid - lot["px"]) / 100.0 * lot["qty"]
            mtm = round(mtm, 4)
            r["pnl_usd"] = mtm
            r["pnl_label"] = "open"
            if abs(mtm) < 0.02:
                r["pnl_status"] = "open"  # yellow
            elif mtm > 0:
                r["pnl_status"] = "win"
            else:
                r["pnl_status"] = "lose"
            # force yellow treatment for open in UI via pnl_label open; status color can still hint
            # Chief: yellow = flat/still open/uncertain — use open status for still-open
            r["pnl_status"] = "open" if abs(mtm) < 0.05 else ("win" if mtm > 0 else "lose")
            if r["pnl_status"] != "open":
                # still label open but color by sign when clear
                r["pnl_label"] = "open"
            out_map[lot["row_id"]] = r

    # return newest-first (original display order)
    out = [out_map[id(row)] for row in fills if id(row) in out_map]
    for r in out:
        lab = str(r.get("pnl_label") or "")
        st = str(r.get("pnl_status") or "")
        if lab == "open" or st == "open":
            r["pnl_kind"] = "open_unrealized"
            # UI treats open ⇒ unrealized; keep label open for existing chips
        elif lab in ("win", "lose", "flat") and st != "open":
            r["pnl_kind"] = "realized"
        elif lab == "uncertain":
            r["pnl_kind"] = "unmatched"
        else:
            r.setdefault("pnl_kind", None)
    return out



def main() -> None:
    hb: dict = {}
    if HB.exists():
        try:
            hb = json.loads(HB.read_text())
        except Exception:
            hb = {}

    allowlist: list[str] = []
    if YAML.exists():
        allowlist = _parse_yaml_allowlist(YAML.read_text())
    if not allowlist and ALLOWLIST_JSON.exists():
        try:
            aj = json.loads(ALLOWLIST_JSON.read_text())
            allowlist = list(aj.get("allowlist") or aj.get("series_allowlist") or [])
        except Exception:
            pass

    max_open = 50.0
    try:
        for line in YAML.read_text().splitlines():
            if line.strip().startswith("max_open_usd:"):
                max_open = float(line.split(":", 1)[1].strip())
                break
    except Exception:
        pass

    # Heartbeat open_usd historically undercounted V2 resting asks; recompute below.
    open_usd = float(hb.get("open_usd") or 0)
    remaining = float(
        hb.get("remaining_usd") if hb.get("remaining_usd") is not None else max(0.0, max_open - open_usd)
    )
    open_from_exchange = None
    age = _heartbeat_age(hb)
    kill_path = TRADER_DIR / "KILL"
    kill_on = kill_path.exists()
    pid = hb.get("pid")
    pid_alive = False
    if pid:
        try:
            os.kill(int(pid), 0)
            pid_alive = True
        except Exception:
            pid_alive = False
    alive = bool(
        (not kill_on)
        and pid_alive
        and hb.get("status") == "ok"
        and age is not None
        and age < 900
    )
    mode = str(hb.get("last_note") or "unknown")
    if kill_on:
        mode = "KILL on — no new risk"

    resting: list[dict] = []
    fills: list[dict] = []
    realized = 0.0
    unrealized = 0.0
    notes_err = None
    portfolio_cash_usd = None
    portfolio_positions_usd = None
    portfolio_equity_usd = None
    portfolio_equity_usd_full = None
    lab_equity_usd = None
    nonlab_positions_usd = 0.0
    nonlab_legs: list[dict] = []
    # WP1/WP2 cutover: raw inputs for lib/publisher.js (lab_curve_v4)
    snap_positions: list[dict] = []
    snap_fills: list[dict] = []
    snap_resting: list[dict] = []

    try:
        os.environ.setdefault("GROK_KALSHI_SECRETS_DIR", "/home/box/agent-data/shared/kalshi-prod-secrets")
        os.environ.setdefault("KALSHI_ENV", "prod")
        os.environ.pop("KALSHI_PROD_KEY_ID", None)
        pem = Path("/home/box/agent-data/shared/kalshi-prod-secrets/KALSHI_PROD_PRIVATE_KEY")
        kid = Path("/home/box/agent-data/shared/kalshi-prod-secrets/KALSHI_PROD_KEY_ID")
        if pem.exists() and kid.exists():
            os.environ["KALSHI_PROD_PRIVATE_KEY_PATH"] = str(pem)
            os.environ["KALSHI_PROD_KEY_ID"] = kid.read_text().strip()
            sys.path.insert(0, str(REPO / "src"))
            from execution.kalshi_adapter import KalshiAdapter

            cfg = {
                "live_orders_enabled": False,
                "environment": "prod",
                "risk": {"lab_series": "KXHIGHCHI"},
                "kill_switch": {
                    "default_halted": True,
                    "steven_gate_d": False,
                    "file_path": "/tmp/dash-nokill",
                },
            }
            adapter = KalshiAdapter(config=cfg)

            # True Kalshi portfolio equity (GET /portfolio/balance only).
            # Confirmed vs app: balance_dollars = cash USD; portfolio_value = positions MTM in cents.
            # Equity ≈ cash + portfolio_value/100.
            portfolio_cash_usd = None
            portfolio_positions_usd = None
            portfolio_equity_usd = None
            try:
                bal_raw = adapter.get_portfolio_balance() or {}
                bal = bal_raw.get("balance") if isinstance(bal_raw.get("balance"), dict) else bal_raw
                cash = _dollars(bal.get("balance_dollars"))
                if cash is None and bal.get("balance") is not None:
                    # bare balance field is cents when balance_dollars absent
                    cash = float(bal.get("balance")) / 100.0
                pos_v = _dollars(bal.get("portfolio_value_dollars"))
                if pos_v is None and bal.get("portfolio_value") is not None:
                    # portfolio_value is integer cents (e.g. 16547 → $165.47)
                    pos_v = float(bal.get("portfolio_value")) / 100.0
                if cash is not None:
                    portfolio_cash_usd = round(float(cash), 4)
                if pos_v is not None:
                    portfolio_positions_usd = round(float(pos_v), 4)
                if portfolio_cash_usd is not None and portfolio_positions_usd is not None:
                    portfolio_equity_usd = round(portfolio_cash_usd + portfolio_positions_usd, 4)
                elif portfolio_cash_usd is not None:
                    portfolio_equity_usd = portfolio_cash_usd
            except Exception as be:
                notes_err = f"balance_skip:{type(be).__name__}:{be}"[:120]

            # positions → lab MTM + strip non-lab from primary equity
            positions = (adapter.get_positions(limit=200) or {}).get("market_positions") or []
            nonlab_mtm = 0.0
            nonlab_legs = []
            for p in positions:
                ticker = str(p.get("ticker") or "")
                qty_all = _dollars(p.get("position_fp") or p.get("position")) or 0.0
                if abs(qty_all) < 1e-9:
                    continue
                if _is_nonlab(ticker) or not _allowed(ticker, allowlist):
                    mid_nl = mid_yes(adapter, ticker)
                    exp_nl = _dollars(p.get("market_exposure_dollars")) or 0.0
                    if mid_nl is None:
                        mtm_nl = abs(exp_nl)
                    elif qty_all > 0:
                        mtm_nl = qty_all * mid_nl
                    else:
                        mtm_nl = abs(qty_all) * (1.0 - mid_nl)
                    nonlab_mtm += mtm_nl
                    nonlab_legs.append({"ticker": ticker, "qty": qty_all, "mtm_usd": round(mtm_nl, 4)})
            nonlab_positions_usd = round(nonlab_mtm, 4)
            # Full position book for v4 publisher (lab + personal)
            snap_positions = []
            for p in positions:
                ticker = str(p.get("ticker") or "")
                qty_all = _dollars(p.get("position_fp") or p.get("position")) or 0.0
                if abs(qty_all) < 1e-9:
                    continue
                mid = mid_yes(adapter, ticker)
                exp = _dollars(p.get("market_exposure_dollars")) or 0.0
                if mid is None:
                    mtm = abs(exp)
                elif qty_all > 0:
                    mtm = qty_all * mid
                else:
                    mtm = abs(qty_all) * (1.0 - mid)
                owner = "personal" if (_is_nonlab(ticker) or not _allowed(ticker, allowlist)) else "lab"
                snap_positions.append(
                    {
                        "ticker": ticker,
                        "qty": qty_all,
                        "mtm_usd": round(mtm, 4),
                        "owner": owner,
                        "strategy_id": "WX_CHI" if owner == "lab" else None,
                    }
                )
            if portfolio_equity_usd is not None:
                portfolio_equity_usd_full = float(portfolio_equity_usd)
                lab_equity_usd = round(
                    portfolio_equity_usd_full - nonlab_positions_usd - float(PRE_LAB_CASH_USD), 4
                )
                portfolio_equity_usd = lab_equity_usd  # primary = lab stake vs $200
            for p in positions:
                ticker = str(p.get("ticker") or "")
                if not _allowed(ticker, allowlist) or _is_nonlab(ticker):
                    continue
                rp = _dollars(p.get("realized_pnl_dollars")) or 0.0
                realized += rp
                qty = _dollars(p.get("position_fp") or p.get("position")) or 0.0
                if abs(qty) < 1e-9:
                    continue
                mid = mid_yes(adapter, ticker)
                cost = _dollars(p.get("market_exposure_dollars")) or 0.0
                if mid is None:
                    continue
                if qty > 0:
                    # long YES: mark at mid, cost ≈ exposure
                    unrealized += qty * mid - cost
                else:
                    # short YES / long NO: mark NO at (1-mid)
                    unrealized += abs(qty) * (1.0 - mid) - cost

            # resting buys/sells — allowlisted only
            orders = (adapter.get_orders(status="resting", limit=100) or {}).get("orders") or []
            for o in orders:
                ticker = str(o.get("ticker") or "")
                if not _allowed(ticker, allowlist):
                    continue
                qty = _dollars(o.get("remaining_count_fp") or o.get("remaining_count") or o.get("count")) or 0.0
                side_l, price_c = label_resting_order(o)
                resting.append(
                    {
                        "ticker": ticker,
                        "side": side_l,
                        "price_cents": price_c,
                        "qty": qty,
                        "order_id_short": _short_oid(o.get("order_id")),
                    }
                )
                snap_resting.append(
                    {
                        "ticker": ticker,
                        "side": side_l,
                        "action": str(o.get("action") or ""),
                        "yes_price_dollars": o.get("yes_price_dollars"),
                        "no_price_dollars": o.get("no_price_dollars"),
                        "remaining_count_fp": o.get("remaining_count_fp") or o.get("remaining_count"),
                        "count": o.get("count"),
                        "order_id": o.get("order_id"),
                        "price_cents": price_c,
                        "qty": qty,
                    }
                )

            # True open: allowlisted position exposure + resting entry notional
            open_pos = 0.0
            for p in positions:
                ticker = str(p.get("ticker") or "")
                if not _allowed(ticker, allowlist):
                    continue
                open_pos += abs(_dollars(p.get("market_exposure_dollars")) or 0.0)
            qty_by = {}
            for p0 in positions:
                ticker = str(p0.get("ticker") or "")
                if not _allowed(ticker, allowlist):
                    continue
                try:
                    q = float(p0.get("position_fp") or p0.get("position") or 0)
                except (TypeError, ValueError):
                    q = 0.0
                qty_by[ticker] = qty_by.get(ticker, 0.0) + q
            open_rest = 0.0
            for o in orders:
                ticker = str(o.get("ticker") or "")
                if not _allowed(ticker, allowlist):
                    continue
                # skip sell-YES scalp / covers that close existing positions
                try:
                    pq = float(qty_by.get(ticker) or 0)
                except (TypeError, ValueError):
                    pq = 0.0
                action = str(o.get("action") or "").lower()
                side = str(o.get("side") or "").lower()
                book_side = str(o.get("book_side") or "").lower()
                is_yes_ask = book_side == "ask" or (action == "sell" and side == "yes")
                is_yes_bid = book_side == "bid" or (action == "buy" and side == "yes")
                if pq > 0 and is_yes_ask:
                    continue
                if pq < 0 and is_yes_bid:
                    continue
                open_rest += _resting_notional_usd(o)
            open_from_exchange = open_pos + open_rest
            # Prefer canonical recon open (matches lab_hourly_health / DASH_RECON_LIE gate).
            # Hand-roll kept as fallback only.
            try:
                from execution.reconciliation import (
                    fetch_account_snapshot,
                    total_open_worst_case_usd,
                )
                _lab = [
                    a for a in allowlist
                    if str(a).upper().startswith("KXHIGH")
                ] or ["KXHIGHCHI", "KXHIGHNY", "KXHIGHLAX"]
                _snap = fetch_account_snapshot(adapter)
                open_usd = float(total_open_worst_case_usd(_snap, lab_series=_lab))
                open_from_exchange = open_usd
            except Exception as _oe:
                open_usd = float(open_from_exchange)
                notes_err = (notes_err or "") + f"|open_recon_fallback:{type(_oe).__name__}"
            remaining = max(0.0, max_open - open_usd)

            # fills — allowlisted for UI annotate; ALL fills (lab+personal) for v4 cash ledger
            raw_fills = []
            snap_fills = []
            for f in (adapter.get_fills(limit=200) or {}).get("fills") or []:
                ticker = str(f.get("ticker") or f.get("market_ticker") or "")
                qty = _dollars(f.get("count_fp") or f.get("count")) or 0.0
                if qty <= 0:
                    continue
                side = str(f.get("side") or "").lower()
                action = str(f.get("action") or "").lower()
                price_c, side_l = label_fill(f)
                fee = (
                    _dollars(f.get("fee_cost"))
                    or _dollars(f.get("fee_usd"))
                    or _dollars(f.get("fee"))
                )
                snap_row = {
                    "fill_id": str(f.get("fill_id") or f.get("trade_id") or f.get("order_id") or "")[:64],
                    "ticker": ticker,
                    "side": side_l if price_c is not None else side,
                    "action": action,
                    "count_fp": f.get("count_fp") or f.get("count"),
                    "yes_price_dollars": f.get("yes_price_dollars"),
                    "no_price_dollars": f.get("no_price_dollars"),
                    "price_cents": price_c,
                    "qty": qty,
                    "ts": str(f.get("created_time") or "")[:32],
                    "created_time": str(f.get("created_time") or "")[:32],
                }
                if fee is not None:
                    snap_row["fee_usd"] = round(float(fee), 6)
                    snap_row["fee_cost"] = snap_row["fee_usd"]
                if f.get("strategy_id"):
                    snap_row["strategy_id"] = str(f.get("strategy_id"))[:64]
                if _is_nonlab(ticker) or not _allowed(ticker, allowlist):
                    snap_row["owner"] = "personal"
                elif f.get("strategy_id") or _allowed(ticker, allowlist):
                    snap_row["owner"] = "lab"
                snap_fills.append(snap_row)
                if not _allowed(ticker, allowlist):
                    continue
                if price_c is None or price_c < 1 or price_c > 99:
                    continue
                row = {
                    "ticker": ticker,
                    "side": side_l,
                    "price_cents": price_c,
                    "qty": qty,
                    "ts": str(f.get("created_time") or "")[:32],
                }
                if fee is not None:
                    row["fee_usd"] = round(float(fee), 6)
                    row["fee_cost"] = row["fee_usd"]
                if f.get("strategy_id"):
                    row["strategy_id"] = str(f.get("strategy_id"))[:64]
                raw_fills.append(row)
            # mids for open MTM (reuse orderbooks sparingly)
            mids: dict[str, float] = {}
            for tk in {r["ticker"] for r in raw_fills}:
                try:
                    mid = mid_yes(adapter, tk)
                    if mid is not None:
                        mids[tk] = float(mid)
                except Exception:
                    pass
            annotated = annotate_fills_pnl(raw_fills, mids)
            fills = annotated[:20]
    except Exception as e:
        notes_err = f"book_fetch_skip:{type(e).__name__}:{e}"[:120]

    lab_synthetic_equity_usd = round(START + realized + unrealized, 4)
    if portfolio_equity_usd is not None:
        equity = round(float(portfolio_equity_usd), 4)
    else:
        # fail closed to missing rather than silently publishing fake equity as truth
        equity = None
        notes_err = (notes_err or "") + "|equity_unavailable:no_portfolio_balance"
    delta = None if equity is None else round(equity - START, 4)

    # today PnL vs CT midnight snapshot
    today = datetime.now(CT).date().isoformat()
    st: dict = {}
    if STATE.exists():
        try:
            st = json.loads(STATE.read_text())
        except Exception:
            st = {}
    if equity is not None:
        if st.get("sod_date") != today or st.get("sod_source") != "lab_curve_v3":
            st = {"sod_date": today, "sod_equity": equity, "sod_source": "lab_curve_v3"}
            STATE.write_text(json.dumps(st, indent=2) + "\n")
        sod = float(st.get("sod_equity") or equity)
        today_pnl = round(equity - sod, 4)
    else:
        today_pnl = None

    # equity history append (dedupe if same minute)
    hist: list = []
    if HIST.exists():
        try:
            hist = json.loads(HIST.read_text())
            if not isinstance(hist, list):
                hist = []
        except Exception:
            hist = []
    t = _utc_now()
    if not hist or hist[-1].get("t") != t:
        # skip append if last point < 2.5 min ago and equity unchanged
        append = True
        if hist and equity is not None:
            try:
                last_eq = hist[-1].get("equity_usd")
                last_t = datetime.fromisoformat(str(hist[-1]["t"]).replace("Z", "+00:00"))
                if (
                    last_eq is not None
                    and (datetime.now(timezone.utc) - last_t).total_seconds() < 150
                    and abs(float(last_eq) - float(equity)) < 1e-6
                ):
                    append = False
            except Exception:
                pass
        if append and equity is not None:
            has_break = any(
                isinstance(x, dict) and x.get("marker") == "equity_definition_changed"
                for x in hist
            )
            if not has_break:
                hist.append(
                    {
                        "t": EQUITY_DEFINITION_CHANGED_AT,
                        "equity_usd": None,
                        "marker": "equity_definition_changed",
                        "note": "Switched to lab_curve_v3: Kalshi total minus non-lab; baseline $200",
                    }
                )
            pt = {
                "t": t,
                "equity_usd": equity,
                "source": "lab_curve_v3",
                "definition": "lab_curve_v3",
            }
            hist.append(pt)
    cutoff = datetime.now(timezone.utc) - timedelta(days=14)
    pruned = []
    for pt in hist:
        try:
            pt_t = datetime.fromisoformat(str(pt["t"]).replace("Z", "+00:00"))
            if pt_t >= cutoff:
                pruned.append(pt)
        except Exception:
            pruned.append(pt)
    hist = pruned[-HIST_MAX_POINTS:]
    HIST.write_text(json.dumps(hist, indent=2) + "\n")

    # WP3 optional freshness fields (UI degrades if absent)
    chart_t = None
    for pt in reversed(hist):
        if isinstance(pt, dict) and pt.get("t") and pt.get("equity_usd") is not None:
            chart_t = str(pt.get("t"))
            break
    if chart_t is None and hist:
        chart_t = str(hist[-1].get("t") or "") or None
    equity_history_updated_at = chart_t or t
    reconciliation_updated_at = (
        str(hb.get("last_tick_utc") or "")[:32]
        or _mtime_utc(HB)
        or t
    )
    fill_ts = [str(f.get("ts") or "") for f in fills if f.get("ts")]
    oldest_fill = min(fill_ts) if fill_ts else None
    oldest_input_updated_at = _min_iso(
        oldest_fill,
        _mtime_utc(HB),
        _mtime_utc(YAML),
        _mtime_utc(ALLOWLIST_JSON),
        str(hb.get("last_tick_utc") or "")[:32] or None,
    )

    payload = {
        "updated_at": t,
        "equity_history_updated_at": equity_history_updated_at,
        "reconciliation_updated_at": reconciliation_updated_at,
        "oldest_input_updated_at": oldest_input_updated_at,
        "starting_bankroll_usd": START,
        "equity_usd": equity,
        "lab_equity_usd": lab_equity_usd if lab_equity_usd is not None else equity,
        "portfolio_equity_usd": portfolio_equity_usd_full,
        "portfolio_cash_usd": portfolio_cash_usd,
        "portfolio_positions_usd": portfolio_positions_usd,
        "nonlab_positions_usd": round(float(nonlab_positions_usd or 0), 4),
        "nonlab_legs": nonlab_legs[:20],
        "lab_deposit_usd": LAB_DEPOSIT_USD,
        "lab_deposit_id": LAB_DEPOSIT_ID,
        "lab_deposit_ct": LAB_DEPOSIT_CT,
        "pre_lab_cash_usd": PRE_LAB_CASH_USD,
        "lab_start_ts": LAB_START_TS,
        "lab_synthetic_equity_usd": lab_synthetic_equity_usd,
        "delta_vs_start_usd": delta,
        "today_pnl_usd": today_pnl,
        "realized_lab_pnl_usd": round(realized, 4),
        "unrealized_lab_mtm_usd": round(unrealized, 4),
        "equity_formula": FORMULA,
        "equity_history_note": EQUITY_HISTORY_NOTE,
        "equity_definition_changed_at": EQUITY_DEFINITION_CHANGED_AT,
        "open_usd": round(open_usd, 4),
        "max_open_usd": max_open,
        "remaining_usd": round(remaining, 4),
        "daemon": {
            "alive": alive,
            "heartbeat_age_sec": None if age is None else round(age, 1),
            "pid": hb.get("pid"),
            "pid_alive": pid_alive,
            "mode": mode,
            "kill_file": kill_on or bool(hb.get("kill_file")),
        },
        "allowlist": allowlist,
        "resting_orders": resting[:50],
        "recent_fills": fills,
        "notes": notes_err or hb.get("last_note") or "",
    }
    # Snapshot for Node lab_curve_v4 publisher (accounting truth)
    snap_payload = {
        "publisher_sha": "9983814c28225efbbd7af096efaba99474948b35",
        "portfolio_equity_usd": portfolio_equity_usd_full,
        "portfolio_cash_usd": portfolio_cash_usd,
        "portfolio_positions_usd": portfolio_positions_usd,
        "opening_allocation_verified": True,
        "deposits": [
            {
                "ts": LAB_DEPOSIT_CT,
                "amount_usd": LAB_DEPOSIT_USD,
                "owner": "lab",
                "deposit_id": LAB_DEPOSIT_ID,
                "verified": True,
            }
        ],
        "lab_deposit_ct": LAB_DEPOSIT_CT,
        "lab_deposit_id": LAB_DEPOSIT_ID,
        "lab_start_ts": LAB_START_TS,
        "positions": snap_positions,
        "fills": snap_fills,
        "resting_orders": snap_resting,
        "allowlist": allowlist,
        "nav_bridge_adjustments": [],
    }
    SNAP.write_text(json.dumps(snap_payload, indent=2) + "\n")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUT.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n")
    tmp.replace(OUT)
    print(
        f"wrote {OUT} equity={equity} cash={portfolio_cash_usd} pos={portfolio_positions_usd} lab_synth={lab_synthetic_equity_usd} Δ={delta} today={today_pnl} resting={len(resting)} fills={len(fills)} hist={len(hist)}"
    )


if __name__ == "__main__":
    main()