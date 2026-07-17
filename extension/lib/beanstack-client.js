// Client for Beanstack's catalog search and reading-log submission.
//
// Catalog search (book_autocomplete) requires a short-lived, endpoint-scoped
// Bearer JWT that Beanstack's own frontend mints and attaches automatically
// when the log-creation page loads. We can't manufacture this token
// ourselves (it's server-signed) — `installAuthTokenWatcher` captures it by
// watching the page's own XHR calls, the same technique used to discover
// this mechanism in the first place.

const SEARCH_ENDPOINT = "https://beanstackbooks.beanstack.com/api/v2/book_autocomplete";
const SUBMIT_ENDPOINT_PATH = "/logged_books";

let capturedToken = null;

/**
 * Decodes a JWT's payload without verifying the signature (we don't have
 * the key — we're just reading the `exp` claim to know when to expect a
 * fresh one). Pure. Returns null if the token isn't well-formed.
 */
export function decodeJwtPayload(token) {
  try {
    const bearerless = token.replace(/^Bearer\s+/i, "");
    const payloadB64 = bearerless.split(".")[1];
    const json = atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** Pure. True if the token decodes and its `exp` claim is in the future. */
export function isTokenValid(token, nowSeconds = Math.floor(Date.now() / 1000)) {
  const payload = token && decodeJwtPayload(token);
  return Boolean(payload?.exp && payload.exp > nowSeconds);
}

/**
 * Patches XMLHttpRequest (Beanstack's frontend uses XHR, not fetch, for
 * this call) to capture the Authorization header it sends to
 * book_autocomplete. Call once per page load, before the user interacts
 * with anything that would trigger a catalog search. Side-effecting — not
 * unit tested directly, only the pure helpers above are.
 */
export function installAuthTokenWatcher() {
  if (window.__kbXhrPatched) return;
  window.__kbXhrPatched = true;
  const origOpen = XMLHttpRequest.prototype.open;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__kbUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this.__kbUrl && String(this.__kbUrl).includes("book_autocomplete") && /authorization/i.test(name)) {
      capturedToken = value;
    }
    return origSetHeader.call(this, name, value);
  };
}

export function getCapturedToken() {
  return capturedToken;
}

/** Pure. Builds the book_autocomplete query URL. */
export function buildSearchUrl({ title, author, isbn }) {
  const params = new URLSearchParams({ title, author });
  if (isbn) params.set("isbn", isbn);
  return `${SEARCH_ENDPOINT}?${params.toString()}`;
}

/**
 * Searches Beanstack's catalog. Requires a valid captured Bearer token —
 * throws if none is available rather than silently returning no results.
 * Inject `fetchImpl` and `token` in tests.
 */
export async function searchCatalog({ title, author, isbn }, token = capturedToken, fetchImpl = fetch) {
  if (!isTokenValid(token)) {
    throw new Error("No valid Beanstack search token captured yet — visit the Log Reading page once first.");
  }
  const resp = await fetchImpl(buildSearchUrl({ title, author, isbn }), {
    headers: { Authorization: token },
  });
  if (!resp.ok) {
    throw new Error(`book_autocomplete failed: HTTP ${resp.status}`);
  }
  return resp.json();
}

/** Pure. Reads the Rails CSRF token from the page. */
export function getCsrfToken(doc = document) {
  return doc.querySelector('meta[name="csrf-token"]')?.content ?? null;
}

/**
 * Reads every family reader's profile_id straight out of the page's
 * reader-switcher, which lists all of them (not just the active one) as
 * `<a href="/user/{userId}/profiles/{profileId}/set_active_profile">{Name}</a>`
 * — present in the DOM on any Beanstack page, no click/navigation needed.
 * No dev tools, no manual ID hunting. Pure given a document.
 * @returns {{profileId: string, name: string}[]}
 */
export function parseReaderSwitcher(doc = document) {
  const links = doc.querySelectorAll('.profile-switcher-list a[href*="set_active_profile"]');
  const readers = [];
  for (const link of links) {
    const match = (link.getAttribute("href") || "").match(/profiles\/(\d+)\/set_active_profile/);
    if (!match) continue;
    readers.push({ profileId: match[1], name: link.textContent.trim() });
  }
  return readers;
}

/**
 * Pure. Builds the logged_books form payload from a chosen catalog match.
 * `minutes` must be a whole number of minutes (Beanstack's own UI parses
 * "1h 55m" into 115 client-side before submitting — we skip that step and
 * pass minutes directly since our source data is already in minutes).
 */
export function buildLogPayload({ profileId, candidate, date, minutes, includeReview = false }) {
  if (!profileId) throw new Error("profileId is required");
  if (!candidate) throw new Error("candidate (catalog match) is required");
  if (!date) throw new Error("date (YYYY-MM-DD) is required");
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("minutes must be a positive number");

  const lex = candidate.lexile_information ?? {};
  return {
    "logged_book[profile_id]": String(profileId),
    "logged_book[book_title]": candidate.title,
    "logged_book[book_author]": candidate.authors,
    "logged_book[beanstack_book_id]": String(candidate.id),
    "logged_book[isbn]": candidate.isbn_13 ?? candidate.isbn_10 ?? "",
    "logged_book[lexile_information_id]": lex.id != null ? String(lex.id) : "",
    "logged_book[lexile_score]": lex.lexile != null ? String(lex.lexile) : "",
    "logged_book[lexile_code]": lex.lexile_code ?? "",
    "logged_book[lexile_display]": lex.lexile_display ?? "",
    "logged_book[log_type_id]": "2",
    "logged_book[date_read]": date,
    "logged_book[log_value]": String(Math.round(minutes)),
    "logged_book[include_review]": includeReview ? "Yes" : "No",
    "logged_book[open_library_url]": candidate.image ?? "",
  };
}

/**
 * Submits one reading log entry. Inject `fetchImpl` in tests. `baseUrl`
 * defaults to the current page's origin (each library has its own Beanstack
 * subdomain) — pass it explicitly in tests/non-browser contexts.
 */
export async function submitLog(payload, { csrfToken, baseUrl = location.origin, fetchImpl = fetch } = {}) {
  if (!csrfToken) throw new Error("csrfToken is required");
  const body = new URLSearchParams({ ...payload, authenticity_token: csrfToken, commit: "Log Reading" });
  const resp = await fetchImpl(`${baseUrl}${SUBMIT_ENDPOINT_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  return resp;
}
