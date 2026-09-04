/* Rendering — plain DOM + template literals, hand-rolled SVG donut (no chart lib). */
"use strict";

const UI = (() => {
  const BUCKET_COLORS = {
    "Equity": "#2E86AB",
    "Hybrid": "#6D9DC5",
    "Debt": "#5E9C8F",
    "Index & ETF": "#27AE60",
    "International": "#8B5CF6",
    "Gold & Commodity": "#E8A020",
    "Solution Oriented": "#C0627A",
    "Other": "#8A8F98",
  };

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const inr = (v, frac = 0) =>
    v == null || isNaN(v)
      ? "—"
      : new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: frac, minimumFractionDigits: 0 }).format(v);

  const num = (v, frac = 3) =>
    v == null || isNaN(v) ? "—" : new Intl.NumberFormat("en-IN", { maximumFractionDigits: frac }).format(v);

  const pct = (v, frac = 1) => (v == null || isNaN(v) ? "—" : `${(v * 100).toFixed(frac)}%`);

  const signed = (v, fmt) => {
    if (v == null || isNaN(v)) return "—";
    const cls = v > 0.0001 ? "pos" : v < -0.0001 ? "neg" : "";
    const sign = v > 0 ? "+" : "";
    return `<span class="${cls}">${sign}${fmt(v)}</span>`;
  };

  function donutSvg(buckets, totalValue) {
    const R = 70, C = 2 * Math.PI * R;
    let offset = 0;
    const segs = buckets
      .map((b) => {
        const frac = totalValue ? b.value / totalValue : 0;
        const len = frac * C;
        const seg = `<circle r="${R}" cx="90" cy="90" fill="none" stroke="${BUCKET_COLORS[b.bucket]}"
          stroke-width="26" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-offset}"
          transform="rotate(-90 90 90)"><title>${esc(b.bucket)}: ${pct(frac)}</title></circle>`;
        offset += len;
        return seg;
      })
      .join("");
    return `<svg viewBox="0 0 180 180" role="img" aria-label="Category allocation donut chart">
      ${segs}
      <text x="90" y="84" text-anchor="middle" class="donut-big">${esc(inr(totalValue))}</text>
      <text x="90" y="104" text-anchor="middle" class="donut-small">current value</text>
    </svg>`;
  }

  function cagrChip(label, v) {
    if (v == null || isNaN(v)) return `<span class="chip muted">${label}: —</span>`;
    const cls = v >= 0 ? "chip pos-bg" : "chip neg-bg";
    return `<span class="${cls}">${label}: ${(v * 100).toFixed(1)}%</span>`;
  }

  function linksHtml(links) {
    return links
      .map((l) => `<a class="rlink" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.label)}</a>`)
      .join("");
  }

  function holdingRow(r) {
    const conf = r.parseConfidence ? `<span class="badge warn" title="Parsed from a summary-format table — verify numbers against the PDF">verify</span>` : "";
    const unmatched = r.matched ? "" : `<span class="badge warn" title="ISIN not found in the AMFI list — showing values from the CAS itself">CAS NAV</span>`;
    const taxHtml = r.tax
      ? `<div class="taxline">Unrealized (est.): LTCG ${signed(r.tax.ltGain, (v) => inr(Math.abs(v)))} · STCG ${signed(r.tax.stGain, (v) => inr(Math.abs(v)))}${r.tax.equityTaxed ? "" : " <span class='muted'>(hybrid/debt — actual taxation depends on the fund's equity mix)</span>"}</div>`
      : "";
    const cagr = r.cagr
      ? `${cagrChip("1Y", r.cagr.r1)}${cagrChip("3Y", r.cagr.r3)}${cagrChip("5Y", r.cagr.r5)}`
      : `<span class="chip muted">fetching NAV history…</span>`;
    return `
    <tr class="main-row" data-isin="${esc(r.isin || "")}">
      <td class="scheme">
        <div class="scheme-name">${esc(r.displayName)} ${conf}${unmatched}</div>
        <div class="scheme-meta">${esc(r.subCategory || r.bucket)}${r.folio ? " · Folio " + esc(r.folio) : ""}${r.isin ? " · " + esc(r.isin) : ""}</div>
        <div class="scheme-links">${cagr}</div>
        <div class="scheme-links">${linksHtml(r.links)}</div>
        ${taxHtml}
      </td>
      <td class="r">${num(r.units)}</td>
      <td class="r">${num(r.latestNav, 4)}<div class="cell-sub">${esc(r.latestNavDate || "")}</div></td>
      <td class="r">${inr(r.cost)}</td>
      <td class="r">${inr(r.currentValue)}</td>
      <td class="r">${signed(r.gain, inr)}<div class="cell-sub">${r.gainPct == null ? "" : signed(r.gainPct, pct)}</div></td>
      <td class="r">${r.xirr == null ? "<span class='muted' title='Needs a transaction-wise (detailed) CAS generated from the very first investment date'>—</span>" : signed(r.xirr, pct)}</td>
    </tr>`;
  }

  function render(analysis, container) {
    const t = analysis.totals;
    const asOf = analysis.amfiMeta ? analysis.amfiMeta.nav_as_of || "" : "";
    const period = analysis.statementPeriod && analysis.statementPeriod.from
      ? `${analysis.statementPeriod.from} → ${analysis.statementPeriod.to}` : null;

    const cards = `
      <div class="cards">
        <div class="card"><div class="card-label">Invested</div><div class="card-value">${inr(t.invested)}</div></div>
        <div class="card"><div class="card-label">Current value</div><div class="card-value">${inr(t.currentValue)}</div>
          <div class="card-sub">AMFI NAVs as of ${esc(asOf)}</div></div>
        <div class="card"><div class="card-label">Unrealized gain</div>
          <div class="card-value">${signed(t.gain, inr)}</div>
          <div class="card-sub">${t.gainPct == null ? "" : signed(t.gainPct, pct) + " absolute"}</div></div>
        <div class="card"><div class="card-label">Portfolio XIRR</div>
          <div class="card-value">${t.portfolioXirr == null ? "—" : signed(t.portfolioXirr, pct)}</div>
          <div class="card-sub">${t.portfolioXirr == null
            ? "needs a detailed CAS from the first investment date"
            : `covers ${pct(t.xirrCoverage, 0)} of value (holdings with full history)`}</div></div>
      </div>`;

    const legend = analysis.buckets
      .map(
        (b) => `<tr>
          <td><span class="dot" style="background:${BUCKET_COLORS[b.bucket]}"></span>${esc(b.bucket)} <span class="muted">(${b.count})</span></td>
          <td class="r">${inr(b.invested)}</td>
          <td class="r">${inr(b.value)}</td>
          <td class="r">${signed(b.gain, inr)}</td>
          <td class="r">${pct(b.weight)}</td>
        </tr>`
      )
      .join("");

    const alloc = `
      <section class="panel">
        <h2>Category bifurcation</h2>
        <div class="alloc-grid">
          <div class="donut-wrap">${donutSvg(analysis.buckets, t.currentValue)}</div>
          <div class="scroll-x"><table class="alloc-table">
            <thead><tr><th>Category</th><th class="r">Invested</th><th class="r">Value</th><th class="r">Gain</th><th class="r">Weight</th></tr></thead>
            <tbody>${legend}</tbody>
          </table></div>
        </div>
      </section>`;

    const groups = analysis.buckets
      .map((b) => {
        const rows = analysis.rows
          .filter((r) => r.bucket === b.bucket)
          .sort((a, c) => (c.currentValue || 0) - (a.currentValue || 0))
          .map(holdingRow)
          .join("");
        return `
        <section class="panel">
          <h2><span class="dot" style="background:${BUCKET_COLORS[b.bucket]}"></span>${esc(b.bucket)}
            <span class="h2-sub">${inr(b.value)} · ${pct(b.weight)} of portfolio</span></h2>
          <div class="scroll-x">
          <table class="holdings">
            <thead><tr>
              <th>Scheme</th><th class="r">Units</th><th class="r">Latest NAV</th>
              <th class="r">Invested</th><th class="r">Value</th><th class="r">Gain / Loss</th><th class="r">XIRR</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table></div>
        </section>`;
      })
      .join("");

    const taxPanel = analysis.tax
      ? `<section class="panel">
          <h2>Unrealized capital gains (equity-taxed holdings, estimate)</h2>
          <div class="cards">
            <div class="card"><div class="card-label">Long-term (held &gt; 1 year)</div><div class="card-value">${signed(analysis.tax.ltGain, inr)}</div>
              <div class="card-sub">LTCG above ₹1.25L/FY currently taxed at 12.5%</div></div>
            <div class="card"><div class="card-label">Short-term (held ≤ 1 year)</div><div class="card-value">${signed(analysis.tax.stGain, inr)}</div>
              <div class="card-sub">STCG currently taxed at 20%</div></div>
          </div>
          <p class="muted small">Estimated from FIFO lots in the statement's transactions at the latest NAV. Grandfathering,
          switch history outside this statement, and non-equity taxation are not modelled — confirm with a CA before acting.</p>
        </section>`
      : "";

    const insights = analysis.insights.length
      ? `<section class="panel"><h2>Observations</h2><ul class="insights">${analysis.insights
          .map((i) => `<li class="${i.level}">${esc(i.text)}</li>`)
          .join("")}</ul>
          <p class="muted small">Rule-based observations computed from this statement and public NAV data — inputs for your own
          research on the linked platforms, not buy/sell advice.</p></section>`
      : "";

    container.innerHTML = `
      ${period ? `<p class="muted">Statement period: ${esc(period)} · Parsed as: ${esc(analysis.source)}</p>` : `<p class="muted">Parsed as: ${esc(analysis.source)}</p>`}
      ${cards}
      ${alloc}
      ${insights}
      ${groups}
      ${taxPanel}
      <div class="actions no-print">
        <button id="btn-csv" class="btn">Download CSV</button>
        <button id="btn-json" class="btn">Download JSON</button>
        <button id="btn-print" class="btn">Print / save as PDF</button>
      </div>`;

    document.getElementById("btn-csv").addEventListener("click", () => downloadCsv(analysis));
    document.getElementById("btn-json").addEventListener("click", () => downloadJson(analysis));
    document.getElementById("btn-print").addEventListener("click", () => window.print());
  }

  function downloadBlob(name, mime, text) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: mime }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function downloadCsv(analysis) {
    const cols = ["scheme", "isin", "folio", "bucket", "subCategory", "units", "latestNav", "latestNavDate", "cost", "currentValue", "gain", "gainPct", "xirr", "cagr1y", "cagr3y", "cagr5y"];
    const rows = analysis.rows.map((r) =>
      [r.displayName, r.isin, r.folio, r.bucket, r.subCategory, r.units, r.latestNav, r.latestNavDate, r.cost, r.currentValue, r.gain, r.gainPct, r.xirr, r.cagr?.r1, r.cagr?.r3, r.cagr?.r5]
        .map((v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v)))
        .join(",")
    );
    downloadBlob("cas-analysis.csv", "text/csv", [cols.join(","), ...rows].join("\n"));
  }

  function downloadJson(analysis) {
    const clean = { ...analysis, rows: analysis.rows.map(({ links, amfi, ...r }) => r) };
    downloadBlob("cas-analysis.json", "application/json", JSON.stringify(clean, null, 2));
  }

  return { render, esc };
})();
