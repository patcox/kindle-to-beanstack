import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { JSDOM } from "jsdom";
import {
  parseLongDate,
  parseExistingLog,
  buildMonthLogUrl,
  monthsBetween,
  fetchExistingLog,
  summarizeExistingLog,
} from "../extension/lib/reading-log.js";
import { normalizeTitle } from "../extension/lib/matcher.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadFixtureDoc() {
  const html = await readFile(path.join(__dirname, "fixtures/dated-reading-log.html"), "utf8");
  return new JSDOM(html).window.document;
}

test("parseLongDate converts a weekday-prefixed date to YYYY-MM-DD", () => {
  assert.equal(parseLongDate("Saturday, July 11, 2026"), "2026-07-11");
  assert.equal(parseLongDate("Thursday, July 9, 2026"), "2026-07-09");
});

test("parseLongDate returns null for unparseable input", () => {
  assert.equal(parseLongDate("not a date"), null);
  assert.equal(parseLongDate(""), null);
});

test("parseExistingLog extracts entries, deduping desktop/mobile repeats of the same id", async () => {
  const doc = await loadFixtureDoc();
  const entries = parseExistingLog(doc);
  assert.equal(entries.length, 2); // 3 links in the fixture, but two share an id
  assert.deepEqual(entries[0], { loggedBookId: "500000001", title: "Dog Man", minutes: 20, date: "2026-07-09" });
  assert.deepEqual(entries[1], { loggedBookId: "88888001", title: "Spy school", minutes: 4, date: "2026-07-11" });
});

test("buildMonthLogUrl builds the expected month-page URL", () => {
  assert.equal(
    buildMonthLogUrl("99999001", 2026, 7, "https://dscl.beanstack.com"),
    "https://dscl.beanstack.com/profiles/99999001/reading_log/dated_reading_log?start_date=2026-07-01"
  );
  assert.equal(
    buildMonthLogUrl("99999001", 2026, 9),
    "/profiles/99999001/reading_log/dated_reading_log?start_date=2026-09-01"
  );
});

test("monthsBetween lists every month in range, including across a year boundary", () => {
  assert.deepEqual(monthsBetween("2026-06-15", "2026-08-02"), [
    { year: 2026, month: 6 },
    { year: 2026, month: 7 },
    { year: 2026, month: 8 },
  ]);
  assert.deepEqual(monthsBetween("2026-12-01", "2027-01-15"), [
    { year: 2026, month: 12 },
    { year: 2027, month: 1 },
  ]);
});

test("fetchExistingLog fetches one page per month and concatenates parsed entries", async () => {
  const html = await readFile(path.join(__dirname, "fixtures/dated-reading-log.html"), "utf8");
  const requestedUrls = [];
  const fakeFetch = async (url) => {
    requestedUrls.push(url);
    return { ok: true, text: async () => html };
  };
  const parseHtml = (h) => new JSDOM(h).window.document;

  const entries = await fetchExistingLog(
    "99999001",
    { startDate: "2026-07-01", endDate: "2026-07-31" },
    { fetchImpl: fakeFetch, parseHtml }
  );
  assert.equal(requestedUrls.length, 1);
  assert.equal(entries.length, 2);
});

test("fetchExistingLog dedupes an entry rendered on two different months' pages (a calendar week spanning a month boundary)", async () => {
  const julyHtml = await readFile(path.join(__dirname, "fixtures/dated-reading-log.html"), "utf8");
  // Simulates Beanstack's calendar grid rendering the same trailing/leading
  // boundary day (and its log entry) on both adjacent months' pages — same
  // loggedBookId (88888001) as the one already in the July fixture above.
  const augustHtml = `<!doctype html><html><body>
    <div class="reader-log-day">
      <div class="day-number"><span class="show-for-sr">Saturday, July 11, 2026</span></div>
      <a class="reader-log-item" href="/profiles/99999001/reading_log/88888001">
        <div class="book-title">Spy school</div>
        <div class="log-value">4 minutes</div>
      </a>
    </div>
  </body></html>`;
  const pages = [julyHtml, augustHtml];
  let call = 0;
  const fakeFetch = async () => ({ ok: true, text: async () => pages[call++] });
  const parseHtml = (h) => new JSDOM(h).window.document;

  const entries = await fetchExistingLog(
    "99999001",
    { startDate: "2026-07-01", endDate: "2026-08-31" },
    { fetchImpl: fakeFetch, parseHtml }
  );
  const spySchoolCount = entries.filter((e) => e.loggedBookId === "88888001").length;
  assert.equal(spySchoolCount, 1);
  assert.equal(entries.length, 2); // Dog Man + one deduped Spy school, not two
});

test("summarizeExistingLog sums minutes per (date, normalized title)", async () => {
  const doc = await loadFixtureDoc();
  const entries = parseExistingLog(doc);
  const summary = summarizeExistingLog(entries, normalizeTitle);
  const dogMan = summary.get(`2026-07-09|${normalizeTitle("Dog Man")}`);
  assert.equal(dogMan.minutes, 20);
  assert.deepEqual(dogMan.loggedBookIds, ["500000001"]);
  assert.equal(summary.has("2026-07-10|dog man"), false);
});
