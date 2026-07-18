// Floating panel injected on the Amazon Parent Dashboard. Two jobs:
//   1. "Detect kids" — fetch every kid in the household (name +
//      childDirectedId) in one request. See amazon-client.js
//      fetchHouseholdChildren for why this replaced an earlier
//      network-interception approach that turned out to be unreliable.
//      The actual fetch happens in background.js, not here: that endpoint
//      lives on parents.amazon.com, a different origin than this content
//      script runs on, and a content script's fetch is bound by the
//      hosting page's own CORS policy no matter what host_permissions
//      grants — only the extension's own privileged contexts (the
//      background service worker, the popup) get a real cross-origin
//      bypass. So this asks the background worker to do it instead.
//   2. "Pull reading data" — fetch a date range of activity for each saved
//      kid, best-effort-enrich with ISBN, and store it for the Beanstack
//      side to pick up. This one *is* same-origin (www.amazon.com), so it
//      fetches directly, no background worker needed.
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
  const { getKids, addOrUpdateKid, removeKid, mergeReadingDataset } = await import(chrome.runtime.getURL("lib/store.js"));
  const { wirePanelChrome } = await import(chrome.runtime.getURL("lib/panel-chrome.js"));

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

  function buildPanel() {
    const panel = document.createElement("div");
    panel.id = "kb-amazon-panel";
    panel.style.cssText = `
      position: fixed; top: 16px; right: 16px; z-index: 999999;
      width: 320px; background: #fff; color: #111; border: 1px solid #ccc;
      border-radius: 8px; box-shadow: 0 2px 12px rgba(0,0,0,0.25);
    `;
    panel.innerHTML = `
      <div data-kb-role="header" class="kb-bold" style="cursor:move; user-select:none; display:flex; align-items:center; justify-content:space-between; padding:8px 10px; border-bottom:1px solid #eee;">
        <span>Kindle → Beanstack</span>
        <span>
          <button type="button" data-kb-role="minimize" title="Minimize" style="width:22px; height:22px; line-height:1; padding:0;">–</button>
          <button type="button" data-kb-role="close" title="Close" style="width:22px; height:22px; line-height:1; padding:0; margin-left:4px;">×</button>
        </span>
      </div>
      <div data-kb-role="body" style="padding:12px;">
        <div style="margin-bottom:10px;">
          <div class="kb-bold" style="font-size:12px; color:#555;">1. Kids</div>
          <button id="kb-detect-btn" style="margin-top:4px;">Detect kids</button>
          <div id="kb-detect-status" style="font-size:12px; color:#555; margin-top:4px;"></div>
          <ul id="kb-kids-list" style="margin:6px 0 0; padding-left:18px;"></ul>
        </div>

        <div>
          <div class="kb-bold" style="font-size:12px; color:#555;">2. Pull reading data</div>
          <div style="margin-top:4px;">
            <input type="date" id="kb-start-date" style="width:130px;">
            &ndash;
            <input type="date" id="kb-end-date" style="width:130px;">
          </div>
          <button id="kb-pull-btn" style="margin-top:6px;">Pull reading data</button>
          <div id="kb-pull-status" style="font-size:12px; color:#555; margin-top:4px;"></div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);
    wirePanelChrome(panel, { reopenLabel: "K→Beanstack" });
    return panel;
  }

  async function refreshKidsList(panel) {
    const kids = await getKids();
    const list = panel.querySelector("#kb-kids-list");
    list.innerHTML = kids
      .map(
        (k) => `
      <li>
        ${escapeHtml(k.name)} <span style="color:#999;">(…${k.childDirectedId.slice(-6)})</span>
        <a href="#" data-child-id="${escapeHtml(k.childDirectedId)}" class="kb-remove-kid" style="color:#c33; margin-left:6px;">remove</a>
      </li>`
      )
      .join("");
    list.querySelectorAll(".kb-remove-kid").forEach((link) => {
      link.addEventListener("click", async (e) => {
        e.preventDefault();
        await removeKid(link.dataset.childId);
        await refreshKidsList(panel);
      });
    });
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  async function detectKids(panel) {
    const statusEl = panel.querySelector("#kb-detect-status");
    statusEl.textContent = "Detecting…";
    const response = await chrome.runtime.sendMessage({ type: "kb-fetch-household-children" });
    if (!response?.ok) {
      statusEl.textContent = `Error: ${response?.error ?? "background worker did not respond"}`;
      return;
    }
    for (const child of response.children) {
      await addOrUpdateKid(child);
    }
    statusEl.textContent = `Found ${response.children.length} kid${response.children.length === 1 ? "" : "s"}.`;
    await refreshKidsList(panel);
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
    const failures = [];
    for (const kid of kids) {
      statusEl.textContent = `Pulling ${kid.name}'s reading activity…`;
      try {
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
      } catch (err) {
        // One kid's request failing (e.g. a stale/malformed childDirectedId
        // left over from testing) shouldn't block the rest of the household
        // from getting pulled — note it and keep going.
        failures.push(`${kid.name}: ${err.message}`);
      }
    }
    const failureNote = failures.length ? ` Failed: ${failures.join("; ")}.` : "";
    statusEl.textContent = `Done. Pulled ${totalEntries} (day, title) entries across ${kids.length - failures.length}/${kids.length} kid(s).${failureNote} Head to Beanstack to review and log them.`;
  }

  async function init() {
    const panel = buildPanel();
    panel.querySelector("#kb-start-date").value = daysAgoISO(60);
    panel.querySelector("#kb-end-date").value = todayISO();

    panel.querySelector("#kb-detect-btn").addEventListener("click", () => {
      detectKids(panel).catch((err) => {
        panel.querySelector("#kb-detect-status").textContent = `Error: ${err.message}`;
      });
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
