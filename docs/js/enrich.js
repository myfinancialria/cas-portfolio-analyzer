/* Enrichment + analytics:
 *   - ISIN → AMFI category / latest NAV (from same-origin data/amfi.json snapshot,
 *     refreshed daily by GitHub Actions — amfiindia.com itself sends no CORS headers)
 *   - per-fund NAV history / CAGR from api.mfapi.in (AMFI-sourced, CORS-open)
 *   - XIRR, FIFO lots, LTCG/STCG estimate, category bifurcation, rule-based observations
 */
"use strict";

const Enrich = (() => {
  const DAY = 86400000;

  // ---------- category buckets ----------

  const BUCKETS = [
    "Equity", "Hybrid", "Debt", "Index & ETF", "International",
    "Gold & Commodity", "Solution Oriented", "Other",
  ];

  function bucketOf(rec, schemeName) {
    const cat = ((rec && rec.cat) || "").toLowerCase();
    const sub = ((rec && rec.sub) || "").toLowerCase();
    const name = (schemeName || "").toLowerCase();
    const all = cat + " " + sub + " " + name;

    if (/\bgold\b|\bsilver\b|commodit/.test(sub + " " + name)) return "Gold & Commodity";
    if (/fof.*overseas|overseas|nasdaq|s&p ?500|\bus\b|global|international|world|hang seng|china|taiwan/.test(sub + " " + name))
      return "International";
    if (/index|etf/.test(sub) || (/other/.test(cat) && /index|etf/.test(name))) return "Index & ETF";
    if (/solution/.test(cat) || /retirement|children/.test(sub)) return "Solution Oriented";
    if (/equity/.test(cat) || cat === "growth" || /elss/.test(sub)) return "Equity";
    if (/hybrid|balanced/.test(all)) return "Hybrid";
    if (/debt|income|idf|gilt|money market|liquid|overnight|floater|duration|bond/.test(all)) return "Debt";
    if (/index|etf/.test(name)) return "Index & ETF";
    return "Other";
  }

  // Buckets whose gains are taxed under the equity regime (approximation — see disclaimer)
  const EQUITY_TAXED = new Set(["Equity", "Index & ETF", "Solution Oriented"]);

  // ---------- math ----------

  function xirr(flows) {
    // flows: [{date: ms epoch, amount}] — outflows (investments) negative, inflows positive
    if (flows.length < 2) return null;
    if (!flows.some((f) => f.amount < 0) || !flows.some((f) => f.amount > 0)) return null;
    const t0 = flows[0].date;
    const npv = (r) => flows.reduce((s, f) => s + f.amount / Math.pow(1 + r, (f.date - t0) / (365 * DAY)), 0);
    let lo = -0.9999, hi = 10;
    let flo = npv(lo), fhi = npv(hi);
    if (isNaN(flo) || isNaN(fhi) || flo * fhi > 0) return null;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      const fm = npv(mid);
      if (Math.abs(fm) < 1e-7) return mid;
      if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
    }
    return (lo + hi) / 2;
  }

  function holdingFlows(h, currentValue, asOf) {
    if (!h.transactions || !h.transactions.length) return null;
    if (h.openingUnits != null && h.openingUnits > 0.0005) return null; // window didn't start at zero → XIRR would mislead
    const flows = h.transactions
      .filter((t) => t.date && t.amount != null && !isNaN(t.amount) && t.amount !== 0)
      .map((t) => ({ date: Date.parse(t.date), amount: -t.amount }));
    if (!flows.length) return null;
    flows.push({ date: asOf, amount: currentValue });
    flows.sort((a, b) => a.date - b.date);
    return flows;
  }

  // ---------- FIFO lots → remaining cost + LTCG/STCG split ----------

  function fifoLots(transactions) {
    const lots = [];
    let investedGross = 0;
    const txs = (transactions || [])
      .filter((t) => t.date)
      .slice()
      .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    for (const t of txs) {
      const amt = t.amount || 0;
      const units = t.units;
      if (amt > 0) investedGross += amt;
      if (units != null && units > 0 && amt > 0) {
        lots.push({ date: Date.parse(t.date), units, cost: amt });
      } else if (units != null && units < 0) {
        let toSell = -units;
        while (toSell > 1e-6 && lots.length) {
          const lot = lots[0];
          const take = Math.min(lot.units, toSell);
          lot.cost *= (lot.units - take) / lot.units;
          lot.units -= take;
          toSell -= take;
          if (lot.units <= 1e-6) lots.shift();
        }
      }
    }
    const remainingCost = lots.reduce((s, l) => s + l.cost, 0);
    return { lots, remainingCost, investedGross };
  }

  function taxSplit(lots, latestNav, asOf) {
    let ltUnits = 0, stUnits = 0, ltGain = 0, stGain = 0;
    for (const lot of lots) {
      const ageDays = (asOf - lot.date) / DAY;
      const gain = lot.units * latestNav - lot.cost;
      if (ageDays > 365) { ltUnits += lot.units; ltGain += gain; }
      else { stUnits += lot.units; stGain += gain; }
    }
    return { ltUnits, stUnits, ltGain, stGain };
  }

  // ---------- research links ----------

  function cleanSchemeName(name) {
    let n = name || "";
    n = n.replace(/\(formerly[^)]*\)/gi, " ");
    n = n.replace(/[-\s(]*\b(direct|regular)\b.*$/i, " ");
    n = n.replace(/\b(growth|idcw|dividend|payout|reinvest(ment)?|option|plan)\b/gi, " ");
    return n.replace(/[^\w&' -]/g, " ").replace(/\s+/g, " ").trim();
  }

  function researchLinks(name) {
    const q = encodeURIComponent(cleanSchemeName(name));
    const g = (site) => `https://www.google.com/search?q=${q}+site%3A${site}`;
    return [
      { label: "ValueResearch", url: g("valueresearchonline.com") },
      { label: "RupeeVest", url: g("rupeevest.com") },
      { label: "Tickertape", url: g("tickertape.in") },
      { label: "Morningstar", url: g("morningstar.in") },
      { label: "Moneycontrol", url: g("moneycontrol.com") },
    ];
  }

  // ---------- AMFI snapshot + mfapi ----------

  let amfiCache = null;
  async function loadAmfi() {
    if (amfiCache) return amfiCache;
    const resp = await fetch("data/amfi.json", { cache: "no-cache" });
    if (!resp.ok) throw new Error("Could not load the AMFI NAV snapshot (data/amfi.json).");
    amfiCache = await resp.json();
    return amfiCache;
  }

  async function fetchHistory(code) {
    const resp = await fetch(`https://api.mfapi.in/mf/${code}`);
    if (!resp.ok) throw new Error(`mfapi ${resp.status}`);
    const obj = await resp.json();
    const rows = (obj.data || [])
      .map((r) => {
        const [d, m, y] = r.date.split("-");
        return { t: Date.UTC(+y, +m - 1, +d), nav: parseFloat(r.nav) };
      })
      .filter((r) => r.nav > 0)
      .sort((a, b) => b.t - a.t); // newest first
    return rows;
  }

  function cagrFrom(rows, years) {
    if (!rows || rows.length < 2) return null;
    const latest = rows[0];
    const target = latest.t - years * 365.25 * DAY;
    let past = null;
    for (const r of rows) {
      if (r.t <= target) { past = r; break; }
    }
    if (!past) return null;
    const actualYears = (latest.t - past.t) / (365.25 * DAY);
    if (actualYears < years * 0.9) return null;
    return Math.pow(latest.nav / past.nav, 1 / actualYears) - 1;
  }

  async function mapWithConcurrency(items, limit, fn) {
    const out = new Array(items.length);
    let idx = 0;
    async function worker() {
      while (idx < items.length) {
        const i = idx++;
        try { out[i] = await fn(items[i], i); } catch (e) { out[i] = { error: String(e) }; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  }

  // ---------- main computation ----------

  function median(arr) {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function analyze(statement, amfi) {
    const byIsin = amfi.byIsin || {};
    const now = Date.now();
    const rows = statement.holdings.map((h) => {
      const rec = h.isin ? byIsin[h.isin] : null;
      const latestNav = rec && rec.nav ? rec.nav : h.casNav;
      const latestNavDate = rec && rec.nav ? rec.date : h.casNavDate;
      const currentValue = latestNav != null ? h.units * latestNav : h.casValue;
      const fifo = fifoLots(h.transactions);
      const cost =
        h.costValue != null && !isNaN(h.costValue)
          ? h.costValue
          : fifo.remainingCost > 0
            ? fifo.remainingCost
            : null;
      const gain = cost != null && currentValue != null ? currentValue - cost : null;
      const gainPct = gain != null && cost > 0 ? gain / cost : null;
      const bucket = bucketOf(rec, h.scheme);
      const flows = holdingFlows(h, currentValue, now);
      const rate = flows ? xirr(flows) : null;
      const tax =
        fifo.lots.length && latestNav != null
          ? { ...taxSplit(fifo.lots, latestNav, now), equityTaxed: EQUITY_TAXED.has(bucket) }
          : null;
      return {
        ...h,
        matched: !!rec,
        amfi: rec || null,
        amfiCode: (rec && rec.code) || h.amfiCode || null,
        displayName: (rec && rec.name) || h.scheme,
        bucket,
        subCategory: (rec && rec.sub) || null,
        amcName: (rec && rec.amc) || h.amc || null,
        latestNav,
        latestNavDate,
        currentValue,
        cost,
        gain,
        gainPct,
        xirr: rate,
        tax,
        links: researchLinks((rec && rec.name) || h.scheme),
        cagr: null, // filled by loadPerformance
      };
    });

    const total = (sel) => rows.reduce((s, r) => s + (sel(r) || 0), 0);
    const invested = total((r) => r.cost);
    const currentValue = total((r) => r.currentValue);
    const gain = currentValue - invested;

    const byBucket = {};
    for (const b of BUCKETS) byBucket[b] = { bucket: b, invested: 0, value: 0, count: 0 };
    for (const r of rows) {
      const g = byBucket[r.bucket];
      g.invested += r.cost || 0;
      g.value += r.currentValue || 0;
      g.count += 1;
    }
    const buckets = Object.values(byBucket)
      .filter((g) => g.count > 0)
      .map((g) => ({ ...g, gain: g.value - g.invested, weight: currentValue ? g.value / currentValue : 0 }))
      .sort((a, b) => b.value - a.value);

    // portfolio XIRR over holdings that have complete flows
    let pfFlows = [];
    let pfCovered = 0;
    for (const r of rows) {
      const f = holdingFlows(r, r.currentValue, now);
      if (f) { pfFlows = pfFlows.concat(f); pfCovered += r.currentValue || 0; }
    }
    pfFlows.sort((a, b) => a.date - b.date);
    const portfolioXirr = pfFlows.length ? xirr(pfFlows) : null;
    const xirrCoverage = currentValue ? pfCovered / currentValue : 0;

    const taxAgg = rows.reduce(
      (acc, r) => {
        if (r.tax && r.tax.equityTaxed) { acc.ltGain += r.tax.ltGain; acc.stGain += r.tax.stGain; acc.covered = true; }
        return acc;
      },
      { ltGain: 0, stGain: 0, covered: false }
    );

    return {
      generatedAt: new Date().toISOString(),
      amfiMeta: amfi.meta || null,
      statementPeriod: statement.statementPeriod,
      source: statement.source,
      rows,
      totals: { invested, currentValue, gain, gainPct: invested > 0 ? gain / invested : null, portfolioXirr, xirrCoverage },
      buckets,
      tax: taxAgg.covered ? taxAgg : null,
      insights: buildInsights(rows, buckets, currentValue),
    };
  }

  function buildInsights(rows, buckets, totalValue) {
    const out = [];
    if (!totalValue) return out;
    for (const r of rows) {
      const w = (r.currentValue || 0) / totalValue;
      if (w > 0.15)
        out.push({ level: "flag", text: `${r.displayName} is ${(w * 100).toFixed(1)}% of the portfolio — single-fund concentration above the common 15% comfort line.` });
    }
    const byAmc = {};
    for (const r of rows) {
      const k = r.amcName || "Unknown AMC";
      byAmc[k] = (byAmc[k] || 0) + (r.currentValue || 0);
    }
    for (const [amc, v] of Object.entries(byAmc)) {
      if (v / totalValue > 0.3)
        out.push({ level: "flag", text: `${amc} manages ${((v / totalValue) * 100).toFixed(1)}% of the portfolio — AMC concentration above 30%.` });
    }
    const bySub = {};
    for (const r of rows) {
      const k = r.subCategory || null;
      if (k) (bySub[k] = bySub[k] || []).push(r.displayName);
    }
    for (const [sub, names] of Object.entries(bySub)) {
      if (names.length > 3)
        out.push({ level: "info", text: `${names.length} funds in the same sub-category (${sub}) — portfolios likely overlap; compare them side-by-side on ValueResearch or RupeeVest.` });
    }
    const regular = rows.filter((r) => /regular/i.test(r.displayName));
    if (regular.length)
      out.push({ level: "info", text: `${regular.length} holding(s) are Regular plans (${regular.map((r) => r.displayName.split(" - ")[0]).join(", ")}). Direct plans of the same schemes typically carry lower expense ratios — worth comparing on the linked research sites.` });
    const eq = buckets.find((b) => b.bucket === "Equity");
    if (eq) {
      const smallMid = rows
        .filter((r) => r.bucket === "Equity" && /small|mid/i.test(r.subCategory || ""))
        .reduce((s, r) => s + (r.currentValue || 0), 0);
      if (eq.value > 0 && smallMid / eq.value > 0.4)
        out.push({ level: "flag", text: `Small & mid-cap funds are ${((smallMid / eq.value) * 100).toFixed(0)}% of your equity allocation (>40%) — expect higher volatility than a large-cap-tilted mix.` });
    }
    const unmatched = rows.filter((r) => !r.matched);
    if (unmatched.length)
      out.push({ level: "info", text: `${unmatched.length} holding(s) could not be matched to the AMFI list (missing/retired ISIN) — their values use the NAV printed in the CAS instead of the latest NAV.` });
    return out;
  }

  // Second pass: NAV-history CAGRs + peer comparison among the statement's own funds
  async function loadPerformance(analysis, onProgress) {
    const withCode = analysis.rows.filter((r) => r.amfiCode);
    let done = 0;
    await mapWithConcurrency(withCode, 6, async (r) => {
      try {
        const rows = await fetchHistory(r.amfiCode);
        r.cagr = { r1: cagrFrom(rows, 1), r3: cagrFrom(rows, 3), r5: cagrFrom(rows, 5) };
      } catch (_) {
        r.cagr = null;
      }
      done += 1;
      if (onProgress) onProgress(done, withCode.length);
    });
    // trailing-vs-peers observation (per bucket, needs >=3 funds with 3Y data)
    const byBucket = {};
    for (const r of analysis.rows) {
      if (r.cagr && r.cagr.r3 != null) (byBucket[r.bucket] = byBucket[r.bucket] || []).push(r);
    }
    for (const [bucket, rs] of Object.entries(byBucket)) {
      if (rs.length < 3) continue;
      const med = median(rs.map((r) => r.cagr.r3));
      for (const r of rs) {
        if (r.cagr.r3 < med - 0.03)
          analysis.insights.push({
            level: "flag",
            text: `${r.displayName}: 3Y CAGR ${(r.cagr.r3 * 100).toFixed(1)}% trails the median of your own ${bucket} funds (${(med * 100).toFixed(1)}%) by over 3pp — worth a deeper look on ValueResearch/Tickertape before your next SIP date.`,
          });
      }
    }
    return analysis;
  }

  return { loadAmfi, analyze, loadPerformance, bucketOf, xirr, fifoLots, taxSplit, researchLinks, cleanSchemeName, BUCKETS };
})();
