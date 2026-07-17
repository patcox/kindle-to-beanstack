// Floating panel injected on the Amazon Parent Dashboard. Two jobs:
//   1. "Detect kids" — capture each child's childDirectedId (network-based,
//      not a fragile CSS selector — see comment below) and let you label it.
//   2. "Pull reading data" — fetch a date range of activity for each saved
//      kid, best-effort-enrich with ISBN, and store it for the Beanstack
//      side to pick up.
//
// Runs only on human button clicks — never on a timer/schedule. See
// README "Open risks" for why (Amazon's Conditions of Use bar automated
// access; this keeps the traffic pattern close to normal manual use).
//
// Chrome's manifest.json content_scripts array has no way to declare a
// script as an ES module (that's only supported for content scripts
// registered dynamically via chrome.scripting.registerContentScripts,
// which this project doesn't use). So this file loads as a classic
// script — everything lives inside one async IIFE so it can use
// dynamic import() (valid in classic scripts; top-level import/export
// and top-level await are not) to pull in the real lib modules.

(async () => {
  const { fetchActivity, fetchIsbnForAsin } = await import(chrome.runtime.getURL("lib/amazon-client.js"));
  const { getKids, addOrUpdateKid, mergeReadingDataset } = await import(chrome.runtime.getURL("lib/store.js"));

  const ACTIVITY_ENDPOINT_PATH = "/parentdashboard/ajax/get-weekly-activities-v2";

  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }

  function daysAgoISO(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  }

  function isoToUnixSeconds(iso, endOfDay = false) {
    return Math.floor(new Date(`${iso}T${endOfDay ? "23:59:59" : "00:00:00"}`).getTime() / 1000);
  }

  let detecting = false;
  let detectedThisSession = new Map(); // childDirectedId -> name (pending or saved)

  /**
   * Watches for the activities endpoint being called (which fires whenever
   * the child-selector is clicked) and surfaces a "name this kid" prompt for
   * any childDirectedId not seen before. This is network-based rather than
   * reading Amazon's DOM for a display name, since the exact markup isn't
   * something we control or want to depend on staying stable.
   */
  function installDetectionWatcher(onDetected) {
    if (window.__kbFetchPatched) return;
    window.__kbFetchPatched = true;
    const origFetch = window.fetch;
    window.fetch = async function (...args) {
      const [url, opts] = args;
      if (detecting && String(url).includes(ACTIVITY_ENDPOINT_PATH) && opts?.body) {
        try {
          const body = JSON.parse(opts.body);
          if (body.childDirectedId) onDetected(body.childDirectedId);
        } catch {
          // ignore unparseable bodies
        }
      }
      return origFetch.apply(this, args);
    };
  }

  function buildPanel() {
    const panel = document.createElement("div");
    panel.id = "kb-amazon-panel";
    panel.style.cssText = `
      position: fixed; top: 16px; right: 16px; z-index: 999999;
      width: 320px; background: #fff; color: #111; border: 1px solid #ccc;
      border-radius: 8px; box-shadow: 0 2px 12px rgba(0,0,0,0.25);
      font: 13px -apple-system, sans-serif; padding: 12px;
    `;
    panel.innerHTML = `
      <div style="font-weight:600; margin-bottom:8px;">Kindle → Beanstack</div>

      <div style="margin-bottom:10px;">
        <div style="font-weight:600; font-size:12px; color:#555;">1. Kids</div>
        <button id="kb-detect-btn" style="margin-top:4px;">Detect kids</button>
        <div id="kb-detect-status" style="font-size:12px; color:#555; margin-top:4px;"></div>
        <ul id="kb-kids-list" style="margin:6px 0 0; padding-left:18px;"></ul>
      </div>

      <div>
        <div style="font-weight:600; font-size:12px; color:#555;">2. Pull reading data</div>
        <div style="margin-top:4px;">
          <input type="date" id="kb-start-date" style="width:130px;">
          &ndash;
          <input type="date" id="kb-end-date" style="width:130px;">
        </div>
        <button id="kb-pull-btn" style="margin-top:6px;">Pull reading data</button>
        <div id="kb-pull-status" style="font-size:12px; color:#555; margin-top:4px;"></div>
      </div>
    `;
    document.body.appendChild(panel);
    return panel;
  }

  async function refreshKidsList(panel) {
    const kids = await getKids();
    const list = panel.querySelector("#kb-kids-list");
    list.innerHTML = kids
      .map((k) => `<li>${escapeHtml(k.name)} <span style="color:#999;">(…${k.childDirectedId.slice(-6)})</span></li>`)
      .join("");
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function promptForName(childDirectedId) {
    return window.prompt(
      `Detected a child account (ID ending …${childDirectedId.slice(-6)}). What's their name?`
    );
  }

  async function handleDetected(panel, childDirectedId) {
    if (detectedThisSession.has(childDirectedId)) return;
    detectedThisSession.set(childDirectedId, null);
    const name = promptForName(childDirectedId);
    if (name && name.trim()) {
      await addOrUpdateKid({ childDirectedId, name: name.trim() });
      detectedThisSession.set(childDirectedId, name.trim());
      await refreshKidsList(panel);
    }
  }

  async function pullReadingData(panel) {
    const statusEl = panel.querySelector("#kb-pull-status");
    const kids = await getKids();
    if (kids.length === 0) {
      statusEl.textContent = "No kids configured yet — run \"Detect kids\" first.";
      return;
    }
    const startISO = panel.querySelector("#kb-start-date").value;
    const endISO = panel.querySelector("#kb-end-date").value;
    const startTime = isoToUnixSeconds(startISO, false);
    const endTime = isoToUnixSeconds(endISO, true);

    let totalEntries = 0;
    for (const kid of kids) {
      statusEl.textContent = `Pulling ${kid.name}'s reading activity…`;
      const rows = await fetchActivity({ childDirectedId: kid.childDirectedId, startTime, endTime });

      // Best-effort ISBN enrichment, one lookup per unique ASIN, with a small
      // delay between requests — this hits amazon.com/dp/* pages, so keep it
      // gentle rather than firing everything at once.
      const uniqueAsins = [...new Set(rows.map((r) => r.asin).filter(Boolean))];
      const isbnByAsin = new Map();
      for (const asin of uniqueAsins) {
        statusEl.textContent = `Looking up ISBNs for ${kid.name} (${isbnByAsin.size + 1}/${uniqueAsins.length})…`;
        const isbn = await fetchIsbnForAsin(asin);
        isbnByAsin.set(asin, isbn);
        await new Promise((r) => setTimeout(r, 350));
      }

      const enriched = rows.map((r) => ({
        childDirectedId: kid.childDirectedId,
        date: r.date,
        asin: r.asin,
        title: r.title,
        minutes: r.minutes,
        isbn: isbnByAsin.get(r.asin) ?? null,
      }));
      await mergeReadingDataset(enriched);
      totalEntries += enriched.length;
    }
    statusEl.textContent = `Done. Pulled ${totalEntries} (day, title) entries across ${kids.length} kid(s). Head to Beanstack to review and log them.`;
  }

  async function init() {
    const panel = buildPanel();
    panel.querySelector("#kb-start-date").value = daysAgoISO(60);
    panel.querySelector("#kb-end-date").value = todayISO();

    installDetectionWatcher((childDirectedId) => handleDetected(panel, childDirectedId));

    panel.querySelector("#kb-detect-btn").addEventListener("click", () => {
      detecting = !detecting;
      detectedThisSession = new Map();
      const statusEl = panel.querySelector("#kb-detect-status");
      statusEl.textContent = detecting
        ? "Detecting — click each kid's icon at the top of this page one at a time."
        : "Stopped detecting.";
      panel.querySelector("#kb-detect-btn").textContent = detecting ? "Stop detecting" : "Detect kids";
    });

    panel.querySelector("#kb-pull-btn").addEventListener("click", () => {
      pullReadingData(panel).catch((err) => {
        panel.querySelector("#kb-pull-status").textContent = `Error: ${err.message}`;
      });
    });

    await refreshKidsList(panel);
  }

  init();
})();
