// Floating panel injected on the library's Beanstack site. Loads the
// reading dataset pulled from Amazon, searches Beanstack's catalog for each
// not-yet-submitted (kid, date, title), shows a review table you approve or
// override before anything is sent, then submits the accepted rows one at a
// time with a small delay between requests.

import { installAuthTokenWatcher, getCapturedToken, searchCatalog, getCsrfToken, buildLogPayload, submitLog } from "../lib/beanstack-client.js";
import { pickBestMatch } from "../lib/matcher.js";
import { getKids, getReadingDataset } from "../lib/store.js";
import { getSubmittedKeys, markSubmitted, isSubmitted } from "../lib/dedupe-store.js";

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
    width: 420px; max-height: 80vh; overflow-y: auto;
    background: #fff; color: #111; border: 1px solid #ccc;
    border-radius: 8px; box-shadow: 0 2px 12px rgba(0,0,0,0.25);
    font: 13px -apple-system, sans-serif; padding: 12px;
  `;
  panel.innerHTML = `
    <div style="font-weight:600; margin-bottom:8px;">Kindle → Beanstack: Review &amp; Log</div>
    <div id="kb-pairing-section"></div>
    <button id="kb-review-btn" style="margin-top:8px;">Find matches to review</button>
    <div id="kb-review-status" style="font-size:12px; color:#555; margin-top:4px;"></div>
    <div id="kb-review-table"></div>
    <button id="kb-submit-btn" style="margin-top:8px; display:none;">Submit accepted</button>
    <div id="kb-submit-status" style="font-size:12px; color:#555; margin-top:4px;"></div>
  `;
  document.body.appendChild(panel);
  return panel;
}

async function renderPairingSection(panel) {
  const kids = await getKids();
  const pairings = await getReaderPairings();
  const section = panel.querySelector("#kb-pairing-section");
  if (kids.length === 0) {
    section.innerHTML = `<div style="color:#888;">No kids configured yet — set those up from the panel on your Amazon Parent Dashboard first.</div>`;
    return;
  }
  section.innerHTML = `
    <div style="font-weight:600; font-size:12px; color:#555;">Pair each kid with their Beanstack profile ID</div>
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
}

/**
 * Finding the Beanstack profile_id for a reader requires opening the
 * "Log Reading" flow once while that reader is selected (see README) — it's
 * not readable from the dashboard page alone. This panel just stores
 * whatever you enter rather than trying to auto-detect it here.
 */

let reviewRows = []; // { entry, candidate, confidence, reason, accepted }

async function findMatches(panel) {
  const statusEl = panel.querySelector("#kb-review-status");
  const kids = await getKids();
  const pairings = await getReaderPairings();
  const dataset = await getReadingDataset();
  const submitted = await getSubmittedKeys();

  const pending = dataset.filter((entry) => !isSubmitted(submitted, entry) && pairings[entry.childDirectedId]);
  if (pending.length === 0) {
    statusEl.textContent = "Nothing to review — either everything's already logged, or no reading data has been pulled yet.";
    return;
  }

  if (!getCapturedToken()) {
    statusEl.textContent = "Waiting for a Beanstack search token — open \"Log Reading\" → search any title once, then click this again.";
    return;
  }

  reviewRows = [];
  const kidByChildId = new Map(kids.map((k) => [k.childDirectedId, k.name]));
  for (let i = 0; i < pending.length; i++) {
    const entry = pending[i];
    statusEl.textContent = `Searching Beanstack's catalog (${i + 1}/${pending.length})…`;
    let candidates = [];
    try {
      candidates = await searchCatalog({ title: entry.title, author: "", isbn: entry.isbn });
    } catch (err) {
      statusEl.textContent = `Error searching for "${entry.title}": ${err.message}`;
      return;
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
  statusEl.textContent = `Found matches for ${reviewRows.length} entries. Review below, then submit.`;
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
  let successCount = 0;
  const submittedEntries = [];
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
        submittedEntries.push(row.entry);
      }
    } catch (err) {
      statusEl.textContent = `Stopped on error submitting "${row.entry.title}": ${err.message}`;
      break;
    }
    // Small randomized delay between submissions — a good-citizen pace,
    // not a requirement of Beanstack's ToS, but cheap insurance.
    await new Promise((r) => setTimeout(r, 400 + Math.random() * 500));
  }
  await markSubmitted(submittedEntries);
  statusEl.textContent = `Submitted ${successCount}/${accepted.length}. Re-run "Find matches" to see what's left.`;
}

async function init() {
  installAuthTokenWatcher();
  const panel = buildPanel();
  await renderPairingSection(panel);

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
