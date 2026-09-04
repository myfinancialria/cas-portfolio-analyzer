"""AMFI NAVAll parsing — the authoritative source for scheme category + latest NAV.

Stdlib-only on purpose: the GitHub Action that refreshes the NAV snapshot imports
this module without installing any dependencies.
"""

from __future__ import annotations

import json
import os
import re
import time
import urllib.request
from datetime import datetime, timezone

AMFI_URLS = [
    "https://portal.amfiindia.com/spages/NAVAll.txt",
    "https://www.amfiindia.com/spages/NAVAll.txt",
]

# "Open Ended Schemes(Equity Scheme - Flexi Cap Fund)"
_SECTION_RE = re.compile(r"^(?P<type>[^(;]+?)\s*\(\s*(?P<inner>[^)]+)\)\s*$")
_ISIN_RE = re.compile(r"^IN[A-Z0-9]{10}$")


def fetch_navall(timeout: int = 60) -> str:
    last_err: Exception | None = None
    for url in AMFI_URLS:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "cas-portfolio-analyzer/1.0"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read().decode("utf-8", errors="replace")
        except Exception as exc:  # noqa: BLE001 - try the mirror before giving up
            last_err = exc
    raise RuntimeError(f"Could not download AMFI NAVAll.txt: {last_err}")


def _parse_date(raw: str) -> str:
    try:
        return datetime.strptime(raw.strip(), "%d-%b-%Y").date().isoformat()
    except ValueError:
        return raw.strip()


def parse_navall(text: str) -> dict[str, dict]:
    """Parse NAVAll.txt into {isin: record}.

    Handles both the current 8-column layout
    (Code;ISIN1;ISIN2;Name;Plan;Option;NAV;Date) and the legacy 6-column layout
    (Code;ISIN1;ISIN2;Name;NAV;Date). Section headers carry the SEBI scheme
    category; bare lines in between carry the AMC name.
    """
    by_isin: dict[str, dict] = {}
    scheme_type = category = subcategory = amc = ""

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.lower().startswith("scheme code;"):
            continue

        if ";" not in line:
            m = _SECTION_RE.match(line)
            if m:
                scheme_type = m.group("type").strip()
                inner = m.group("inner").strip()
                if " - " in inner:
                    category, subcategory = (p.strip() for p in inner.split(" - ", 1))
                else:
                    category, subcategory = inner, ""
            else:
                amc = line
            continue

        parts = [p.strip() for p in line.split(";")]
        if len(parts) == 8:
            code, isin1, isin2, name, plan, option, nav, date = parts
            display = name
            if plan and plan != "-":
                display += f" - {plan}"
            if option and option != "-":
                display += f" - {option}"
        elif len(parts) == 6:
            code, isin1, isin2, name, nav, date = parts
            display = name
        else:
            continue

        try:
            nav_val = float(nav.replace(",", ""))
        except ValueError:
            nav_val = None
        record = {
            "code": code,
            "name": display,
            "nav": nav_val,
            "date": _parse_date(date),
            "type": scheme_type,
            "cat": category,
            "sub": subcategory,
            "amc": amc,
        }
        for isin in (isin1, isin2):
            if _ISIN_RE.match(isin or ""):
                by_isin[isin] = record
    return by_isin


def build_snapshot(text: str | None = None) -> dict:
    if text is None:
        text = fetch_navall()
    by_isin = parse_navall(text)
    return {
        "meta": {
            "source": "AMFI NAVAll.txt (amfiindia.com)",
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "schemes": len(by_isin),
        },
        "byIsin": by_isin,
    }


def load_snapshot(cache_dir: str | None = None, max_age_hours: float = 20.0) -> dict:
    """Snapshot with a local cache so repeat CLI runs don't re-download ~4 MB."""
    cache_dir = cache_dir or os.path.join(
        os.path.expanduser("~"), ".cache", "cas-portfolio-analyzer"
    )
    os.makedirs(cache_dir, exist_ok=True)
    cache_path = os.path.join(cache_dir, "amfi.json")
    if os.path.exists(cache_path):
        age_h = (time.time() - os.path.getmtime(cache_path)) / 3600
        if age_h < max_age_hours:
            with open(cache_path, encoding="utf-8") as fh:
                return json.load(fh)
    snap = build_snapshot()
    with open(cache_path, "w", encoding="utf-8") as fh:
        json.dump(snap, fh, ensure_ascii=False)
    return snap
