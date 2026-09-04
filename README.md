# 📊 CAS Portfolio Analyzer

Analyze an Indian mutual-fund **Consolidated Account Statement (CAS)** — CAMS / KFintech PDF —
and get, in seconds:

- **Category bifurcation** — Equity / Debt / Hybrid / Index & ETF / International / Gold /
  Solution-Oriented, using official **AMFI** scheme categories (SEBI taxonomy), with allocation
  weights and a donut chart.
- **Latest NAV & gain/loss** — every holding marked to the latest AMFI NAV (not the stale NAV
  printed in the CAS), with invested vs current value, absolute gain % and **XIRR** (per fund and
  portfolio-level, from the transaction history in a detailed CAS).
- **Performance context** — 1Y / 3Y / 5Y CAGR computed from full NAV history
  ([api.mfapi.in](https://www.mfapi.in/), AMFI-sourced), plus rule-based observations:
  concentration flags, category overlap, Regular-plan detection, small/mid-cap tilt, and funds
  trailing the median of your own funds in the same category.
- **Research links** — one-click links for every fund to **ValueResearch, RupeeVest, Tickertape,
  Morningstar India and Moneycontrol**. (None of these platforms offer public APIs — the tool
  computes what it can from official NAV data and links you to them for ratings, risk grades and
  portfolio X-rays, rather than scraping them.)
- **Capital-gains snapshot** — FIFO-lot estimate of unrealized LTCG vs STCG for equity-taxed
  holdings (clearly labelled an estimate).

Two ways to use it:

| | |
|---|---|
| 🌐 **Web app** | **<https://myfinancialria.github.io/cas-portfolio-analyzer/>** — everything runs in your browser. **Your PDF is never uploaded**; the only network calls are anonymous scheme-code lookups for NAV data. |
| 💻 **Python CLI** | `casparser`-powered terminal report with CSV / JSON / HTML export. |

> 🔒 **Privacy:** a CAS contains your PAN, email and full holdings. The web app parses the PDF
> with pdf.js **inside your browser** and sends nothing anywhere. The CLI runs entirely on your
> machine. The repo's NAV snapshot contains only public AMFI data.

---

## Web app

1. Open **<https://myfinancialria.github.io/cas-portfolio-analyzer/>**.
2. Get your CAS: [CAMS → Statements → CAS](https://www.camsonline.com/Investors/Statements/Consolidated-Account-Statement)
   (or KFintech). Choose **Detailed**, **since your first investment date** (e.g. 01-Jan-1990) —
   that unlocks XIRR and the LTCG/STCG estimate. A **Summary** CAS also works (values only).
3. Drop the PDF, enter its password if protected, done. Or press **“Try with sample data”** to see
   the output instantly.
4. Export the analysis as CSV / JSON, or print to PDF.

Supported: CAMS/KFintech mail-back CAS (detailed & summary) and
[casparser](https://github.com/codereverser/casparser) JSON. Not yet: NSDL/CDSL depository e-CAS
(different layout — convert via casparser and drop the JSON). If a PDF variant fails to parse, use
**“Show extracted text”** on the page and open an issue with a redacted sample of the layout.

## CLI

```bash
pip install git+https://github.com/myfinancialria/cas-portfolio-analyzer#subdirectory=cli

cas-analyzer report MyCAS.pdf -p MYPAN1234X
cas-analyzer report MyCAS.pdf -p MYPAN1234X --csv holdings.csv --html report.html --json full.json
cas-analyzer report casparser-output.json      # also accepts casparser JSON
cas-analyzer report MyCAS.pdf --offline        # cached AMFI data, skip CAGR fetch
```

## How it works

```
CAS PDF ──► parse (pdf.js in-browser / casparser in CLI)
        ──► ISIN ──► AMFI NAVAll snapshot ──► SEBI category + latest NAV ──► gains, buckets
        ──► transactions ──► XIRR (bisection) + FIFO lots ──► LTCG/STCG estimate
        ──► AMFI scheme code ──► api.mfapi.in NAV history ──► 1Y/3Y/5Y CAGR + peer comparison
        ──► research links (ValueResearch · RupeeVest · Tickertape · Morningstar · Moneycontrol)
```

- `docs/` — the static web app (GitHub Pages).
- `docs/data/amfi.json` — ISIN → {category, latest NAV, AMC, scheme code} snapshot built from
  [AMFI NAVAll.txt](https://portal.amfiindia.com/spages/NAVAll.txt). Refreshed **daily** by
  [`update-nav.yml`](.github/workflows/update-nav.yml) (AMFI sends no CORS headers, so the browser
  reads this same-origin snapshot instead).
- `cli/` — the Python package (analytics mirror of `docs/js/enrich.js`).
- `tools/` — snapshot & sample-data builders.

## Development

```bash
python3 -m venv .venv && .venv/bin/pip install -e ./cli pytest
.venv/bin/pytest cli/tests/
python3 tools/build_amfi_json.py     # refresh docs/data/amfi.json
cd docs && python3 -m http.server    # run the web app locally
```

## Disclaimer

This project is for **information and education only**. It is **not** SEBI-registered investment
advice and not tax advice. Categories, returns and tax figures are computed estimates that can be
wrong or stale; past performance does not predict future results. Consult a SEBI-registered
Investment Adviser and a qualified CA before acting on anything shown here.

## Credits

[AMFI](https://www.amfiindia.com/) (official NAV & categories) ·
[api.mfapi.in](https://www.mfapi.in/) (NAV history) ·
[casparser](https://github.com/codereverser/casparser) (CLI PDF parsing) ·
[pdf.js](https://mozilla.github.io/pdf.js/) (in-browser PDF text extraction).

MIT License.
