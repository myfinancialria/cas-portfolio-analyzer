"""Command-line interface.

    cas-analyzer report MyCAS.pdf -p PANXXXXXX
    cas-analyzer report cas.json --csv out.csv --html report.html
"""

from __future__ import annotations

import argparse
import json
import sys

from rich.console import Console

from . import __version__
from .amfi import load_snapshot
from .analyze import add_peer_comparison, analyze
from .mfapi import enrich_performance
from .model import load_statement
from .report import console_report, write_csv, write_html, write_json


def _read_statement(path: str, password: str | None) -> dict:
    if path.lower().endswith(".json"):
        with open(path, encoding="utf-8") as fh:
            return load_statement(json.load(fh))
    try:
        import casparser  # noqa: PLC0415 - heavy import, only needed for PDFs
    except ImportError:
        raise SystemExit(
            "PDF parsing needs the `casparser` package: pip install casparser\n"
            "Alternatively convert the PDF yourself (`casparser file.pdf -o out.json`) "
            "and pass the JSON to this tool."
        ) from None
    data = casparser.read_cas_pdf(path, password or "", output="dict")
    return load_statement(json.loads(json.dumps(data, default=str)))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="cas-analyzer",
        description="Analyze an Indian mutual-fund CAS: category bifurcation, latest NAV, "
        "gains, XIRR, CAGR, and research links (ValueResearch / RupeeVest / Tickertape / "
        "Morningstar / Moneycontrol). Educational output, not investment advice.",
    )
    ap.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = ap.add_subparsers(dest="cmd", required=True)
    rep = sub.add_parser("report", help="Analyze a CAS PDF (CAMS/KFintech) or casparser JSON")
    rep.add_argument("file", help="CAS PDF or JSON (casparser output / this tool's format)")
    rep.add_argument("-p", "--password", help="PDF password (usually your PAN)")
    rep.add_argument("--json", dest="json_out", metavar="PATH", help="write full analysis JSON")
    rep.add_argument("--csv", dest="csv_out", metavar="PATH", help="write holdings CSV")
    rep.add_argument("--html", dest="html_out", metavar="PATH", help="write standalone HTML report")
    rep.add_argument("--offline", action="store_true", help="no network: use cached AMFI data, skip CAGR")
    rep.add_argument("--no-perf", action="store_true", help="skip NAV-history CAGR fetch")

    args = ap.parse_args(argv)
    console = Console()

    statement = _read_statement(args.file, args.password)
    if not statement["holdings"]:
        console.print("[red]No open holdings found in this statement.[/red]")
        return 1

    amfi_by_isin: dict = {}
    if args.offline:
        try:
            amfi_by_isin = load_snapshot(max_age_hours=24 * 365)["byIsin"]
        except Exception:
            console.print("[yellow]--offline and no cached AMFI snapshot — using CAS-embedded NAVs.[/yellow]")
    else:
        try:
            amfi_by_isin = load_snapshot()["byIsin"]
        except Exception as exc:  # noqa: BLE001
            console.print(f"[yellow]AMFI download failed ({exc}) — using CAS-embedded NAVs.[/yellow]")

    analysis = analyze(statement, amfi_by_isin)

    if not args.offline and not args.no_perf:
        with console.status("Fetching NAV histories from api.mfapi.in for CAGR…"):
            enrich_performance(analysis)
        add_peer_comparison(analysis)

    console_report(analysis, console)

    if args.json_out:
        write_json(analysis, args.json_out)
        console.print(f"[dim]JSON written to {args.json_out}[/dim]")
    if args.csv_out:
        write_csv(analysis, args.csv_out)
        console.print(f"[dim]CSV written to {args.csv_out}[/dim]")
    if args.html_out:
        write_html(analysis, args.html_out)
        console.print(f"[dim]HTML written to {args.html_out}[/dim]")
    return 0


if __name__ == "__main__":
    sys.exit(main())
