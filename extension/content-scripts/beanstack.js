// Floating panel injected on the library's Beanstack site. Loads the
// reading dataset pulled from Amazon, reconciles it against what's already
// logged (so re-running this is idempotent even if local storage gets
// wiped — see reading-log.js), searches Beanstack's catalog for anything
// new, shows a review table you approve or override before anything is
// sent, submits the accepted rows one at a time with a small delay between
// requests, and can undo the most recent batch if something went wrong.
//
// Chrome's manifest.json content_scripts array has no way to declare a
// script as an ES module (that's only supported for content scripts
// registered dynamically via chrome.scripting.registerContentScripts,
// which this project doesn't use). So this file loads as a classic
// script — everything lives inside one async IIFE so it can use
// dynamic import() (valid in classic scripts; top-level import/export
// and top-level await are not) to pull in the real lib modules.

(async () => {
  const {
    installAuthTokenWatcher,
    getCapturedToken,
    searchCatalog,
    getCsrfToken,
    buildLogPayload,
    submitLog,
    deleteLoggedEntry,
    parseReaderSwitcher,
  } = await import(chrome.runtime.getURL("lib/beanstack-client.js"));
  const { pickBestMatch, normalizeTitle } = await import(chrome.runtime.getURL("lib/matcher.js"));
  const { getKids, getReadingDataset, getMinMinutesThreshold, setMinMinutesThreshold } = await import(
    chrome.runtime.getURL("lib/store.js")
  );
  const { getSubmittedKeys, markSubmitted, unmarkSubmitted, isSubmitted, recordBatch, getLastBatch, clearLastBatch } =
    await import(chrome.runtime.getURL("lib/dedupe-store.js"));
  const { splitByThreshold } = await import(chrome.runtime.getURL("lib/report.js"));
  const { fetchExistingLog, summarizeExistingLog } = await import(chrome.runtime.getURL("lib/reading-log.js"));
  const { wirePanelChrome } = await import(chrome.runtime.getURL("lib/panel-chrome.js"));

  const READER_PAIRINGS_KEY = "kb_reader_pairings"; // { [childDirectedId]: beanstackProfileId }

  async function getReaderPairings() {
    const { [READER_PAIRINGS_KEY]: pairings } = await chrome.storage.local.get(READER_PAIRINGS_KEY);
    return pairings ?? {};
  }

  async function setReaderPairing(childDirectedId, profileId) {
    const pairings = await getReaderPairings();
    pairings[childDirectedId] = profileId;
    await chrome.storage.local.set({ [READER_PAIRINGS_KEY]: pairings });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function buildPanel() {
    const panel = document.createElement("div");
    panel.id = "kb-beanstack-panel";
    panel.style.cssText = `
      position: fixed; top: 16px; right: 16px; z-index: 999999;
      width: 440px; max-height: 80vh; overflow: hidden;
      background: #fff; color: #111; border: 1px solid #ccc;
      border-radius: 8px; box-shadow: 0 2px 12px rgba(0,0,0,0.25);
      font: 13px -apple-system, sans-serif;
    `;
    panel.innerHTML = `
      <div data-kb-role="header" style="cursor:move; user-select:none; display:flex; align-items:center; justify-content:space-between; padding:8px 10px; border-bottom:1px solid #eee; font-weight:600;">
        <span>Kindle → Beanstack: Review &amp; Log</span>
        <span>
          <button type="button" data-kb-role="minimize" title="Minimize" style="width:22px; height:22px; line-height:1; padding:0;">–</button>
          <button type="button" data-kb-role="close" title="Close" style="width:22px; height:22px; line-height:1; padding:0; margin-left:4px;">×</button>
        </span>
      </div>
      <div data-kb-role="body" style="padding:12px; max-height:calc(80vh - 39px); overflow-y:auto;">
        <div id="kb-pairing-section"></div>
        <div style="margin-top:8px;">
          Skip entries under <input type="number" id="kb-threshold-input" min="0" step="1" style="width:50px;"> minutes
        </div>
        <button id="kb-review-btn" style="margin-top:8px;">Find matches to review</button>
        <div id="kb-review-status" style="font-size:12px; color:#555; margin-top:4px;"></div>
        <div id="kb-review-table"></div>
        <button id="kb-submit-btn" style="margin-top:8px; display:none;">Submit accepted</button>
        <div id="kb-submit-status" style="font-size:12px; color:#555; margin-top:4px;"></div>
        <hr style="margin:12px 0; border:none; border-top:1px solid #eee;">
        <button id="kb-undo-btn">Undo last batch</button>
        <div id="kb-undo-status" style="font-size:12px; color:#555; margin-top:4px;"></div>
      </div>
    `;
    document.body.appendChild(panel);
    wirePanelChrome(panel, { reopenLabel: "K→Beanstack" });
    return panel;
  }

  /**
   * Reads every reader straight off the page (see parseReaderSwitcher) and
   * auto-pairs any Amazon kid whose name matches a Beanstack reader's name
   * exactly (case-insensitive) that isn't already paired. Manual correction
   * is still available via the dropdown for names that don't line up.
   */
  async function autoPairByName(kids, readers) {
    const pairings = await getReaderPairings();
    const readerByName = new Map(readers.map((r) => [r.name.trim().toLowerCase(), r]));
    for (const kid of kids) {
      if (pairings[kid.childDirectedId]) continue;
      const match = readerByName.get(kid.name.trim().toLowerCase());
      if (match) await setReaderPairing(kid.childDirectedId, match.profileId);
    }
  }

  async function renderPairingSection(panel) {
    const kids = await getKids();
    const section = panel.querySelector("#kb-pairing-section");
    if (kids.length === 0) {
      section.innerHTML = `<div style="color:#888;">No kids configured yet — set those up from the panel on your Amazon Parent Dashboard first.</div>`;
      return;
    }

    const readers = parseReaderSwitcher();
    await autoPairByName(kids, readers);
    const pairings = await getReaderPairings();

    if (readers.length === 0) {
      // Fallback for the rare case the reader-switcher isn't on this page
      // (e.g. a single-reader account with no switcher at all).
      section.innerHTML = `
        <div style="font-weight:600; font-size:12px; color:#555;">Pair each kid with their Beanstack profile ID</div>
        <div style="color:#888; font-size:12px;">Couldn't auto-detect readers on this page — enter profile_id manually.</div>
        ${kids
          .map(
            (k) => `
          <div style="margin-top:4px;">
            ${escapeHtml(k.name)}:
            <input type="text" data-child-id="${escapeHtml(k.childDirectedId)}" class="kb-pairing-input"
                   placeholder="Beanstack profile_id" value="${escapeHtml(pairings[k.childDirectedId] ?? "")}"
                   style="width:140px;">
          </div>`
          )
          .join("")}
      `;
      section.querySelectorAll(".kb-pairing-input").forEach((input) => {
        input.addEventListener("change", () => setReaderPairing(input.dataset.childId, input.value.trim()));
      });
      return;
    }

    section.innerHTML = `
      <div style="font-weight:600; font-size:12px; color:#555;">Kid ↔ Beanstack reader (auto-detected, matched by name — override below)</div>
      ${kids
        .map(
          (k) => `
        <div style="margin-top:4px;">
          ${escapeHtml(k.name)}:
          <select data-child-id="${escapeHtml(k.childDirectedId)}" class="kb-pairing-select">
            <option value="">(none)</option>
            ${readers
              .map(
                (r) =>
                  `<option value="${escapeHtml(r.profileId)}" ${pairings[k.childDirectedId] === r.profileId ? "selected" : ""}>${escapeHtml(r.name)}</option>`
              )
              .join("")}
          </select>
        </div>`
        )
        .join("")}
    `;
    section.querySelectorAll(".kb-pairing-select").forEach((select) => {
      select.addEventListener("change", () => setReaderPairing(select.dataset.childId, select.value));
    });
  }

  let reviewRows = []; // { entry, candidate, confidence, reason, accepted }
  let existingLogByProfile = new Map(); // profileId -> Map("date|normalizedTitle" -> {minutes, loggedBookIds})

  async function findMatches(panel) {
    const statusEl = panel.querySelector("#kb-review-status");
    const kids = await getKids();
    const pairings = await getReaderPairings();
    const dataset = await getReadingDataset();
    const submitted = await getSubmittedKeys();

    const eligible = dataset.filter((entry) => !isSubmitted(submitted, entry) && pairings[entry.childDirectedId]);
    if (eligible.length === 0) {
      statusEl.textContent = "Nothing to review — either everything's already logged, or no reading data has been pulled yet.";
      return;
    }

    const threshold = await getMinMinutesThreshold();
    const { kept: afterThreshold, excluded: belowThreshold } = splitByThreshold(eligible, threshold);
    if (afterThreshold.length === 0) {
      statusEl.textContent = `Nothing above the ${threshold}-minute threshold (${belowThreshold.length} skipped).`;
      return;
    }

    if (!getCapturedToken()) {
      statusEl.textContent = "Waiting for a Beanstack search token — open \"Log Reading\" → search any title once, then click this again.";
      return;
    }

    // Reconcile against what Beanstack already has, per profile, so this is
    // safe to re-run even if local storage was cleared/reinstalled — the
    // check is against server truth, not just our own memory (see README).
    // Keyed on (date, title) alone, not amount: this assumes the tool is the
    // only thing logging reading for these readers, so any existing entry
    // for that day/book — regardless of its minutes — means it's covered.
    // If that assumption doesn't hold for you (you also log manually), a
    // manual entry for the same book/day will cause this to skip Amazon's
    // (likely larger) total rather than adding to it.
    statusEl.textContent = "Checking what's already logged…";
    existingLogByProfile = new Map();
    const profileIds = [...new Set(afterThreshold.map((e) => pairings[e.childDirectedId]))];
    const dates = afterThreshold.map((e) => e.date).sort();
    const dateRange = { startDate: dates[0], endDate: dates[dates.length - 1] };
    for (const profileId of profileIds) {
      const existing = await fetchExistingLog(profileId, dateRange);
      existingLogByProfile.set(profileId, summarizeExistingLog(existing, normalizeTitle));
    }

    const alreadyCovered = [];
    const toMatch = [];
    for (const entry of afterThreshold) {
      const profileId = pairings[entry.childDirectedId];
      const key = `${entry.date}|${normalizeTitle(entry.title)}`;
      if (existingLogByProfile.get(profileId)?.has(key)) {
        alreadyCovered.push(entry);
      } else {
        toMatch.push(entry);
      }
    }
    if (alreadyCovered.length) await markSubmitted(alreadyCovered); // genuinely already there — remember locally too

    const skippedNote = [
      belowThreshold.length ? `${belowThreshold.length} under ${threshold} min` : null,
      alreadyCovered.length ? `${alreadyCovered.length} already logged` : null,
    ]
      .filter(Boolean)
      .join(", ");
    const skippedSuffix = skippedNote ? ` (skipped: ${skippedNote})` : "";

    if (toMatch.length === 0) {
      statusEl.textContent = `Nothing new to review${skippedSuffix}.`;
      reviewRows = [];
      renderReviewTable(panel);
      return;
    }

    reviewRows = [];
    const kidByChildId = new Map(kids.map((k) => [k.childDirectedId, k.name]));
    const searchFailures = [];
    for (let i = 0; i < toMatch.length; i++) {
      const entry = toMatch[i];
      statusEl.textContent = `Searching Beanstack's catalog (${i + 1}/${toMatch.length})…`;
      let candidates = [];
      try {
        candidates = await searchCatalog({ title: entry.title, author: "", isbn: entry.isbn });
      } catch (err) {
        // One title's search failing (Beanstack has rejected some unusual
        // titles, e.g. multi-book bundle listings, with a 400) shouldn't
        // block every other entry after it — show it as a failed/no-match
        // row instead of aborting the whole batch.
        searchFailures.push(`${entry.title}: ${err.message}`);
        reviewRows.push({
          entry,
          kidName: kidByChildId.get(entry.childDirectedId) ?? entry.childDirectedId,
          candidate: null,
          confidence: "none",
          reason: `search failed: ${err.message}`,
          accepted: false,
        });
        continue;
      }
      const { candidate, confidence, reason } = pickBestMatch({ candidates, queryTitle: entry.title, queryIsbn: entry.isbn });
      reviewRows.push({
        entry,
        kidName: kidByChildId.get(entry.childDirectedId) ?? entry.childDirectedId,
        candidate,
        confidence,
        reason,
        accepted: confidence === "high" || confidence === "medium",
      });
    }
    const failureSuffix = searchFailures.length ? ` (${searchFailures.length} search failed — see table)` : "";
    statusEl.textContent = `Found matches for ${reviewRows.length} entries${skippedSuffix}${failureSuffix}. Review below, then submit.`;
    renderReviewTable(panel);
  }

  function renderReviewTable(panel) {
    const container = panel.querySelector("#kb-review-table");
    const confidenceColor = { high: "#2a7", medium: "#c90", low: "#c33", none: "#999" };
    container.innerHTML = `
      <table style="width:100%; border-collapse:collapse; font-size:12px; margin-top:8px;">
        <thead><tr>
          <th style="text-align:left;">✓</th><th style="text-align:left;">Kid</th><th style="text-align:left;">Date</th>
          <th style="text-align:left;">Amazon title</th><th style="text-align:left;">Matched</th>
          <th style="text-align:left;">Min</th><th style="text-align:left;">Confidence</th>
        </tr></thead>
        <tbody>
          ${reviewRows
            .map(
              (row, i) => `
            <tr style="border-top:1px solid #eee;">
              <td><input type="checkbox" data-row="${i}" class="kb-accept-cb" ${row.accepted ? "checked" : ""} ${row.candidate ? "" : "disabled"}></td>
              <td>${escapeHtml(row.kidName)}</td>
              <td>${escapeHtml(row.entry.date)}</td>
              <td>${escapeHtml(row.entry.title)}</td>
              <td>${row.candidate ? escapeHtml(row.candidate.title) : "(no match)"}</td>
              <td>${Math.round(row.entry.minutes)}</td>
              <td style="color:${confidenceColor[row.confidence]};" title="${escapeHtml(row.reason)}">${row.confidence}</td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
    `;
    container.querySelectorAll(".kb-accept-cb").forEach((cb) => {
      cb.addEventListener("change", () => {
        reviewRows[Number(cb.dataset.row)].accepted = cb.checked;
      });
    });
    panel.querySelector("#kb-submit-btn").style.display = reviewRows.length ? "inline-block" : "none";
  }

  async function submitAccepted(panel) {
    const statusEl = panel.querySelector("#kb-submit-status");
    const pairings = await getReaderPairings();
    const csrfToken = getCsrfToken();
    const accepted = reviewRows.filter((r) => r.accepted && r.candidate);
    if (accepted.length === 0) {
      statusEl.textContent = "Nothing accepted to submit.";
      return;
    }

    let successCount = 0;
    const submittedRows = [];
    for (let i = 0; i < accepted.length; i++) {
      const row = accepted[i];
      statusEl.textContent = `Submitting ${i + 1}/${accepted.length}…`;
      const payload = buildLogPayload({
        profileId: pairings[row.entry.childDirectedId],
        candidate: row.candidate,
        date: row.entry.date,
        minutes: row.entry.minutes,
      });
      try {
        const resp = await submitLog(payload, { csrfToken });
        if (resp.ok) {
          successCount++;
          submittedRows.push(row);
        }
      } catch (err) {
        statusEl.textContent = `Stopped on error submitting "${row.entry.title}": ${err.message}`;
        break;
      }
      // Small randomized delay between submissions — a good-citizen pace,
      // not a requirement of Beanstack's ToS, but cheap insurance.
      await new Promise((r) => setTimeout(r, 400 + Math.random() * 500));
    }

    await markSubmitted(submittedRows.map((r) => r.entry));
    statusEl.textContent = `Submitted ${successCount}/${accepted.length}. Resolving log IDs for undo…`;

    const batchRecords = await resolveNewLoggedBookIds(submittedRows, pairings);
    await recordBatch(batchRecords);
    const resolvedCount = batchRecords.filter((r) => r.loggedBookId).length;
    statusEl.textContent = `Submitted ${successCount}/${accepted.length}. ${resolvedCount}/${submittedRows.length} ready to undo if needed. Re-run "Find matches" to see what's left.`;
  }

  /**
   * The create response carries no ID (verified live — see beanstack-client.js
   * submitLog), so we learn each new entry's ID by re-reading the log after
   * submitting and finding, per (profile, date, title), whichever ID wasn't
   * there in the pre-submit snapshot already captured by findMatches.
   */
  async function resolveNewLoggedBookIds(submittedRows, pairings) {
    const byProfile = new Map();
    for (const row of submittedRows) {
      const profileId = pairings[row.entry.childDirectedId];
      if (!byProfile.has(profileId)) byProfile.set(profileId, []);
      byProfile.get(profileId).push(row);
    }

    const records = [];
    for (const [profileId, rows] of byProfile) {
      const dates = rows.map((r) => r.entry.date).sort();
      const existingAfter = await fetchExistingLog(profileId, { startDate: dates[0], endDate: dates[dates.length - 1] });
      const afterSummary = summarizeExistingLog(existingAfter, normalizeTitle);
      const beforeSummary = existingLogByProfile.get(profileId);

      for (const row of rows) {
        const key = `${row.entry.date}|${normalizeTitle(row.entry.title)}`;
        const beforeIds = new Set(beforeSummary?.get(key)?.loggedBookIds ?? []);
        const afterIds = afterSummary.get(key)?.loggedBookIds ?? [];
        const newId = afterIds.find((id) => !beforeIds.has(id)) ?? null;
        records.push({ entry: row.entry, loggedBookId: newId });
      }
    }
    return records;
  }

  async function undoLastBatch(panel) {
    const statusEl = panel.querySelector("#kb-undo-status");
    const batch = await getLastBatch();
    if (batch.length === 0) {
      statusEl.textContent = "Nothing to undo.";
      return;
    }
    const csrfToken = getCsrfToken();
    let undone = 0;
    const undoneEntries = [];
    for (let i = 0; i < batch.length; i++) {
      const { entry, loggedBookId } = batch[i];
      if (!loggedBookId) continue; // couldn't resolve an ID for this one — leave it, don't guess
      statusEl.textContent = `Undoing ${i + 1}/${batch.length}…`;
      try {
        const resp = await deleteLoggedEntry(loggedBookId, { csrfToken });
        if (resp.ok) {
          undone++;
          undoneEntries.push(entry);
        }
      } catch (err) {
        statusEl.textContent = `Stopped on error undoing "${entry.title}": ${err.message}`;
        break;
      }
      await new Promise((r) => setTimeout(r, 400 + Math.random() * 500));
    }
    await unmarkSubmitted(undoneEntries);
    await clearLastBatch();
    statusEl.textContent = `Undid ${undone}/${batch.length}. Those entries are eligible to review and submit again.`;
  }

  async function init() {
    installAuthTokenWatcher();
    const panel = buildPanel();
    await renderPairingSection(panel);

    const thresholdInput = panel.querySelector("#kb-threshold-input");
    thresholdInput.value = await getMinMinutesThreshold();
    thresholdInput.addEventListener("change", () => {
      const value = Math.max(0, Number(thresholdInput.value) || 0);
      thresholdInput.value = value;
      setMinMinutesThreshold(value);
    });

    panel.querySelector("#kb-review-btn").addEventListener("click", () => {
      findMatches(panel).catch((err) => {
        panel.querySelector("#kb-review-status").textContent = `Error: ${err.message}`;
      });
    });
    panel.querySelector("#kb-submit-btn").addEventListener("click", () => {
      submitAccepted(panel).catch((err) => {
        panel.querySelector("#kb-submit-status").textContent = `Error: ${err.message}`;
      });
    });
    panel.querySelector("#kb-undo-btn").addEventListener("click", () => {
      undoLastBatch(panel).catch((err) => {
        panel.querySelector("#kb-undo-status").textContent = `Error: ${err.message}`;
      });
    });
  }

  init();
})();
