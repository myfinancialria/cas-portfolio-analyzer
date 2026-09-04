"""Console report (rich) + CSV / JSON / HTML exports."""

from __future__ import annotations

import csv
import json

from rich.console import Console
from rich.panel import Panel
from rich.table import Table


def _inr(v) -> str:
    if v is None:
        return "—"
    neg = v < 0
    s = f"{abs(v):,.0f}"
    # Indian digit grouping
    parts = s.split(",")
    if len(parts) > 1:
        head = "".join(parts[:-1])
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        s = ",".join(groups + [parts[-1]])
    return ("-₹" if neg else "₹") + s


def _pct(v, frac: int = 1) -> str:
    return "—" if v is None else f"{v * 100:.{frac}f}%"


def _signed_pct(v) -> str:
    if v is None:
        return "—"
    color = "green" if v >= 0 else "red"
    return f"[{color}]{'+' if v > 0 else ''}{v * 100:.1f}%[/]"


def _signed_inr(v) -> str:
    if v is None:
        return "—"
    color = "green" if v >= 0 else "red"
    return f"[{color}]{'+' if v > 0 else ''}{_inr(v)}[/]"


def console_report(analysis: dict, console: Console | None = None) -> None:
    c = console or Console()
    t = analysis["totals"]
    period = analysis.get("statementPeriod") or {}
    head = (
        f"Invested [bold]{_inr(t['invested'])}[/]   →   Current [bold]{_inr(t['currentValue'])}[/]   "
        f"Gain {_signed_inr(t['gain'])} ({_signed_pct(t['gainPct'])})   "
        f"Portfolio XIRR {_signed_pct(t['portfolioXirr'])}"
    )
    sub = f"Statement: {period.get('from', '?')} → {period.get('to', '?')} · parsed as {analysis.get('source')}"
    c.print(Panel(head, title="CAS Portfolio Analyzer", subtitle=sub))

    alloc = Table(title="Category bifurcation", show_lines=False)
    for col, justify in [("Category", "left"), ("Funds", "right"), ("Invested", "right"), ("Value", "right"), ("Gain", "right"), ("Weight", "right")]:
        alloc.add_column(col, justify=justify)
    for b in analysis["buckets"]:
        alloc.add_row(b["bucket"], str(b["count"]), _inr(b["invested"]), _inr(b["value"]), _signed_inr(b["gain"]), _pct(b["weight"]))
    c.print(alloc)

    for b in analysis["buckets"]:
        tbl = Table(title=f"{b['bucket']} — {_inr(b['value'])} ({_pct(b['weight'])})")
        for col, justify in [
            ("Scheme", "left"), ("Units", "right"), ("NAV", "right"), ("Invested", "right"),
            ("Value", "right"), ("Gain", "right"), ("XIRR", "right"), ("1Y", "right"), ("3Y", "right"), ("5Y", "right"),
        ]:
            tbl.add_column(col, justify=justify, overflow="fold")
        rows = sorted((r for r in analysis["rows"] if r["bucket"] == b["bucket"]), key=lambda r: -(r["currentValue"] or 0))
        for r in rows:
            cagr = r.get("cagr") or {}
            tbl.add_row(
                r["displayName"],
                f"{r['units']:,.3f}",
                f"{r['latestNav']:,.4f}" if r.get("latestNav") else "—",
                _inr(r.get("cost")),
                _inr(r.get("currentValue")),
                f"{_signed_inr(r.get('gain'))} ({_signed_pct(r.get('gainPct'))})",
                _signed_pct(r.get("xirr")),
                _pct(cagr.get("r1")),
                _pct(cagr.get("r3")),
                _pct(cagr.get("r5")),
            )
        c.print(tbl)

    if analysis.get("tax"):
        tax = analysis["tax"]
        c.print(
            Panel(
                f"Unrealized LTCG (est.): {_signed_inr(tax['ltGain'])}    Unrealized STCG (est.): {_signed_inr(tax['stGain'])}\n"
                "[dim]Equity-taxed holdings only, FIFO lots at latest NAV. Verify with a CA — rates and rules change.[/dim]",
                title="Capital gains snapshot",
            )
        )

    if analysis["insights"]:
        c.print("[bold]Observations[/] [dim](rule-based, not advice)[/]")
        for i in analysis["insights"]:
            icon = "⚠️ " if i["level"] == "flag" else "ℹ️ "
            c.print(f"  {icon} {i['text']}")

    c.print(
        "\n[dim]Research each fund: ValueResearch · RupeeVest · Tickertape · Morningstar · Moneycontrol "
        "(links included in --json/--html/--csv exports). Educational output, not investment advice.[/dim]"
    )


def write_json(analysis: dict, path: str) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(analysis, fh, ensure_ascii=False, indent=2, default=str)


def write_csv(analysis: dict, path: str) -> None:
    cols = [
        "displayName", "isin", "folio", "bucket", "subCategory", "units", "latestNav",
        "latestNavDate", "cost", "currentValue", "gain", "gainPct", "xirr", "cagr1y", "cagr3y", "cagr5y",
        "valueresearch", "rupeevest", "tickertape", "morningstar", "moneycontrol",
    ]
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(cols)
        for r in analysis["rows"]:
            cagr = r.get("cagr") or {}
            links = {l["label"].lower(): l["url"] for l in r.get("links", [])}
            w.writerow(
                [
                    r["displayName"], r.get("isin"), r.get("folio"), r["bucket"], r.get("subCategory"),
                    r["units"], r.get("latestNav"), r.get("latestNavDate"), r.get("cost"),
                    r.get("currentValue"), r.get("gain"), r.get("gainPct"), r.get("xirr"),
                    cagr.get("r1"), cagr.get("r3"), cagr.get("r5"),
                    links.get("valueresearch"), links.get("rupeevest"), links.get("tickertape"),
                    links.get("morningstar"), links.get("moneycontrol"),
                ]
            )


def write_html(analysis: dict, path: str) -> None:
    """Standalone single-file HTML report (no JS, printable)."""
    t = analysis["totals"]

    def esc(s) -> str:
        return str(s if s is not None else "—").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    def signed(v, f) -> str:
        if v is None:
            return "—"
        cls = "pos" if v >= 0 else "neg"
        return f'<span class="{cls}">{"+" if v > 0 else ""}{f(v)}</span>'

    rows_html = ""
    for b in analysis["buckets"]:
        rows_html += f'<tr class="bucket"><td colspan="8">{esc(b["bucket"])} — {_inr(b["value"])} ({_pct(b["weight"])})</td></tr>'
        for r in sorted((r for r in analysis["rows"] if r["bucket"] == b["bucket"]), key=lambda r: -(r["currentValue"] or 0)):
            cagr = r.get("cagr") or {}
            links = " · ".join(f'<a href="{esc(l["url"])}">{esc(l["label"])}</a>' for l in r.get("links", []))
            nav_cell = f"{r['latestNav']:,.4f}" if r.get("latestNav") else "—"
            rows_html += (
                f"<tr><td>{esc(r['displayName'])}<div class='links'>{links}</div></td>"
                f"<td class='r'>{r['units']:,.3f}</td>"
                f"<td class='r'>{nav_cell}</td>"
                f"<td class='r'>{_inr(r.get('cost'))}</td><td class='r'>{_inr(r.get('currentValue'))}</td>"
                f"<td class='r'>{signed(r.get('gain'), _inr)}</td>"
                f"<td class='r'>{signed(r.get('xirr'), lambda v: _pct(v))}</td>"
                f"<td class='r'>{_pct(cagr.get('r1'))} / {_pct(cagr.get('r3'))} / {_pct(cagr.get('r5'))}</td></tr>"
            )

    insights = "".join(f"<li>{esc(i['text'])}</li>" for i in analysis["insights"])
    html = f"""<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>CAS Portfolio Report</title>
<style>body{{font-family:-apple-system,Segoe UI,Roboto,sans-serif;margin:32px;color:#1a1a2e}}
h1{{color:#1b3a6b}}table{{border-collapse:collapse;width:100%;font-size:13px}}
td,th{{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left}}.r{{text-align:right;white-space:nowrap}}
tr.bucket td{{background:#f0f3f8;font-weight:700}}.pos{{color:#1e8e4e}}.neg{{color:#d43f3f}}
.links{{font-size:11px}}.links a{{color:#1b3a6b}}footer{{margin-top:24px;font-size:12px;color:#666}}</style></head><body>
<h1>CAS Portfolio Report</h1>
<p>Invested <b>{_inr(t['invested'])}</b> → Current <b>{_inr(t['currentValue'])}</b> ·
Gain {signed(t['gain'], _inr)} ({signed(t['gainPct'], lambda v: _pct(v))}) ·
Portfolio XIRR {signed(t['portfolioXirr'], lambda v: _pct(v))} · Generated {esc(analysis['generatedAt'])}</p>
<table><thead><tr><th>Scheme</th><th class="r">Units</th><th class="r">NAV</th><th class="r">Invested</th>
<th class="r">Value</th><th class="r">Gain</th><th class="r">XIRR</th><th class="r">1Y / 3Y / 5Y CAGR</th></tr></thead>
<tbody>{rows_html}</tbody></table>
{f'<h2>Observations</h2><ul>{insights}</ul>' if insights else ''}
<footer>Data: AMFI (latest NAV, category), api.mfapi.in (NAV history). Research links: ValueResearch, RupeeVest,
Tickertape, Morningstar, Moneycontrol. Educational report — not SEBI-registered investment advice, not tax advice.</footer>
</body></html>"""
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(html)
