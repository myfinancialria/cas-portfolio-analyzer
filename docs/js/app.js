/* App wiring: file input, password retry, sample data, status + debug panel. */
"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  let lastRawLines = null;

  function setStatus(msg, kind = "info") {
    const el = $("status");
    el.textContent = msg || "";
    el.className = `status ${kind}`;
    el.hidden = !msg;
  }

  function showDebug(rawLines) {
    lastRawLines = rawLines || lastRawLines;
    if (!lastRawLines) return;
    $("debug-wrap").hidden = false;
    $("debug-text").value = lastRawLines.join("\n");
  }

  async function analyzeStatement(statement) {
    setStatus("Matching schemes against the AMFI list and computing gains…");
    const amfi = await Enrich.loadAmfi();
    const analysis = Enrich.analyze(statement, amfi);
    const results = $("results");
    UI.render(analysis, results);
    results.scrollIntoView({ behavior: "smooth", block: "start" });
    setStatus(`Fetching NAV histories for CAGR (api.mfapi.in)… 0/${analysis.rows.filter((r) => r.amfiCode).length}`);
    try {
      await Enrich.loadPerformance(analysis, (done, total) =>
        setStatus(`Fetching NAV histories for CAGR (api.mfapi.in)… ${done}/${total}`)
      );
      UI.render(analysis, results);
      setStatus("");
    } catch (err) {
      UI.render(analysis, results);
      setStatus("Could not fetch NAV histories (offline or api.mfapi.in unreachable) — CAGR columns skipped.", "warn");
    }
  }

  async function handleFile(file) {
    $("debug-wrap").hidden = true;
    try {
      if (/\.json$/i.test(file.name) || file.type === "application/json") {
        setStatus("Reading JSON…");
        const text = await file.text();
        await analyzeStatement(CasParser.parseJsonText(text));
        return;
      }
      setStatus("Parsing PDF in your browser (nothing is uploaded)…");
      const buf = await file.arrayBuffer();
      const password = $("password").value;
      const statement = await CasParser.parsePdfFile(buf, password);
      lastRawLines = statement.rawLines;
      await analyzeStatement(statement);
    } catch (err) {
      console.error(err);
      if (err.code === "password-needed" || err.code === "password-wrong") {
        setStatus(`${err.message} Enter it below and drop the file again.`, "warn");
        $("password").focus();
        return;
      }
      setStatus(err.message || String(err), "error");
      if (err.rawLines) showDebug(err.rawLines);
    }
  }

  function wireDropZone() {
    const dz = $("dropzone");
    const input = $("file-input");
    dz.addEventListener("click", () => input.click());
    dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") input.click(); });
    input.addEventListener("change", () => { if (input.files[0]) handleFile(input.files[0]); input.value = ""; });
    ["dragover", "dragenter"].forEach((ev) =>
      dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); })
    );
    ["dragleave", "drop"].forEach((ev) =>
      dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); })
    );
    dz.addEventListener("drop", (e) => {
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(f);
    });
  }

  async function loadSample() {
    try {
      setStatus("Loading sample portfolio…");
      const resp = await fetch("data/sample.json", { cache: "no-cache" });
      const obj = await resp.json();
      await analyzeStatement({ source: "sample data (fabricated units, real ISINs & NAVs)", statementPeriod: obj.statementPeriod, holdings: obj.holdings });
    } catch (err) {
      setStatus("Could not load sample data: " + err.message, "error");
    }
  }

  window.addEventListener("DOMContentLoaded", () => {
    if (window.pdfjsLib) {
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    }
    wireDropZone();
    $("btn-sample").addEventListener("click", loadSample);
    $("btn-debug").addEventListener("click", () => showDebug());
    Enrich.loadAmfi()
      .then((a) => {
        const m = a.meta || {};
        $("amfi-note").textContent = `AMFI NAV snapshot: ${m.schemes || "?"} schemes, NAVs as of ${m.nav_as_of || "?"} (auto-updated daily).`;
      })
      .catch(() => {
        $("amfi-note").textContent = "AMFI NAV snapshot could not be loaded — values will fall back to the NAVs printed in your CAS.";
      });
  });
})();
