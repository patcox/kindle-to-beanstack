// Client for Amazon's internal (undocumented) Parent Dashboard activity
// endpoint, plus a best-effort ISBN lookup from a Kindle title's own product
// page. Pure/testable functions are exported separately from the functions
// that actually perform network I/O, so unit tests can run against fixture
// data without needing a real browser session.

const ACTIVITY_ENDPOINT = "https://www.amazon.com/parentdashboard/ajax/get-weekly-activities-v2";

/**
 * Builds the POST body for get-weekly-activities-v2.
 * Pure — no I/O.
 * @param {{childDirectedId: string, startTime: number, endTime: number, timeZone?: string}} opts
 *   startTime/endTime are Unix seconds.
 */
export function buildActivityRequestBody({ childDirectedId, startTime, endTime, timeZone = "America/Chicago" }) {
  if (!childDirectedId) throw new Error("childDirectedId is required");
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    throw new Error("startTime and endTime must be Unix-seconds numbers");
  }
  return {
    childDirectedId,
    startTime,
    endTime,
    aggregationInterval: 86400,
    timeZone,
  };
}

/**
 * Converts a Unix-seconds timestamp to a YYYY-MM-DD string in the given
 * IANA time zone. Pure — no I/O.
 */
export function unixToDateString(unixSeconds, timeZone = "America/Chicago") {
  const d = new Date(unixSeconds * 1000);
  // en-CA formats as YYYY-MM-DD, which is what we want directly.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * Normalizes a get-weekly-activities-v2 response into a flat list of
 * per-day, per-title reading entries. Pure — no I/O.
 * @returns {{date: string, asin: string, title: string, minutes: number}[]}
 */
export function parseActivityResponse(json, { timeZone = "America/Chicago" } = {}) {
  const rows = [];
  for (const category of json?.activityV2Data ?? []) {
    for (const interval of category.intervals ?? []) {
      const date = unixToDateString(interval.startTime, timeZone);
      for (const result of interval.aggregatedActivityResults ?? []) {
        const attrs = result.attributes ?? {};
        rows.push({
          date,
          asin: attrs.ORIGINAL_KEY ?? null,
          title: attrs.TITLE ?? "(unknown title)",
          minutes: Math.round((result.activityDuration / 60) * 10) / 10,
        });
      }
    }
  }
  return rows;
}

/**
 * Fetches a range of reading activity for one kid and returns normalized
 * entries. Performs real network I/O (same-origin fetch, relies on the
 * browser's existing amazon.com session cookie) — inject `fetchImpl` in
 * tests to avoid a real request.
 */
export async function fetchActivity({ childDirectedId, startTime, endTime, timeZone }, fetchImpl = fetch) {
  const body = buildActivityRequestBody({ childDirectedId, startTime, endTime, timeZone });
  const resp = await fetchImpl(ACTIVITY_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`get-weekly-activities-v2 failed: HTTP ${resp.status}`);
  }
  const json = await resp.json();
  return parseActivityResponse(json, { timeZone });
}

/**
 * Extracts an ISBN-13 from a Kindle product page's raw HTML. Not all titles
 * (e.g. Kindle-exclusive self-published books) have one — returns null in
 * that case. Pure — no I/O. Works against raw HTML text directly (no DOM
 * parser dependency) since Amazon's product-details block renders the label
 * and value close together in the source regardless of exact markup.
 */
export function extractIsbn13FromHtml(html) {
  const match = html.match(/ISBN-13[\s\S]{0,60}?(\d{3}-?\d{10})/i);
  if (!match) return null;
  return match[1].replace(/-/g, "");
}

/**
 * Best-effort ISBN lookup for a single ASIN via its product page. Returns
 * null (not an error) when no ISBN is found — this is expected for many
 * titles. Inject `fetchImpl` in tests.
 */
export async function fetchIsbnForAsin(asin, fetchImpl = fetch) {
  const resp = await fetchImpl(`https://www.amazon.com/dp/${asin}`);
  if (!resp.ok) return null;
  const html = await resp.text();
  return extractIsbn13FromHtml(html);
}
