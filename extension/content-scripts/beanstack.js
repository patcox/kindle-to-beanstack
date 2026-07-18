// Floating panel injected on the library's Beanstack site. Loads the
// reading dataset pulled from Amazon, reconciles it against what's already
// logged (so re-running this is idempotent even if local storage gets
// wiped — see reading-log.js), searches Beanstack's catalog for anything
// new, shows a review table you approve or override before anything is
// sent, and submits the accepted rows one at a time with a small delay
// between requests. After submitting, the panel lists exactly what was
// logged (kid, date, title) so a mistake can be found and deleted by hand
// on Beanstack — an earlier automated "Undo last batch" (diffing the log
// before/after to learn each new entry's id, since the create response
// carries none) was removed after live testing at real scale (142
// entries) showed it only resolving a handful of ids reliably; a simple,
// always-accurate list beats a mostly-broken automation here.
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
    parseReaderSwitcher,
  } = await import(chrome.runtime.getURL("lib/beanstack-client.js"));
  const { pickBestMatch, normalizeTitle, simplifyTitleForSearch } = await import(chrome.runtime.getURL("lib/matcher.js"));
  const { getKids, getReadingDataset, getMinMinutesThreshold, setMinMinutesThreshold } = await import(
    chrome.runtime.getURL("lib/store.js")
  );
  const { getSubmittedKeys, markSubmitted, isSubmitted } = await import(chrome.runtime.getURL("lib/dedupe-store.js"));
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
      width: 680px; max-width: 95vw; max-height: 80vh; overflow: hidden;
      background: #fff; color: #111; border: 1px solid #ccc;
      border-radius: 8px; box-shadow: 0 2px 12px rgba(0,0,0,0.25);
    `;
    panel.innerHTML = `
      <div data-kb-role="header" class="kb-bold" style="cursor:move; user-select:none; display:flex; align-items:center; justify-content:space-between; padding:8px 10px; border-bottom:1px solid #eee;">
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
        <div id="kb-submit-list"></div>
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
      // Fallback for pages with no reader-switcher to auto-detect from
      // (e.g. the Log Reading / catalog search page). A pairing saved
      // earlier (from a page that did have the switcher) is reused here —
      // shown as a plain confirmed line, not an editable box. profile_id is
      // an opaque internal number nobody would recognize or want to type by
      // hand; if a pairing is wrong, fix it from a page with the switcher,
      // which lets you pick by name instead. The input below only appears
      // for a kid with no saved pairing at all yet (the rare single-reader
      // account with no switcher anywhere).
      section.innerHTML = `
        <div class="kb-bold" style="font-size:12px; color:#555;">Kid ↔ Beanstack reader</div>
        <div style="color:#888; font-size:12px;">Couldn't auto-detect readers on this page — showing pairings saved from elsewhere. To fix a wrong one, visit a page with the reader switcher.</div>
        ${kids
          .map((k) => {
            const saved = pairings[k.childDirectedId];
            if (saved) {
              return `<div style="margin-top:4px;">${escapeHtml(k.name)} <span style="color:#999;">(→ ${escapeHtml(saved)})</span></div>`;
            }
            return `
              <div style="margin-top:4px;">
                ${escapeHtml(k.name)}:
                <input type="text" data-child-id="${escapeHtml(k.childDirectedId)}" class="kb-pairing-input"
                       placeholder="Beanstack profile_id" style="width:140px;">
              </div>`;
          })
          .join("")}
      `;
      section.querySelectorAll(".kb-pairing-input").forEach((input) => {
        input.addEventListener("change", async () => {
          await setReaderPairing(input.dataset.childId, input.value.trim());
          await renderPairingSection(panel);
        });
      });
      return;
    }

    section.innerHTML = `
      <div class="kb-bold" style="font-size:12px; color:#555;">Kid ↔ Beanstack reader (auto-detected, matched by name — override below)</div>
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
      let searchError = null;
      try {
        candidates = await searchCatalog({ title: entry.title, author: "", isbn: entry.isbn });
      } catch (err) {
        searchError = err;
      }
      if (candidates.length === 0) {
        // The exact Amazon title (with its imprint/series decorations)
        // sometimes matches nothing — or Beanstack rejects it outright with
        // a 400 for being too long/complex (e.g. a bundle listing) — even
        // when the underlying book is in the catalog under a plainer title.
        // Worth one retry with that stripped down either way, not just on
        // an empty-but-successful result.
        const simplified = simplifyTitleForSearch(entry.title);
        if (simplified) {
          try {
            candidates = await searchCatalog({ title: simplified, author: "", isbn: entry.isbn });
            searchError = null;
          } catch (err) {
            searchError = err;
          }
        }
      }
      if (searchError && candidates.length === 0) {
        // Still no luck after the retry — one title's search failing
        // shouldn't block every other entry after it; show it as a
        // failed/no-match row instead of aborting the whole batch.
        searchFailures.push(`${entry.title}: ${searchError.message}`);
        reviewRows.push({
          entry,
          kidName: kidByChildId.get(entry.childDirectedId) ?? entry.childDirectedId,
          candidate: null,
          confidence: "none",
          reason: `search failed: ${searchError.message}`,
          accepted: false,
          manualTitle: entry.title,
          manualAuthor: "",
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
        // Pre-filled so a "no match" row is submittable right away (as a
        // manual entry, mirroring Beanstack's own "Manually Enter Title")
        // without forcing a click first — editable before submitting.
        manualTitle: candidate ? null : entry.title,
        manualAuthor: "",
      });
    }
    const failureSuffix = searchFailures.length ? ` (${searchFailures.length} search failed — see table)` : "";
    statusEl.textContent = `Found matches for ${reviewRows.length} entries${skippedSuffix}${failureSuffix}. Review below, then submit.`;
    renderReviewTable(panel);
  }

  function canAccept(row) {
    return Boolean(row.candidate) || Boolean(row.manualTitle && row.manualTitle.trim());
  }

  /** Discards an auto-matched candidate so the row switches to manual entry. */
  function rejectMatch(row) {
    row.candidate = null;
    row.manualTitle = row.entry.title;
    row.manualAuthor = "";
    row.accepted = false;
  }

  function renderReviewTable(panel) {
    const container = panel.querySelector("#kb-review-table");
    const confidenceColor = { high: "#2a7", medium: "#c90", low: "#c33", none: "#999" };
    container.innerHTML = `
      <table style="width:100%; border-collapse:collapse; table-layout:fixed; font-size:12px; margin-top:8px;">
        <colgroup>
          <col style="width:28px;"><col style="width:64px;"><col style="width:64px;">
          <col><col><col style="width:44px;"><col style="width:60px;">
        </colgroup>
        <thead><tr>
          <th style="text-align:left;">✓</th><th style="text-align:left;">Kid</th><th style="text-align:left;">Date</th>
          <th style="text-align:left;">Amazon title</th><th style="text-align:left;">Matched</th>
          <th style="text-align:left;">Min</th><th style="text-align:left;">Conf.</th>
        </tr></thead>
        <tbody>
          ${reviewRows
            .map((row, i) => {
              const matchedCell = row.candidate
                ? `
                  <div title="${escapeHtml(row.candidate.title)}${row.candidate.authors ? ` — ${escapeHtml(row.candidate.authors)}` : ""}">
                    <div style="overflow-wrap:break-word;">${escapeHtml(row.candidate.title)}</div>
                    ${row.candidate.authors ? `<div style="color:#888; font-size:11px;">${escapeHtml(row.candidate.authors)}</div>` : ""}
                  </div>
                  <button type="button" class="kb-reject-match" data-row="${i}" style="font-size:11px; margin-top:3px; padding:1px 4px;">use manual entry instead</button>
                `
                : `
                  <input type="text" data-row="${i}" class="kb-manual-title" placeholder="Title (manual entry)"
                         value="${escapeHtml(row.manualTitle ?? "")}" style="width:100%; box-sizing:border-box;">
                  <input type="text" data-row="${i}" class="kb-manual-author" placeholder="Author (optional)"
                         value="${escapeHtml(row.manualAuthor ?? "")}" style="width:100%; box-sizing:border-box; display:block; margin-top:2px;">
                `;
              return `
            <tr style="border-top:1px solid #eee;">
              <td><input type="checkbox" data-row="${i}" class="kb-accept-cb" ${row.accepted ? "checked" : ""} ${canAccept(row) ? "" : "disabled"}></td>
              <td style="overflow-wrap:break-word;">${escapeHtml(row.kidName)}</td>
              <td style="overflow-wrap:break-word;">${escapeHtml(row.entry.date)}</td>
              <td style="overflow-wrap:break-word;" title="${escapeHtml(row.entry.title)}">${escapeHtml(row.entry.title)}</td>
              <td>${matchedCell}</td>
              <td>${Math.round(row.entry.minutes)}</td>
              <td style="color:${confidenceColor[row.candidate ? row.confidence : "none"]};" title="${escapeHtml(row.reason)}">${row.candidate ? row.confidence : "manual"}</td>
            </tr>`;
            })
            .join("")}
        </tbody>
      </table>
    `;
    container.querySelectorAll(".kb-accept-cb").forEach((cb) => {
      cb.addEventListener("change", () => {
        reviewRows[Number(cb.dataset.row)].accepted = cb.checked;
      });
    });
    container.querySelectorAll(".kb-reject-match").forEach((btn) => {
      btn.addEventListener("click", () => {
        rejectMatch(reviewRows[Number(btn.dataset.row)]);
        renderReviewTable(panel);
      });
    });
    container.querySelectorAll(".kb-manual-title").forEach((input) => {
      input.addEventListener("input", () => {
        const row = reviewRows[Number(input.dataset.row)];
        row.manualTitle = input.value;
        const cb = container.querySelector(`.kb-accept-cb[data-row="${input.dataset.row}"]`);
        cb.disabled = !canAccept(row);
        if (cb.disabled) {
          cb.checked = false;
          row.accepted = false;
        }
      });
    });
    container.querySelectorAll(".kb-manual-author").forEach((input) => {
      input.addEventListener("input", () => {
        reviewRows[Number(input.dataset.row)].manualAuthor = input.value;
      });
    });
    panel.querySelector("#kb-submit-btn").style.display = reviewRows.length ? "inline-block" : "none";
  }

  function submittedTitle(row) {
    return row.candidate ? row.candidate.title : row.manualTitle;
  }

  async function submitAccepted(panel) {
    const statusEl = panel.querySelector("#kb-submit-status");
    const pairings = await getReaderPairings();
    const csrfToken = getCsrfToken();
    const accepted = reviewRows.filter((r) => r.accepted && canAccept(r));
    if (accepted.length === 0) {
      statusEl.textContent = "Nothing accepted to submit.";
      return;
    }

    let successCount = 0;
    const submittedRows = [];
    const submitFailures = [];
    for (let i = 0; i < accepted.length; i++) {
      const row = accepted[i];
      statusEl.textContent = `Submitting ${i + 1}/${accepted.length}…`;
      try {
        // Built inside the try — an invalid row (e.g. minutes rounding to
        // 0) should fail just that row, not throw synchronously and abort
        // every row after it.
        const payload = buildLogPayload({
          profileId: pairings[row.entry.childDirectedId],
          candidate: row.candidate,
          manualTitle: row.candidate ? undefined : row.manualTitle.trim(),
          manualAuthor: row.candidate ? undefined : row.manualAuthor?.trim(),
          date: row.entry.date,
          minutes: row.entry.minutes,
        });
        const resp = await submitLog(payload, { csrfToken });
        if (resp.ok) {
          successCount++;
          submittedRows.push(row);
        } else {
          // fetch() doesn't throw on a 4xx/5xx status — resp.ok is just
          // false — so this has to be checked explicitly or a failure like
          // a 422 validation error passes through completely silently.
          let detail = `HTTP ${resp.status}`;
          try {
            const body = await resp.json();
            if (body && Object.keys(body).length) detail += `: ${JSON.stringify(body)}`;
          } catch {
            // Response body wasn't JSON (or was empty) — the status code is
            // still useful on its own.
          }
          submitFailures.push(`${row.entry.title}: ${detail}`);
        }
      } catch (err) {
        submitFailures.push(`${row.entry.title}: ${err.message}`);
      }
      // Small randomized delay between submissions — a good-citizen pace,
      // not a requirement of Beanstack's ToS, but cheap insurance.
      await new Promise((r) => setTimeout(r, 400 + Math.random() * 500));
    }

    await markSubmitted(submittedRows.map((r) => r.entry));
    const failureNote = submitFailures.length ? ` Failed: ${submitFailures.join("; ")}.` : "";
    statusEl.textContent = `Submitted ${successCount}/${accepted.length}.${failureNote}`;
    renderSubmittedList(panel, submittedRows);
  }

  /**
   * Plain confirmation list of what this batch actually logged — no
   * Beanstack ID lookups involved, so it's always accurate (unlike the
   * removed undo feature, which depended on diffing the log before/after
   * to guess each new entry's id and only worked reliably at small scale).
   * If something needs fixing, find it here by kid/date/title and delete
   * it directly on Beanstack.
   */
  function renderSubmittedList(panel, rows) {
    const container = panel.querySelector("#kb-submit-list");
    if (!rows.length) {
      container.innerHTML = "";
      return;
    }
    container.innerHTML = `
      <div class="kb-bold" style="font-size:12px; color:#555; margin-top:6px;">Logged this batch (find/delete manually on Beanstack if something's wrong):</div>
      <ul style="margin:4px 0 0; padding-left:18px; font-size:12px;">
        ${rows
          .map((r) => `<li>${escapeHtml(r.kidName)} — ${escapeHtml(r.entry.date)} — ${escapeHtml(submittedTitle(r))}</li>`)
          .join("")}
      </ul>
    `;
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
  }

  init();
})();
