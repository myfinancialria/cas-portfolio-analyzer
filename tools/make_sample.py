#!/usr/bin/env python3
"""Build docs/data/sample.json — a fabricated demo portfolio wired to REAL
ISINs from the current AMFI snapshot, so "Try sample data" shows live NAVs,
categories and research links without anyone uploading a statement.

Units/costs/transactions are invented (clearly labelled as sample in the UI).

Usage: python tools/make_sample.py
"""

import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SNAPSHOT = ROOT / "docs" / "data" / "amfi.json"

# (search tokens, target monthly SIP ₹, months of SIP, implied gain factor)
# gain factor g means: units are chosen so cost = current_value / (1 + g)
PICKS = [
    (["parag", "parikh", "flexi", "direct", "growth"], 10000, 42, 0.42),
    (["hdfc", "mid cap fund", "direct", "growth"], 7500, 36, 0.55),
    (["nippon", "india", "small", "cap", "direct", "growth"], 5000, 30, 0.34),
    (["axis", "elss", "tax", "direct", "growth"], 5000, 36, 0.18),
    (["uti", "nifty", "50", "index", "direct", "growth"], 6000, 24, 0.21),
    (["icici", "prudential", "balanced", "advantage", "direct", "growth"], 8000, 30, 0.16),
    (["hdfc", "liquid", "direct", "growth"], 0, 0, 0.055),      # lumpsum parking
    (["icici", "prudential", "nasdaq", "100", "direct", "growth"], 4000, 24, -0.08),
    (["sbi", "large cap", "regular", "growth"], 5000, 48, 0.38),  # regular plan on purpose
    (["kotak", "gold", "direct", "growth"], 3000, 18, 0.27),
]

LUMPSUMS = {"hdfc liquid": 300000}


def find(by_isin: dict, tokens: list[str]) -> tuple[str, dict] | None:
    best = None
    for isin, rec in by_isin.items():
        name = rec["name"].lower()
        if all(t in name for t in tokens) and rec.get("nav"):
            if best is None or len(rec["name"]) < len(best[1]["name"]):
                best = (isin, rec)
    return best


def month_seq(n: int, end_year: int, end_month: int):
    y, m = end_year, end_month
    out = []
    for _ in range(n):
        out.append(date(y, m, 5))
        m -= 1
        if m == 0:
            y, m = y - 1, 12
    return list(reversed(out))


def main() -> int:
    snap = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    by_isin = snap["byIsin"]
    holdings = []
    for tokens, sip, months, gain in PICKS:
        hit = find(by_isin, tokens)
        if not hit:
            print(f"WARNING: no match for {tokens}", file=sys.stderr)
            continue
        isin, rec = hit
        nav = rec["nav"]
        if sip and months:
            cost = sip * months
            dates = month_seq(months, 2026, 8)
        else:
            key = " ".join(tokens[:2])
            cost = next(v for k, v in LUMPSUMS.items() if k.startswith(key.split()[0]))
            dates = [date(2025, 11, 14)]
        units = round(cost * (1 + gain) / nav, 3)
        per_amt = round(cost / len(dates), 2)
        per_units = round(units / len(dates), 3)
        txns = [
            {
                "date": d.isoformat(),
                "description": "Systematic Investment" if sip else "Purchase",
                "amount": per_amt,
                "units": per_units,
                "nav": round(per_amt / per_units, 4) if per_units else None,
                "type": "PURCHASE_SIP" if sip else "PURCHASE",
            }
            for d in dates
        ]
        holdings.append(
            {
                "scheme": rec["name"],
                "isin": isin,
                "folio": "SAMPLE/0",
                "amc": rec["amc"],
                "units": units,
                "openingUnits": 0.0,
                "casNav": nav,
                "casNavDate": rec["date"],
                "casValue": round(units * nav, 2),
                "costValue": float(cost),
                "transactions": txns,
            }
        )
        print(f"  {rec['name'][:60]:<62} {isin}  nav={nav}")

    out = {
        "source": "sample",
        "note": "Fabricated demo portfolio using real ISINs/NAVs. Not a real investor.",
        "statementPeriod": {"from": "2022-09-05", "to": "2026-08-31"},
        "holdings": holdings,
    }
    dest = ROOT / "docs" / "data" / "sample.json"
    dest.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {dest} — {len(holdings)} holdings")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
