"""Research deep-links. ValueResearch, RupeeVest, Morningstar and Moneycontrol
have no public APIs (and actively block scrapers), so the honest integration is
a reliable site-scoped search link per fund on each platform."""

from __future__ import annotations

import re
from urllib.parse import quote_plus

SITES = [
    ("ValueResearch", "valueresearchonline.com"),
    ("RupeeVest", "rupeevest.com"),
    ("Tickertape", "tickertape.in"),
    ("Morningstar", "morningstar.in"),
    ("Moneycontrol", "moneycontrol.com"),
]


def clean_scheme_name(name: str) -> str:
    n = name or ""
    n = re.sub(r"\(formerly[^)]*\)", " ", n, flags=re.I)
    n = re.sub(r"[-\s(]*\b(direct|regular)\b.*$", " ", n, flags=re.I)
    n = re.sub(r"\b(growth|idcw|dividend|payout|reinvest(?:ment)?|option|plan)\b", " ", n, flags=re.I)
    n = re.sub(r"[^\w&' -]", " ", n)
    return re.sub(r"\s+", " ", n).strip()


def research_links(name: str) -> list[dict]:
    q = quote_plus(clean_scheme_name(name))
    return [
        {"label": label, "url": f"https://www.google.com/search?q={q}+site%3A{site}"}
        for label, site in SITES
    ]
