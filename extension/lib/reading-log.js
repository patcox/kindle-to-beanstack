// Reads a reader's *existing* Beanstack log (the dated_reading_log page,
// one month at a time) so we can check what's already there before
// submitting anything new. This is what makes submission idempotent against
// server truth rather than just our own local memory (see README).

const MONTH_NAMES = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/** Pure. "Saturday, July 11, 2026" -> "2026-07-11". Returns null if unparseable. */
export function parseLongDate(text) {
  const match = (text || "").match(/([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/);
  if (!match) return null;
  const month = MONTH_NAMES[match[1].toLowerCase()];
  if (!month) return null;
  return `${match[3]}-${String(month).padStart(2, "0")}-${String(match[2]).padStart(2, "0")}`;
}

/**
 * Pure. Parses a dated_reading_log page (one month) into a flat list of
 * existing entries. Each `.reader-log-item` link carries the Beanstack log
 * ID in its href; its date comes from the nearest `.reader-log-day`
 * ancestor's screen-reader date span, which — unlike the visible "11" —
 * includes the full month/year, so no assumptions about which month we
 * asked for are needed.
 * @returns {{loggedBookId: string, title: string, minutes: number, date: string}[]}
 */
export function parseExistingLog(doc) {
  const entries = [];
  const seenIds = new Set();
  for (const item of doc.querySelectorAll("a.reader-log-item")) {
    const idMatch = (item.getAttribute("href") || "").match(/reading_log\/(\d+)/);
    if (!idMatch) continue;
    const loggedBookId = idMatch[1];
    if (seenIds.has(loggedBookId)) continue; // page renders each entry twice (desktop+mobile)
    seenIds.add(loggedBookId);

    const dayEl = item.closest(".reader-log-day");
    const dateText = dayEl?.querySelector(".day-number .show-for-sr")?.textContent?.trim();
    const title = item.querySelector(".book-title")?.textContent?.trim() ?? null;
    const minutesText = item.querySelector(".log-value")?.textContent?.trim() ?? "";
    const minutesMatch = minutesText.match(/([\d.]+)\s*minutes?/i);

    entries.push({
      loggedBookId,
      title,
      minutes: minutesMatch ? parseFloat(minutesMatch[1]) : null,
      date: dateText ? parseLongDate(dateText) : null,
    });
  }
  return entries;
}

/** Pure. Builds the URL for one month's log page. `month` is 1-12. */
export function buildMonthLogUrl(profileId, year, month, baseUrl = "") {
  const monthStr = String(month).padStart(2, "0");
  return `${baseUrl}/profiles/${profileId}/reading_log/dated_reading_log?start_date=${year}-${monthStr}-01`;
}

/** Pure. Every {year, month} (1-12) from startDate through endDate, inclusive, as YYYY-MM-DD strings. */
export function monthsBetween(startDate, endDate) {
  const [sy, sm] = startDate.split("-").map(Number);
  const [ey, em] = endDate.split("-").map(Number);
  const months = [];
  let y = sy, m = sm;
  while (y < ey || (y === ey && m <= em)) {
    months.push({ year: y, month: m });
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return months;
}

/**
 * Fetches and parses every month of a reader's existing log spanning
 * [startDate, endDate] (YYYY-MM-DD). Performs real network I/O — inject
 * `fetchImpl` and `parseHtml` in tests.
 */
export async function fetchExistingLog(
  profileId,
  { startDate, endDate },
  { fetchImpl = fetch, parseHtml = (html) => new DOMParser().parseFromString(html, "text/html") } = {}
) {
  const months = monthsBetween(startDate, endDate);
  const all = [];
  for (const { year, month } of months) {
    // findMatches can call this again for the same URL shortly after a
    // previous check (e.g. re-running "Find matches" right after a submit)
    // — a normal cached "default" fetch can serve the browser's HTTP cache
    // instead of hitting the network, returning a stale snapshot. `no-store`
    // forces a real round-trip every time, since this always needs to
    // reflect current server truth (see module comment above).
    const resp = await fetchImpl(buildMonthLogUrl(profileId, year, month), { cache: "no-store" });
    if (!resp.ok) continue; // a month with no data can still 200; only skip real failures
    const html = await resp.text();
    all.push(...parseExistingLog(parseHtml(html)));
  }
  // parseExistingLog only dedupes within a single page's own desktop/mobile
  // double-render. Beanstack's calendar grid also renders trailing/leading
  // days from the adjacent month in the same page (a week row can span two
  // months), so a boundary date's entries can appear in *two* separately
  // fetched month pages when a range spans a month boundary. Dedupe by id
  // (globally unique, unlike title) across all fetched pages too.
  const seenIds = new Set();
  return all.filter((entry) => {
    if (seenIds.has(entry.loggedBookId)) return false;
    seenIds.add(entry.loggedBookId);
    return true;
  });
}

/**
 * Groups existing entries by (date, normalized title) and sums their
 * minutes, so a candidate entry can be compared against "everything
 * already logged for this book on this day" regardless of how many
 * separate sessions that is. Pure.
 */
export function summarizeExistingLog(entries, normalizeTitle) {
  const byKey = new Map();
  for (const entry of entries) {
    if (!entry.date || !entry.title || entry.minutes == null) continue;
    const key = `${entry.date}|${normalizeTitle(entry.title)}`;
    const bucket = byKey.get(key) ?? { minutes: 0, loggedBookIds: [] };
    bucket.minutes += entry.minutes;
    bucket.loggedBookIds.push(entry.loggedBookId);
    byKey.set(key, bucket);
  }
  return byKey;
}
