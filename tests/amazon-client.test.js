import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  buildActivityRequestBody,
  unixToDateString,
  parseActivityResponse,
  fetchActivity,
  extractIsbn13FromHtml,
  fetchIsbnForAsin,
} from "../extension/lib/amazon-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadFixture(name) {
  const raw = await readFile(path.join(__dirname, "fixtures", name), "utf8");
  return JSON.parse(raw);
}

test("buildActivityRequestBody requires childDirectedId", () => {
  assert.throws(() => buildActivityRequestBody({ startTime: 1, endTime: 2 }));
});

test("buildActivityRequestBody builds the expected shape", () => {
  const body = buildActivityRequestBody({
    childDirectedId: "amzn1.account.FAKE",
    startTime: 100,
    endTime: 200,
  });
  assert.deepEqual(body, {
    childDirectedId: "amzn1.account.FAKE",
    startTime: 100,
    endTime: 200,
    aggregationInterval: 86400,
    timeZone: "America/Chicago",
  });
});

test("unixToDateString converts to the expected local date", () => {
  // 1782925200 = 2026-07-01T12:00:00-05:00 (America/Chicago)
  assert.equal(unixToDateString(1782925200, "America/Chicago"), "2026-07-01");
});

test("parseActivityResponse flattens intervals into per-day, per-title rows", async () => {
  const fixture = await loadFixture("activity-response.json");
  const rows = parseActivityResponse(fixture);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    date: "2026-07-01",
    asin: "B0TESTWIMPY",
    title: "Diary of a Wimpy Kid",
    minutes: 30,
  });
  assert.deepEqual(rows[1], {
    date: "2026-07-02",
    asin: "B0TESTDOGMAN",
    title: "Dog Man",
    minutes: 45,
  });
  assert.deepEqual(rows[2], {
    date: "2026-07-02",
    asin: "B0TESTWIMPY",
    title: "Diary of a Wimpy Kid",
    minutes: 10,
  });
});

test("fetchActivity performs the POST and returns normalized rows", async () => {
  const fixture = await loadFixture("activity-response.json");
  let capturedUrl, capturedOptions;
  const fakeFetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return { ok: true, json: async () => fixture };
  };
  const rows = await fetchActivity(
    { childDirectedId: "amzn1.account.FAKE", startTime: 1782925200, endTime: 1783011600 },
    fakeFetch
  );
  assert.equal(capturedUrl, "https://www.amazon.com/parentdashboard/ajax/get-weekly-activities-v2");
  assert.equal(capturedOptions.method, "POST");
  assert.equal(rows.length, 3);
});

test("fetchActivity throws on a non-OK response", async () => {
  const fakeFetch = async () => ({ ok: false, status: 500 });
  await assert.rejects(() =>
    fetchActivity({ childDirectedId: "x", startTime: 1, endTime: 2 }, fakeFetch)
  );
});

test("extractIsbn13FromHtml finds an ISBN-13 in a product-details block", () => {
  const html = `<tr><th>ISBN-13</th><td>&rlm; : &lrm; 978-0810993136</td></tr>`;
  assert.equal(extractIsbn13FromHtml(html), "9780810993136");
});

test("extractIsbn13FromHtml returns null when no ISBN is present", () => {
  const html = `<div>No ISBN here, Kindle-exclusive title.</div>`;
  assert.equal(extractIsbn13FromHtml(html), null);
});

test("fetchIsbnForAsin returns the parsed ISBN for a successful fetch", async () => {
  const fakeFetch = async (url) => {
    assert.equal(url, "https://www.amazon.com/dp/B0TESTWIMPY");
    return { ok: true, text: async () => `<th>ISBN-13</th><td>978-0810993136</td>` };
  };
  assert.equal(await fetchIsbnForAsin("B0TESTWIMPY", fakeFetch), "9780810993136");
});

test("fetchIsbnForAsin returns null on a non-OK response", async () => {
  const fakeFetch = async () => ({ ok: false });
  assert.equal(await fetchIsbnForAsin("B0TESTWIMPY", fakeFetch), null);
});
