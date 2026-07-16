import { getKids, getReadingDataset } from "../lib/store.js";

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function render() {
  const kids = await getKids();
  const kidsEl = document.getElementById("kids");
  kidsEl.innerHTML = kids.length
    ? `<ul>${kids.map((k) => `<li>${escapeHtml(k.name)}</li>`).join("")}</ul>`
    : `<div class="empty">None yet</div>`;

  const dataset = await getReadingDataset();
  const summaryEl = document.getElementById("dataset-summary");
  if (dataset.length === 0) {
    summaryEl.innerHTML = `<div class="empty">None yet</div>`;
    return;
  }
  const byKid = new Map();
  for (const kid of kids) byKid.set(kid.childDirectedId, { name: kid.name, entries: 0, minutes: 0 });
  for (const entry of dataset) {
    const bucket = byKid.get(entry.childDirectedId);
    if (!bucket) continue;
    bucket.entries += 1;
    bucket.minutes += entry.minutes;
  }
  summaryEl.innerHTML = `<ul>${[...byKid.values()]
    .map((b) => `<li>${escapeHtml(b.name)}: ${b.entries} entries, ${Math.round(b.minutes)} min</li>`)
    .join("")}</ul>`;
}

document.getElementById("view-summary-btn").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("popup/summary.html") });
});

render();
