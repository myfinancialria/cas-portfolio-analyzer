"""NAV history via api.mfapi.in (community mirror of AMFI data, keyless)."""

from __future__ import annotations

import datetime as dt
import json
import urllib.request
from concurrent.futures import ThreadPoolExecutor


def fetch_history(code: str, timeout: int = 30) -> list[tuple[dt.date, float]]:
    req = urllib.request.Request(
        f"https://api.mfapi.in/mf/{code}", headers={"User-Agent": "cas-portfolio-analyzer/1.0"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        obj = json.load(resp)
    rows = []
    for r in obj.get("data", []):
        try:
            d = dt.datetime.strptime(r["date"], "%d-%m-%Y").date()
            nav = float(r["nav"])
        except (ValueError, KeyError):
            continue
        if nav > 0:
            rows.append((d, nav))
    rows.sort(key=lambda x: x[0], reverse=True)  # newest first
    return rows


def cagr_from(rows: list[tuple[dt.date, float]], years: float) -> float | None:
    if len(rows) < 2:
        return None
    latest_d, latest_nav = rows[0]
    target = latest_d - dt.timedelta(days=round(years * 365.25))
    past = next(((d, n) for d, n in rows if d <= target), None)
    if not past:
        return None
    actual_years = (latest_d - past[0]).days / 365.25
    if actual_years < years * 0.9:
        return None
    return (latest_nav / past[1]) ** (1 / actual_years) - 1


def enrich_performance(analysis: dict, workers: int = 6) -> None:
    rows = [r for r in analysis["rows"] if r.get("amfiCode")]

    def one(r: dict) -> None:
        try:
            hist = fetch_history(r["amfiCode"])
            r["cagr"] = {"r1": cagr_from(hist, 1), "r3": cagr_from(hist, 3), "r5": cagr_from(hist, 5)}
        except Exception:  # noqa: BLE001 - a fund without history is not fatal
            r["cagr"] = None

    with ThreadPoolExecutor(max_workers=workers) as ex:
        list(ex.map(one, rows))
