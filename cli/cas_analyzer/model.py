"""Normalization of parsed statements into one internal shape.

Sources: casparser output (dict/JSON) for PDFs, or this project's own JSON
(the web app's sample/export format).
"""

from __future__ import annotations

from typing import Any


def _f(v) -> float | None:
    if v is None:
        return None
    try:
        return float(str(v).replace(",", ""))
    except ValueError:
        return None


def _txn(t: dict) -> dict:
    return {
        "date": str(t.get("date")) if t.get("date") else None,
        "description": t.get("description"),
        "amount": _f(t.get("amount")),
        "units": _f(t.get("units")),
        "nav": _f(t.get("nav")),
        "type": t.get("type"),
    }


def from_casparser(data: dict) -> dict:
    holdings = []
    for folio in data.get("folios", []):
        for s in folio.get("schemes", []):
            close = _f(s.get("close"))
            if not close or close <= 0:
                continue
            val = s.get("valuation") or {}
            holdings.append(
                {
                    "scheme": s.get("scheme"),
                    "isin": s.get("isin"),
                    "amfiCode": str(s["amfi"]) if s.get("amfi") else None,
                    "folio": folio.get("folio"),
                    "amc": folio.get("amc") or s.get("amc"),
                    "openingUnits": _f(s.get("open")),
                    "units": close,
                    "casNav": _f(val.get("nav")),
                    "casNavDate": str(val.get("date")) if val.get("date") else None,
                    "casValue": _f(val.get("value")),
                    "costValue": _f(val.get("cost")),
                    "transactions": [_txn(t) for t in s.get("transactions", [])],
                }
            )
    period = data.get("statement_period") or {}
    return {
        "source": "casparser",
        "statementPeriod": {"from": str(period.get("from") or ""), "to": str(period.get("to") or "")},
        "holdings": holdings,
    }


def from_internal(data: dict) -> dict:
    return {
        "source": data.get("source", "json"),
        "statementPeriod": data.get("statementPeriod"),
        "holdings": [
            {
                "scheme": h.get("scheme"),
                "isin": h.get("isin"),
                "amfiCode": h.get("amfiCode"),
                "folio": h.get("folio"),
                "amc": h.get("amc"),
                "openingUnits": _f(h.get("openingUnits")),
                "units": _f(h.get("units")),
                "casNav": _f(h.get("casNav")),
                "casNavDate": h.get("casNavDate"),
                "casValue": _f(h.get("casValue")),
                "costValue": _f(h.get("costValue")),
                "transactions": [_txn(t) for t in h.get("transactions", [])],
            }
            for h in data.get("holdings", [])
            if _f(h.get("units"))
        ],
    }


def load_statement(obj: Any) -> dict:
    if isinstance(obj, dict) and "folios" in obj:
        return from_casparser(obj)
    if isinstance(obj, dict) and "holdings" in obj:
        return from_internal(obj)
    raise ValueError("Unrecognized statement JSON: expected casparser output or internal format.")
