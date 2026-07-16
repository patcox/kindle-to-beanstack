import { getKids, getReadingDataset } from "../lib/store.js";
import { buildReport } from "../lib/report.js";

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtMinutes(m) {
  const total = Math.round(m);
  const h = Math.floor(total / 60);
  const mm = total % 60;
  return h ? `${h}h ${mm}m` : `${mm}m`;
}

async function render() {
  const kids = await getKids();
  const dataset = await getReadingDataset();
  const container = document.getElementById("report");

  if (kids.length === 0) {
    container.innerHTML = `<div class="empty">No kids configured yet.</div>`;
    return;
  }
  if (dataset.length === 0) {
    container.innerHTML = `<div class="empty">No reading data pulled yet — use the panel on your Amazon Parent Dashboard.</div>`;
    return;
  }

  const report = buildReport(dataset, kids);
  container.innerHTML = Object.values(report)
    .map(
      (kidReport) => `
      <h2>${escapeHtml(kidReport.name)} — ${fmtMinutes(kidReport.totalMinutes)} total, ${kidReport.titles.length} titles</h2>
      <table>
        <thead><tr><th colspan="3">Weekly (Mon–Sun)</th></tr></thead>
        <tbody>
          ${kidReport.weeks
            .map(
              (w) => `<tr class="week-row"><td>${w.weekStart}</td><td>–</td><td>${fmtMinutes(w.minutes)}</td></tr>`
            )
            .join("")}
        </tbody>
      </table>
      <table>
        <thead><tr><th>Title</th><th style="text-align:right;">Time</th></tr></thead>
        <tbody>
          ${kidReport.titles
            .map((t) => `<tr><td>${escapeHtml(t.title)}</td><td style="text-align:right;">${fmtMinutes(t.minutes)}</td></tr>`)
            .join("")}
        </tbody>
      </table>
    `
    )
    .join("");
}

render();
