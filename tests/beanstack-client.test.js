import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  decodeJwtPayload,
  isTokenValid,
  buildSearchUrl,
  searchCatalog,
  getCsrfToken,
  buildLogPayload,
  submitLog,
  parseReaderSwitcher,
  deleteLoggedEntry,
} from "../extension/lib/beanstack-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadFixture(name) {
  const raw = await readFile(path.join(__dirname, "fixtures", name), "utf8");
  return JSON.parse(raw);
}

function base64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeFakeToken(payload) {
  return `Bearer ${base64url({ alg: "HS512" })}.${base64url(payload)}.fakesignature`;
}

test("decodeJwtPayload decodes a well-formed token", () => {
  const token = makeFakeToken({ sub: "/api/v2/book_autocomplete", exp: 1999999999 });
  assert.deepEqual(decodeJwtPayload(token), { sub: "/api/v2/book_autocomplete", exp: 1999999999 });
});

test("decodeJwtPayload returns null for garbage input", () => {
  assert.equal(decodeJwtPayload("not-a-jwt"), null);
});

test("isTokenValid is true for a future exp and false for a past one", () => {
  const future = makeFakeToken({ exp: 4000000000 });
  const past = makeFakeToken({ exp: 1 });
  assert.equal(isTokenValid(future, 1700000000), true);
  assert.equal(isTokenValid(past, 1700000000), false);
  assert.equal(isTokenValid(null), false);
  assert.equal(isTokenValid("garbage"), false);
});

test("buildSearchUrl includes isbn only when provided", () => {
  const withIsbn = buildSearchUrl({ title: "Dog Man", author: "Dav Pilkey", isbn: "9780545581608" });
  assert.match(withIsbn, /isbn=9780545581608/);
  const withoutIsbn = buildSearchUrl({ title: "Dog Man", author: "Dav Pilkey" });
  assert.doesNotMatch(withoutIsbn, /isbn=/);
});

test("searchCatalog throws when no valid token is available", async () => {
  await assert.rejects(() => searchCatalog({ title: "x", author: "y" }, null, async () => ({ ok: true })));
});

test("searchCatalog performs the GET with the Authorization header and returns JSON", async () => {
  const candidates = await loadFixture("beanstack-search-response.json");
  const token = makeFakeToken({ exp: 4000000000 });
  let capturedUrl, capturedOpts;
  const fakeFetch = async (url, opts) => {
    capturedUrl = url;
    capturedOpts = opts;
    return { ok: true, json: async () => candidates };
  };
  const result = await searchCatalog({ title: "Diary of a Wimpy Kid", author: "Jeff Kinney" }, token, fakeFetch);
  assert.equal(capturedOpts.headers.Authorization, token);
  assert.match(capturedUrl, /book_autocomplete/);
  assert.equal(result.length, 2);
});

test("getCsrfToken reads the meta tag content", () => {
  const fakeDoc = { querySelector: () => ({ content: "abc123" }) };
  assert.equal(getCsrfToken(fakeDoc), "abc123");
  const emptyDoc = { querySelector: () => null };
  assert.equal(getCsrfToken(emptyDoc), null);
});

function fakeLink(href, text) {
  return { getAttribute: (name) => (name === "href" ? href : null), textContent: text };
}

test("parseReaderSwitcher extracts profileId + name from the switcher list", () => {
  const fakeDoc = {
    querySelectorAll: () => [
      fakeLink("/user/77777001/profiles/99999001/set_active_profile", "Alex"),
      fakeLink("/user/77777001/profiles/99999002/set_active_profile", "Sam"),
      fakeLink("/user/77777001/profiles/99999003/set_active_profile", "Jordan"),
    ],
  };
  assert.deepEqual(parseReaderSwitcher(fakeDoc), [
    { profileId: "99999001", name: "Alex" },
    { profileId: "99999002", name: "Sam" },
    { profileId: "99999003", name: "Jordan" },
  ]);
});

test("parseReaderSwitcher skips links that don't match the expected href shape", () => {
  const fakeDoc = {
    querySelectorAll: () => [fakeLink("/profiles/new", "Add a Reader"), fakeLink(null, "broken")],
  };
  assert.deepEqual(parseReaderSwitcher(fakeDoc), []);
});

test("buildLogPayload maps a chosen candidate into the expected form fields", async () => {
  const [candidate] = await loadFixture("beanstack-search-response.json");
  const payload = buildLogPayload({ profileId: 999, candidate, date: "2026-07-01", minutes: 30 });
  assert.deepEqual(payload, {
    "logged_book[profile_id]": "999",
    "logged_book[book_title]": "Diary of a Wimpy Kid",
    "logged_book[book_author]": "Jeff Kinney",
    "logged_book[beanstack_book_id]": "12345",
    "logged_book[isbn]": "9780810993136",
    "logged_book[lexile_information_id]": "555",
    "logged_book[lexile_score]": "950",
    "logged_book[lexile_code]": "",
    "logged_book[lexile_display]": "950L",
    "logged_book[log_type_id]": "2",
    "logged_book[date_read]": "2026-07-01",
    "logged_book[log_value]": "30",
    "logged_book[include_review]": "No",
    "logged_book[open_library_url]": "https://books.beanstack-cdn.com/fake-wimpy-hc.jpg",
  });
});

test("buildLogPayload validates its inputs", async () => {
  const [candidate] = await loadFixture("beanstack-search-response.json");
  assert.throws(() => buildLogPayload({ candidate, date: "2026-07-01", minutes: 30 }));
  assert.throws(() => buildLogPayload({ profileId: 1, date: "2026-07-01", minutes: 30 }));
  assert.throws(() => buildLogPayload({ profileId: 1, candidate, minutes: 30 }));
  assert.throws(() => buildLogPayload({ profileId: 1, candidate, date: "2026-07-01", minutes: 0 }));
});

test("buildLogPayload rejects minutes that round down to 0 — Beanstack requires log_value >= 1", async () => {
  const [candidate] = await loadFixture("beanstack-search-response.json");
  assert.throws(
    () => buildLogPayload({ profileId: 1, candidate, date: "2026-07-01", minutes: 0.4 }),
    /at least 1/
  );
});

test("buildLogPayload accepts minutes that round up to 1", async () => {
  const [candidate] = await loadFixture("beanstack-search-response.json");
  const payload = buildLogPayload({ profileId: 1, candidate, date: "2026-07-01", minutes: 0.5 });
  assert.equal(payload["logged_book[log_value]"], "1");
});

test("buildLogPayload builds a manual-entry payload with blank catalog fields when there's no candidate", () => {
  const payload = buildLogPayload({
    profileId: 999,
    manualTitle: "Miranda Kenneally Bundle: Catching Jordan, Stealing Parker, Things I Can't Forget",
    manualAuthor: "Miranda Kenneally",
    date: "2026-07-16",
    minutes: 13,
  });
  assert.deepEqual(payload, {
    "logged_book[profile_id]": "999",
    "logged_book[book_title]": "Miranda Kenneally Bundle: Catching Jordan, Stealing Parker, Things I Can't Forget",
    "logged_book[book_author]": "Miranda Kenneally",
    "logged_book[beanstack_book_id]": "",
    "logged_book[isbn]": "",
    "logged_book[lexile_information_id]": "",
    "logged_book[lexile_score]": "",
    "logged_book[lexile_code]": "",
    "logged_book[lexile_display]": "",
    "logged_book[log_type_id]": "2",
    "logged_book[date_read]": "2026-07-16",
    "logged_book[log_value]": "13",
    "logged_book[include_review]": "No",
    "logged_book[open_library_url]": "",
  });
});

test("buildLogPayload defaults manualAuthor to blank when omitted", () => {
  const payload = buildLogPayload({ profileId: 1, manualTitle: "Some Title", date: "2026-07-01", minutes: 10 });
  assert.equal(payload["logged_book[book_author]"], "");
});

test("buildLogPayload throws when neither candidate nor manualTitle is given", () => {
  assert.throws(() => buildLogPayload({ profileId: 1, date: "2026-07-01", minutes: 10 }));
});

test("submitLog posts form-encoded data including the CSRF token", async () => {
  let capturedUrl, capturedOpts;
  const fakeFetch = async (url, opts) => {
    capturedUrl = url;
    capturedOpts = opts;
    return { ok: true, status: 200 };
  };
  const resp = await submitLog(
    { "logged_book[profile_id]": "999" },
    { csrfToken: "tok123", baseUrl: "https://dscl.beanstack.com", fetchImpl: fakeFetch }
  );
  assert.equal(capturedUrl, "https://dscl.beanstack.com/logged_books");
  assert.equal(capturedOpts.method, "POST");
  assert.match(capturedOpts.body, /authenticity_token=tok123/);
  assert.match(capturedOpts.body, /commit=Log\+Reading/);
  assert.equal(resp.ok, true);
});

test("submitLog throws without a csrfToken", async () => {
  await assert.rejects(() => submitLog({}, { baseUrl: "https://dscl.beanstack.com", fetchImpl: async () => ({}) }));
});

test("deleteLoggedEntry posts the Rails method-override delete request", async () => {
  let capturedUrl, capturedOpts;
  const fakeFetch = async (url, opts) => {
    capturedUrl = url;
    capturedOpts = opts;
    return { ok: true, status: 200 };
  };
  const resp = await deleteLoggedEntry("88888002", {
    csrfToken: "tok123",
    baseUrl: "https://dscl.beanstack.com",
    fetchImpl: fakeFetch,
  });
  assert.equal(capturedUrl, "https://dscl.beanstack.com/logged_books/88888002");
  assert.equal(capturedOpts.method, "POST");
  assert.match(capturedOpts.body, /_method=delete/);
  assert.match(capturedOpts.body, /authenticity_token=tok123/);
  assert.equal(resp.ok, true);
});

test("deleteLoggedEntry throws without a csrfToken", async () => {
  await assert.rejects(() =>
    deleteLoggedEntry("1", { baseUrl: "https://dscl.beanstack.com", fetchImpl: async () => ({}) })
  );
});
