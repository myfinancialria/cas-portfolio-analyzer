"""Analytics: category bifurcation, latest-NAV marking, gains, XIRR, FIFO tax
split, and rule-based observations. Mirrors docs/js/enrich.js — keep in sync."""

from __future__ import annotations

import datetime as dt
import re
import statistics
from typing import Iterable

from .links import research_links

BUCKETS = [
    "Equity", "Hybrid", "Debt", "Index & ETF", "International",
    "Gold & Commodity", "Solution Oriented", "Other",
]
EQUITY_TAXED = {"Equity", "Index & ETF", "Solution Oriented"}
DAY_MS = 86400.0


def bucket_of(rec: dict | None, scheme_name: str) -> str:
    cat = ((rec or {}).get("cat") or "").lower()
    sub = ((rec or {}).get("sub") or "").lower()
    name = (scheme_name or "").lower()
    sub_name = f"{sub} {name}"
    everything = f"{cat} {sub} {name}"

    if re.search(r"\bgold\b|\bsilver\b|commodit", sub_name):
        return "Gold & Commodity"
    if re.search(r"fof.*overseas|overseas|nasdaq|s&p ?500|\bus\b|global|international|world|hang seng|china|taiwan", sub_name):
        return "International"
    if re.search(r"index|etf", sub) or ("other" in cat and re.search(r"index|etf", name)):
        return "Index & ETF"
    if "solution" in cat or re.search(r"retirement|children", sub):
        return "Solution Oriented"
    if "equity" in cat or cat == "growth" or "elss" in sub:
        return "Equity"
    if re.search(r"hybrid|balanced", everything):
        return "Hybrid"
    if re.search(r"debt|income|idf|gilt|money market|liquid|overnight|floater|duration|bond", everything):
        return "Debt"
    if re.search(r"index|etf", name):
        return "Index & ETF"
    return "Other"


def _parse_date(s: str | None) -> dt.date | None:
    if not s:
        return None
    for fmt in ("%Y-%m-%d", "%d-%b-%Y", "%d-%m-%Y"):
        try:
            return dt.datetime.strptime(s[:11].strip(), fmt).date()
        except ValueError:
            continue
    return None


def xirr(flows: list[tuple[dt.date, float]]) -> float | None:
    """Bisection XIRR. Flows: investments negative, redemptions/terminal positive."""
    if len(flows) < 2:
        return None
    if not any(a < 0 for _, a in flows) or not any(a > 0 for _, a in flows):
        return None
    t0 = flows[0][0]

    def npv(r: float) -> float:
        return sum(a / (1 + r) ** ((d - t0).days / 365.0) for d, a in flows)

    lo, hi = -0.9999, 10.0
    flo, fhi = npv(lo), npv(hi)
    if flo * fhi > 0:
        return None
    for _ in range(200):
        mid = (lo + hi) / 2
        fm = npv(mid)
        if abs(fm) < 1e-7:
            return mid
        if flo * fm < 0:
            hi = mid
        else:
            lo, flo = mid, fm
    return (lo + hi) / 2


def holding_flows(h: dict, current_value: float | None, as_of: dt.date) -> list[tuple[dt.date, float]] | None:
    txns = h.get("transactions") or []
    if not txns or current_value is None:
        return None
    if (h.get("openingUnits") or 0) > 0.0005:  # statement window didn't start at zero units
        return None
    flows = [
        (_parse_date(t["date"]), -t["amount"])
        for t in txns
        if t.get("date") and t.get("amount")
    ]
    flows = [(d, a) for d, a in flows if d]
    if not flows:
        return None
    flows.append((as_of, current_value))
    flows.sort(key=lambda x: x[0])
    return flows


def fifo_lots(txns: Iterable[dict]) -> tuple[list[dict], float]:
    lots: list[dict] = []
    ordered = sorted(
        (t for t in (txns or []) if t.get("date")),
        key=lambda t: _parse_date(t["date"]) or dt.date.min,
    )
    for t in ordered:
        amt, units = t.get("amount") or 0.0, t.get("units")
        d = _parse_date(t["date"])
        if units and units > 0 and amt > 0:
            lots.append({"date": d, "units": units, "cost": amt})
        elif units and units < 0:
            to_sell = -units
            while to_sell > 1e-6 and lots:
                lot = lots[0]
                take = min(lot["units"], to_sell)
                lot["cost"] *= (lot["units"] - take) / lot["units"]
                lot["units"] -= take
                to_sell -= take
                if lot["units"] <= 1e-6:
                    lots.pop(0)
    return lots, sum(l["cost"] for l in lots)


def tax_split(lots: list[dict], latest_nav: float, as_of: dt.date) -> dict:
    lt_gain = st_gain = 0.0
    for lot in lots:
        gain = lot["units"] * latest_nav - lot["cost"]
        if (as_of - lot["date"]).days > 365:
            lt_gain += gain
        else:
            st_gain += gain
    return {"ltGain": lt_gain, "stGain": st_gain}


def analyze(statement: dict, amfi_by_isin: dict) -> dict:
    today = dt.date.today()
    rows = []
    for h in statement["holdings"]:
        rec = amfi_by_isin.get(h.get("isin") or "")
        latest_nav = (rec or {}).get("nav") or h.get("casNav")
        latest_nav_date = (rec or {}).get("date") if (rec or {}).get("nav") else h.get("casNavDate")
        current_value = h["units"] * latest_nav if latest_nav else h.get("casValue")
        lots, remaining_cost = fifo_lots(h.get("transactions"))
        cost = h.get("costValue") if h.get("costValue") is not None else (remaining_cost or None)
        gain = current_value - cost if (cost is not None and current_value is not None) else None
        gain_pct = gain / cost if (gain is not None and cost) else None
        bucket = bucket_of(rec, h["scheme"])
        flows = holding_flows(h, current_value, today)
        tax = None
        if lots and latest_nav:
            tax = tax_split(lots, latest_nav, today)
            tax["equityTaxed"] = bucket in EQUITY_TAXED
        display = (rec or {}).get("name") or h["scheme"]
        rows.append(
            {
                **h,
                "matched": rec is not None,
                "amfiCode": (rec or {}).get("code") or h.get("amfiCode"),
                "displayName": display,
                "bucket": bucket,
                "subCategory": (rec or {}).get("sub"),
                "amcName": (rec or {}).get("amc") or h.get("amc"),
                "latestNav": latest_nav,
                "latestNavDate": latest_nav_date,
                "currentValue": current_value,
                "cost": cost,
                "gain": gain,
                "gainPct": gain_pct,
                "xirr": xirr(flows) if flows else None,
                "tax": tax,
                "links": research_links(display),
                "cagr": None,
            }
        )

    invested = sum(r["cost"] or 0 for r in rows)
    current_value = sum(r["currentValue"] or 0 for r in rows)
    gain = current_value - invested

    buckets = []
    for b in BUCKETS:
        rs = [r for r in rows if r["bucket"] == b]
        if not rs:
            continue
        binv = sum(r["cost"] or 0 for r in rs)
        bval = sum(r["currentValue"] or 0 for r in rs)
        buckets.append(
            {
                "bucket": b,
                "count": len(rs),
                "invested": binv,
                "value": bval,
                "gain": bval - binv,
                "weight": bval / current_value if current_value else 0,
            }
        )
    buckets.sort(key=lambda x: -x["value"])

    pf_flows: list[tuple[dt.date, float]] = []
    covered = 0.0
    for r in rows:
        f = holding_flows(r, r["currentValue"], today)
        if f:
            pf_flows.extend(f)
            covered += r["currentValue"] or 0
    pf_flows.sort(key=lambda x: x[0])
    portfolio_xirr = xirr(pf_flows) if pf_flows else None

    eq_tax_rows = [r for r in rows if r["tax"] and r["tax"]["equityTaxed"]]
    tax_agg = (
        {
            "ltGain": sum(r["tax"]["ltGain"] for r in eq_tax_rows),
            "stGain": sum(r["tax"]["stGain"] for r in eq_tax_rows),
        }
        if eq_tax_rows
        else None
    )

    analysis = {
        "generatedAt": dt.datetime.now().isoformat(timespec="seconds"),
        "source": statement.get("source"),
        "statementPeriod": statement.get("statementPeriod"),
        "rows": rows,
        "totals": {
            "invested": invested,
            "currentValue": current_value,
            "gain": gain,
            "gainPct": gain / invested if invested else None,
            "portfolioXirr": portfolio_xirr,
            "xirrCoverage": covered / current_value if current_value else 0,
        },
        "buckets": buckets,
        "tax": tax_agg,
        "insights": [],
    }
    analysis["insights"] = build_insights(rows, buckets, current_value)
    return analysis


def build_insights(rows: list[dict], buckets: list[dict], total_value: float) -> list[dict]:
    out: list[dict] = []
    if not total_value:
        return out
    for r in rows:
        w = (r["currentValue"] or 0) / total_value
        if w > 0.15:
            out.append({"level": "flag", "text": f"{r['displayName']} is {w * 100:.1f}% of the portfolio — single-fund concentration above the common 15% comfort line."})
    by_amc: dict[str, float] = {}
    for r in rows:
        by_amc[r.get("amcName") or "Unknown AMC"] = by_amc.get(r.get("amcName") or "Unknown AMC", 0) + (r["currentValue"] or 0)
    for amc, v in by_amc.items():
        if v / total_value > 0.30:
            out.append({"level": "flag", "text": f"{amc} manages {v / total_value * 100:.1f}% of the portfolio — AMC concentration above 30%."})
    by_sub: dict[str, list[str]] = {}
    for r in rows:
        if r.get("subCategory"):
            by_sub.setdefault(r["subCategory"], []).append(r["displayName"])
    for sub, names in by_sub.items():
        if len(names) > 3:
            out.append({"level": "info", "text": f"{len(names)} funds in the same sub-category ({sub}) — portfolios likely overlap; compare them side-by-side on ValueResearch or RupeeVest."})
    regular = [r for r in rows if re.search(r"regular", r["displayName"], re.I)]
    if regular:
        names = ", ".join(r["displayName"].split(" - ")[0] for r in regular)
        out.append({"level": "info", "text": f"{len(regular)} holding(s) are Regular plans ({names}). Direct plans of the same schemes typically carry lower expense ratios."})
    eq = next((b for b in buckets if b["bucket"] == "Equity"), None)
    if eq and eq["value"]:
        small_mid = sum((r["currentValue"] or 0) for r in rows if r["bucket"] == "Equity" and re.search(r"small|mid", r.get("subCategory") or "", re.I))
        if small_mid / eq["value"] > 0.4:
            out.append({"level": "flag", "text": f"Small & mid-cap funds are {small_mid / eq['value'] * 100:.0f}% of the equity allocation (>40%) — expect higher volatility than a large-cap-tilted mix."})
    unmatched = [r for r in rows if not r["matched"]]
    if unmatched:
        out.append({"level": "info", "text": f"{len(unmatched)} holding(s) could not be matched to the AMFI list — their values use the NAV printed in the CAS."})
    return out


def add_peer_comparison(analysis: dict) -> None:
    """After CAGRs are loaded: flag funds trailing the median 3Y CAGR of the
    statement's own funds in the same bucket by more than 3pp (needs >= 3)."""
    by_bucket: dict[str, list[dict]] = {}
    for r in analysis["rows"]:
        if r.get("cagr") and r["cagr"].get("r3") is not None:
            by_bucket.setdefault(r["bucket"], []).append(r)
    for bucket, rs in by_bucket.items():
        if len(rs) < 3:
            continue
        med = statistics.median(r["cagr"]["r3"] for r in rs)
        for r in rs:
            if r["cagr"]["r3"] < med - 0.03:
                analysis["insights"].append(
                    {
                        "level": "flag",
                        "text": f"{r['displayName']}: 3Y CAGR {r['cagr']['r3'] * 100:.1f}% trails the median of your own {bucket} funds ({med * 100:.1f}%) by over 3pp — worth a deeper look on ValueResearch/Tickertape.",
                    }
                )
