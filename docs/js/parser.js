/* CAS PDF parsing — runs entirely in the browser via pdf.js.
 *
 * Supported inputs:
 *   1. CAMS / KFintech detailed CAS (transaction-wise)
 *   2. CAMS / KFintech summary CAS (holdings-wise, positional column parse)
 *   3. casparser JSON (output of `casparser -o json`) — guaranteed-parse fallback
 *   4. This app's own normalized JSON (sample.json / exported analysis)
 *
 * NSDL/CDSL depository e-CAS layouts differ substantially and are detected but
 * not parsed in v1.
 */
"use strict";

const CasParser = (() => {
  const ISIN_RE = /\bIN[A-Z0-9]{10}\b/;
  const DATE_RE = /\d{2}-[A-Za-z]{3}-\d{4}/;

  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

  function parseCasDate(s) {
    const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(s.trim());
    if (!m) return null;
    const mon = MONTHS[m[2].toLowerCase()];
    if (mon === undefined) return null;
    const d = new Date(Date.UTC(+m[3], mon, +m[1]));
    return d.toISOString().slice(0, 10);
  }

  function parseNum(s) {
    if (s === null || s === undefined) return NaN;
    let t = String(s).trim();
    let neg = false;
    if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
    if (t.startsWith("-")) { neg = true; t = t.slice(1); }
    t = t.replace(/[₹,\s]|INR|Rs\.?/gi, "");
    if (!/^\d*\.?\d+$/.test(t)) return NaN;
    const v = parseFloat(t);
    return neg ? -v : v;
  }

  // ---------- pdf.js text extraction → logical lines ----------

  async function extractLines(data, password) {
    const task = pdfjsLib.getDocument({ data, password: password || "" });
    let pdf;
    try {
      pdf = await task.promise;
    } catch (err) {
      if (err && err.name === "PasswordException") {
        const e = new Error(password ? "Incorrect PDF password." : "This PDF is password-protected.");
        e.code = password ? "password-wrong" : "password-needed";
        throw e;
      }
      throw err;
    }
    const lines = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const items = content.items
        .filter((it) => it.str && it.str.trim() !== "")
        .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0 }));
      items.sort((a, b) => (Math.abs(b.y - a.y) > 3 ? b.y - a.y : a.x - b.x));
      let cur = null;
      for (const it of items) {
        if (!cur || Math.abs(it.y - cur.y) > 3) {
          cur = { page: p, y: it.y, items: [] };
          lines.push(cur);
        }
        cur.items.push(it);
      }
    }
    for (const ln of lines) {
      ln.items.sort((a, b) => a.x - b.x);
      ln.text = ln.items.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim();
    }
    return lines.filter((l) => l.text);
  }

  // ---------- format detection ----------

  function detectFormat(lines) {
    const corpus = lines.slice(0, 400).map((l) => l.text).join("\n");
    if (/NSDL|CDSL|National Securities Depository|Central Depository/i.test(corpus) && !/CAMS|KFin/i.test(corpus)) {
      return "depository";
    }
    if (lines.some((l) => /Opening Unit Balance/i.test(l.text))) return "cams-detailed";
    if (
      lines.some(
        (l) =>
          /Cost Value/i.test(l.text) &&
          /Unit|Units|Balance/i.test(l.text) &&
          /(Market|Total) Value|Valuation/i.test(l.text)
      )
    ) {
      return "cams-summary";
    }
    if (/Consolidated Account Statement/i.test(corpus)) return "cams-detailed";
    return "unknown";
  }

  // ---------- detailed CAS ----------

  const SCHEME_RE =
    /^(?<code>[A-Z0-9]{2,}[A-Z0-9-]*)\s*-\s*(?<name>.+?)(?:\s*\(\s*formerly[^)]*\))?\s*(?:-?\s*ISIN\s*:?\s*(?<isin>IN[A-Z0-9]{10}))?\s*(?:\(\s*Advisor\s*:?\s*(?<advisor>[^)]*)\))?\s*Registrar\s*:?\s*(?<rta>[A-Za-z]+)\s*$/i;
  const FOLIO_RE = /Folio No\s*:?\s*(?<folio>[\w/ -]+?)(?:\s+(?:PAN|KYC|KYC:).*)?$/i;
  const AMC_RE = /^(?<amc>[A-Za-z0-9 .&'()-]+(?:Mutual Fund|Asset Management))\s*$/i;
  const OPEN_RE = /Opening Unit Balance\s*:?\s*(?<units>[\d,.]+)/i;
  const CLOSE_RE = /Closing Unit Balance\s*:?\s*(?<units>[\d,.]+)/i;
  const NAV_RE = /NAV on\s*(?<date>\d{2}-[A-Za-z]{3}-\d{4})\s*:?\s*(?:INR|Rs\.?|₹)?\s*(?<nav>[\d,.]+)/i;
  const COST_RE = /(?:Total\s+)?Cost Value\s*:?\s*(?:INR|Rs\.?|₹)?\s*(?<cost>[\d,.]+)/i;
  const VALUE_RE =
    /(?:Market Value|Valuation) on\s*(?<date>\d{2}-[A-Za-z]{3}-\d{4})\s*:?\s*(?:INR|Rs\.?|₹)?\s*(?<value>[\d,.]+)/i;
  const TXN4_RE =
    /^(?<date>\d{2}-[A-Za-z]{3}-\d{4})\s+(?<desc>.+?)\s+(?<amount>\(?[-\d,.]+\)?)\s+(?<units>\(?[-\d,.]+\)?)\s+(?<nav>\(?[-\d,.]+\)?)\s+(?<balance>\(?[-\d,.]+\)?)\s*$/;
  const TXN1_RE = /^(?<date>\d{2}-[A-Za-z]{3}-\d{4})\s+(?<desc>.+?)\s+(?<amount>\(?[-\d,.]+\)?)\s*$/;
  const PERIOD_RE = /(?<from>\d{2}-[A-Za-z]{3}-\d{4})\s+To\s+(?<to>\d{2}-[A-Za-z]{3}-\d{4})/i;

  function classifyTxn(desc, amount) {
    const d = desc.toLowerCase();
    if (/stamp duty|stt paid|tds|tax deducted/.test(d)) return "TAX";
    if (/redemption|switch[- ]?out|swp|lateral shift out/.test(d)) return "REDEMPTION";
    if (/sip|systematic/.test(d)) return "PURCHASE_SIP";
    if (/purchase|switch[- ]?in|dividend reinvest|idcw reinvest|stp|lateral shift in|segregat/.test(d)) return "PURCHASE";
    return amount < 0 ? "REDEMPTION" : "MISC";
  }

  function tryMatchScheme(lines, i) {
    // Long scheme headers wrap; try the line alone, then joined with up to 2 more.
    let joined = lines[i].text;
    for (let extra = 0; extra <= 2; extra++) {
      if (extra > 0) {
        if (i + extra >= lines.length) break;
        joined = joined + " " + lines[i + extra].text;
      }
      if (!/Registrar/i.test(joined)) continue;
      const m = SCHEME_RE.exec(joined.replace(/\s+/g, " "));
      if (m) return { match: m, consumed: extra + 1 };
    }
    return null;
  }

  function parseDetailed(lines) {
    const holdings = [];
    let period = null;
    let amc = null;
    let folio = null;
    let scheme = null;

    const pushScheme = () => {
      if (scheme && scheme.units !== null && scheme.units > 0) holdings.push(scheme);
      scheme = null;
    };

    for (let i = 0; i < lines.length; i++) {
      const text = lines[i].text;

      if (!period) {
        const pm = PERIOD_RE.exec(text);
        if (pm) period = { from: parseCasDate(pm.groups.from), to: parseCasDate(pm.groups.to) };
      }

      const am = AMC_RE.exec(text);
      if (am && text.length < 60) { amc = am.groups.amc.trim(); continue; }

      const fm = FOLIO_RE.exec(text);
      if (fm && /Folio/i.test(text)) { folio = fm.groups.folio.trim(); continue; }

      const sm = tryMatchScheme(lines, i);
      if (sm) {
        pushScheme();
        const g = sm.match.groups;
        scheme = {
          scheme: g.name.replace(/\s+/g, " ").trim(),
          rtaCode: g.code.trim(),
          isin: g.isin || null,
          advisor: (g.advisor || "").trim() || null,
          rta: (g.rta || "").trim() || null,
          amc,
          folio,
          openingUnits: null,
          units: null,
          casNav: null,
          casNavDate: null,
          casValue: null,
          costValue: null,
          transactions: [],
        };
        i += sm.consumed - 1;
        continue;
      }

      if (!scheme) continue;

      if (!scheme.isin) {
        const im = ISIN_RE.exec(text);
        if (im && /ISIN/i.test(text)) scheme.isin = im[0];
      }
      const om = OPEN_RE.exec(text);
      if (om) { scheme.openingUnits = parseNum(om.groups.units); continue; }

      let closed = false;
      const cm = CLOSE_RE.exec(text);
      if (cm) { scheme.units = parseNum(cm.groups.units); closed = true; }
      const nm = NAV_RE.exec(text);
      if (nm) { scheme.casNav = parseNum(nm.groups.nav); scheme.casNavDate = parseCasDate(nm.groups.date); }
      const com = COST_RE.exec(text);
      if (com) scheme.costValue = parseNum(com.groups.cost);
      const vm = VALUE_RE.exec(text);
      if (vm) scheme.casValue = parseNum(vm.groups.value);
      if (closed || nm || com || vm) continue;

      const t4 = TXN4_RE.exec(text);
      if (t4) {
        const g = t4.groups;
        const amount = parseNum(g.amount);
        const units = parseNum(g.units);
        const nav = parseNum(g.nav);
        const balance = parseNum(g.balance);
        if (!isNaN(amount) && !isNaN(units) && !isNaN(nav)) {
          scheme.transactions.push({
            date: parseCasDate(g.date),
            description: g.desc.trim(),
            amount,
            units,
            nav,
            balance: isNaN(balance) ? null : balance,
            type: classifyTxn(g.desc, amount),
          });
          continue;
        }
      }
      const t1 = TXN1_RE.exec(text);
      if (t1) {
        const amount = parseNum(t1.groups.amount);
        if (!isNaN(amount)) {
          scheme.transactions.push({
            date: parseCasDate(t1.groups.date),
            description: t1.groups.desc.trim(),
            amount,
            units: null,
            nav: null,
            balance: null,
            type: classifyTxn(t1.groups.desc, amount),
          });
        }
      }
    }
    pushScheme();
    return { source: "cams-detailed", statementPeriod: period, holdings };
  }

  // ---------- summary CAS (positional columns) ----------

  function parseSummary(lines) {
    let header = null;
    for (const ln of lines) {
      if (
        /Cost Value/i.test(ln.text) &&
        /(Market|Total) Value|Valuation/i.test(ln.text) &&
        /Unit|Balance/i.test(ln.text)
      ) { header = ln; break; }
    }
    if (!header) throw new Error("Could not locate the summary table header.");

    const colX = (re) => {
      const it = header.items.find((i) => re.test(i.str));
      return it ? it.x : null;
    };
    const cols = {
      cost: colX(/Cost/i),
      units: colX(/Unit|Balance/i),
      nav: colX(/^NAV$|NAV\b/i),
      value: colX(/Market|Total|Valuation/i),
      date: colX(/Date/i),
    };
    const numericCols = Object.values(cols).filter((x) => x !== null);
    const firstNumX = Math.min(...numericCols);

    const nearest = (items, x) => {
      if (x === null) return null;
      let best = null;
      for (const it of items) {
        const v = parseNum(it.str);
        if (isNaN(v)) continue;
        const d = Math.abs(it.x - x);
        if (d < 60 && (!best || d < best.d)) best = { d, v };
      }
      return best ? best.v : null;
    };

    const holdings = [];
    let pendingName = "";
    const start = lines.indexOf(header) + 1;
    for (let i = start; i < lines.length; i++) {
      const ln = lines[i];
      if (/^(Grand )?Total\b/i.test(ln.text)) break;
      const numericItems = ln.items.filter((it) => !isNaN(parseNum(it.str)) && it.x >= firstNumX - 30);
      const rowName = ln.items
        .filter((it) => it.x < firstNumX - 30)
        .map((it) => it.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (numericItems.length < 2) {
        if (ln.text && !/^Page \d|Statement|www\.|e-?mail|KYC|PAN/i.test(ln.text)) {
          pendingName = (pendingName + " " + ln.text).trim();
        }
        continue;
      }
      const units = nearest(ln.items, cols.units);
      const value = nearest(ln.items, cols.value);
      if (units === null || value === null || units <= 0) continue;
      let name = (pendingName + " " + rowName).replace(/\s+/g, " ").trim();
      pendingName = "";
      let folio = null;
      const fm = /^([\d/ ]{4,20})\s+(.*)$/.exec(name);
      if (fm && /\d/.test(fm[1])) { folio = fm[1].trim(); name = fm[2]; }
      const isinM = ISIN_RE.exec(ln.text);
      const dateM = DATE_RE.exec(ln.text);
      holdings.push({
        scheme: name || "(unnamed scheme)",
        isin: isinM ? isinM[0] : null,
        folio,
        amc: null,
        openingUnits: null,
        units,
        casNav: nearest(ln.items, cols.nav),
        casNavDate: dateM ? parseCasDate(dateM[0]) : null,
        casValue: value,
        costValue: nearest(ln.items, cols.cost),
        transactions: [],
        parseConfidence: "summary-heuristic",
      });
    }
    return { source: "cams-summary", statementPeriod: null, holdings };
  }

  // ---------- casparser JSON ----------

  function normalizeCasparserJson(obj) {
    const holdings = [];
    for (const f of obj.folios || []) {
      for (const s of f.schemes || []) {
        const val = s.valuation || {};
        const close = typeof s.close === "string" ? parseFloat(s.close) : s.close;
        if (!close || close <= 0) continue;
        holdings.push({
          scheme: s.scheme,
          isin: s.isin || null,
          amfiCode: s.amfi ? String(s.amfi) : null,
          folio: f.folio || null,
          amc: f.amc || s.amc || null,
          openingUnits: typeof s.open === "string" ? parseFloat(s.open) : s.open,
          units: close,
          casNav: val.nav != null ? parseFloat(val.nav) : null,
          casNavDate: val.date || null,
          casValue: val.value != null ? parseFloat(val.value) : null,
          costValue: val.cost != null ? parseFloat(val.cost) : null,
          transactions: (s.transactions || []).map((t) => ({
            date: t.date,
            description: t.description,
            amount: t.amount != null ? parseFloat(t.amount) : null,
            units: t.units != null ? parseFloat(t.units) : null,
            nav: t.nav != null ? parseFloat(t.nav) : null,
            balance: t.balance != null ? parseFloat(t.balance) : null,
            type: t.type || classifyTxn(t.description || "", parseFloat(t.amount) || 0),
          })),
        });
      }
    }
    const sp = obj.statement_period || {};
    return { source: "casparser-json", statementPeriod: { from: sp.from || null, to: sp.to || null }, holdings };
  }

  // ---------- entry points ----------

  async function parsePdfFile(arrayBuffer, password) {
    const lines = await extractLines(new Uint8Array(arrayBuffer), password);
    const fmt = detectFormat(lines);
    const rawLines = lines.map((l) => l.text);
    if (fmt === "depository") {
      const e = new Error(
        "This looks like an NSDL/CDSL depository e-CAS, which isn't supported yet. " +
          "Please use the CAMS/KFintech mutual-fund CAS (camsonline.com → Statements → CAS), " +
          "or convert with the `casparser` CLI and drop the JSON here."
      );
      e.code = "unsupported-format";
      e.rawLines = rawLines;
      throw e;
    }
    let stmt;
    if (fmt === "cams-summary") stmt = parseSummary(lines);
    else stmt = parseDetailed(lines);
    if (!stmt.holdings.length && fmt !== "cams-summary") {
      try { stmt = parseSummary(lines); } catch (_) { /* keep detailed result */ }
    }
    stmt.rawLines = rawLines;
    if (!stmt.holdings.length) {
      const e = new Error(
        "No holdings could be parsed from this PDF. The layout may be a variant this parser " +
          "hasn't seen — use 'Show extracted text' below to inspect, and consider the casparser JSON route."
      );
      e.code = "no-holdings";
      e.rawLines = rawLines;
      throw e;
    }
    return stmt;
  }

  function parseJsonText(text) {
    const obj = JSON.parse(text);
    if (Array.isArray(obj.holdings)) return { source: obj.source || "json", statementPeriod: obj.statementPeriod || null, holdings: obj.holdings };
    if (Array.isArray(obj.folios)) return normalizeCasparserJson(obj);
    throw new Error("Unrecognized JSON — expected casparser output or this app's exported analysis.");
  }

  return { parsePdfFile, parseJsonText, parseNum, parseCasDate };
})();
