# Kindle Reading → Beanstack

A Chrome extension that pulls kids' Kindle / Amazon Kids+ reading activity
(minutes read per day, per title) from the Amazon Parent Dashboard and helps
log it into [Beanstack](https://www.beanstack.com/) — the platform many
public libraries use for summer reading challenges — without re-typing every
title and day by hand.

**Status: early / functional.** Built and validated against one family's real
data first — a real end-to-end submission has been confirmed working (see
[open risks](#open-risks--limitations)) — but it's only had light real-world
use so far. Review matches carefully, especially early on.

## Why this exists

Kids who read a lot on Kindle generate reading data every library summer
program wants credit for, but neither side exposes an official API:

- Amazon's Parent Dashboard has no export/CSV button.
- Beanstack has no bulk-import for reading logs (only for admin-side roster
  CSVs).

Both sides *do* have internal JSON endpoints their own web pages call,
though — this project uses those directly instead of scraping rendered HTML.

## How it works

1. **Amazon side** — a content script on `amazon.com/parentdashboard/*`
   calls the same internal endpoint (`POST
   /parentdashboard/ajax/get-weekly-activities-v2`) the dashboard's own React
   app uses, for a date range you pick, for each configured kid. Returns
   per-day, per-title minutes.
2. **Beanstack side** — a content script on your library's Beanstack site
   skips any entry under a minimum-minutes threshold (default 5, adjustable
   in the panel — see below for why), checks what's *already* logged for
   each remaining (kid, date, title) directly against Beanstack's own
   reading-log pages (not just local memory — see idempotency below),
   searches Beanstack's book catalog for anything new (using title/author,
   and ISBN when available, for a more precise match), shows you a review
   table before anything is submitted, and — only for entries you accept —
   submits the reading log the same way Beanstack's own "Log Reading" form
   does. Anything the catalog search can't match gets an editable
   title/author field right in the table (pre-filled from the Amazon title)
   instead of being stuck — check the box to submit it as a manual entry,
   the same way Beanstack's own "Manually Enter Title" works.
3. Nothing is submitted without you reviewing it first.

### Idempotency & cleanup

Beanstack has no server-side duplicate protection — submitting the same
(reader, book, date, minutes) twice creates two fully independent log
entries and double-counts the minutes (confirmed live). So this tool checks
against Beanstack's own log before submitting, not just its own local
memory: for each candidate entry, it reads what's already logged for that
exact (kid, date, title) directly off Beanstack's reading-log pages.

The check is on **(date, title) only, not the amount** — if *any* entry
already exists for that book on that day, it's treated as covered and
skipped, regardless of how many minutes it logged. This is a deliberate
simplification that rests on one assumption: **this tool is the only thing
adding to that reader's Beanstack log.** If that holds, it's a correct and
much simpler rule. If you also log some reading manually, a manual entry
for the same book/day will cause Amazon's (likely larger, more complete)
total to be skipped rather than added — so pick one approach per reader
during the challenge, not both.

This makes it safe to re-run the review panel repeatedly, including after
reinstalling the extension or losing local storage — the check is against
server truth, not a fragile local cache.

**Fixing a mistake**: after each submitted batch, the panel lists exactly
what it logged (kid, date, title), so you can find and delete a wrong entry
yourself on Beanstack's own reading log. An earlier version tried to
automate this ("Undo last batch," re-reading the log to learn each new
entry's Beanstack ID and deleting them) but the create response carries no
ID, so it had to *guess* each one by diffing the log before/after — reliable
at the small scale it was first tested at, but at real scale (142 entries in
one batch) it only resolved a handful. A plain, always-accurate list beats
an automation that mostly doesn't work.

### Why a minimum-minutes threshold

A lot of Kindle activity is a few minutes of incidental use (checking a
dictionary definition, a quick re-open) that isn't really worth its own
Beanstack log entry. A real-data analysis across three kids' reading since
June 2026 (258 day/title entries) found:

| Threshold | Fewer log entries | Minutes lost |
|---|---|---|
| < 5 min | 16% | 0.7% |
| < 10 min | 28% | 2.8% |
| < 15 min | 34% | 4.7% |

5 minutes is a clean trade — a meaningful cut in tedious entries for
negligible lost credit. Separately, Beanstack itself rejects `log_value`
below 1 (confirmed live: HTTP 422, "log_value must be greater than or
equal to 1") — if you set the threshold down near 0, an entry that rounds
to 0 minutes fails fast locally with a clear message instead of only
failing after a round trip to the server. The effect isn't uniform across kids, though: a
reader whose sessions run short (e.g. lots of individual comic issues)
loses proportionally more at higher thresholds than one who reads in long
novel-length sessions. That's why it's an adjustable setting, not a
hardcoded constant, and why excluded entries are reported as a count
rather than silently dropped.

## Setup

1. Load `extension/` as an unpacked extension in Chrome
   (`chrome://extensions` → Developer mode → Load unpacked).
2. Open your Amazon Parent Dashboard. A floating panel appears — click
   "Detect kids" once; it fetches every kid in the household (name and
   ID together) in a single request, no clicking through profile icons or
   typing names required. The panel's header can be dragged anywhere on the
   page, and has `–`/`×` buttons to minimize or close it (a small "K→…"
   button reopens it) if it's sitting over page content you need, like
   Beanstack's own reader switcher.
3. Open your library's Beanstack site — the panel there auto-detects every
   family reader's `profile_id` directly from the page's own reader-switcher
   (no dev tools, no clicking through each reader) and auto-pairs them with
   your Amazon kids by matching names. If a name doesn't match exactly, fix
   the pairing with the dropdown next to that kid.
4. On the Parent Dashboard, use the floating panel to pull a date range of
   reading activity.
5. On Beanstack, open "Log Reading" and search for any title once — this
   mints the short-lived search token the review panel needs (see
   [how it works](#how-it-works) below for why). Then use the floating panel
   to review matched titles and submit the ones you approve.
6. Click the extension icon for a running summary (minutes per title, per
   week) across all configured kids.

## Privacy & data handling

- No account credentials are ever handled by this extension — it relies
  entirely on your browser's existing logged-in session.
- Per-kid identifiers live only in `chrome.storage.local` on your machine.
  They are never written into a file, never leave your browser except to the
  Amazon/Beanstack endpoints themselves, and are never part of this repo.
- This repo's test fixtures use fabricated kid names paired with real,
  publicly-known children's book titles/ISBNs — not anyone's real reading
  history.

## Open risks / limitations

- **Amazon's Conditions of Use prohibit automated access** ("robot, spider,
  scraper... for any purpose"). This tool only ever runs on a button click
  you make while logged in as yourself — never on a schedule or in the
  background — to keep its traffic pattern close to normal manual dashboard
  use. Realistic downside of violating this is account-level (rate-limiting
  or a flag on your account), not legal; using your own account to access
  your own data isn't the kind of unauthorized access the CFAA targets
  post-*Van Buren v. United States* (2021), but it's still worth
  understanding before you use this.
- **Title matching is not fully deterministic.** Beanstack's catalog search
  is fuzzy on title/author; adding ISBN (scraped from Amazon's own product
  page) narrows it, but different printings of the same book can have
  different ISBNs. Always review matches before submitting — don't trust
  auto-matching blindly, especially for a large backlog.
- **A search on the exact Amazon title can come back empty even when the
  book is in Beanstack's catalog** — seen live for titles Amazon decorates
  with a trailing imprint/series annotation (e.g. "(AMP! Comics for
  Kids)") or a "The Complete " compilation prefix, neither of which is
  part of Beanstack's own title. A zero-result search is retried once with
  those stripped (see `simplifyTitleForSearch`); this recovers some but not
  all such titles — it's a plain string heuristic, not a real fuzzy match
  against Beanstack's catalog.
- **Beanstack's catalog search rejects some unusual titles outright** (HTTP
  400 — seen live for a multi-book bundle listing's Amazon title, which
  runs long and packs in several book titles at once). One entry's search
  failing shows up as a "search failed" row rather than blocking every
  other entry after it. Rows like this — along with ones the catalog
  search ran but simply had no good match for — get an editable
  title/author field right in the review table instead, pre-filled from
  the Amazon title, so you don't have to leave the panel to log them; edit
  the title first if it needs cleaning up (e.g. trimming a bundle listing
  down to one real book title).
- **`program_id` behavior for kids in 2+ simultaneous Beanstack challenges is
  still unverified** — confirmed working (live, real submission) when
  omitted entirely for a reader with exactly one active challenge; untested
  for a reader enrolled in two overlapping challenges at once.
- No automated end-to-end tests exist against the live services (both
  require an authenticated session) — see `tests/` for what *is* covered
  (the pure request/response logic, against synthetic fixtures).

## Development

```
npm install                       # only needed for tests — jsdom, a test-only dependency
npm test                          # unit tests (node --test), no framework needed
bash scripts/check-no-secrets.sh  # same check CI runs on every push/PR
```

Project layout:

```
extension/
  manifest.json
  background.js                           cross-origin fetch relay only — see below
  content-scripts/amazon.js               floating panel on the Parent Dashboard
  content-scripts/beanstack.js            floating panel on Beanstack
  content-scripts/beanstack-main-world.js network interception only — see below
  lib/                                    pure-logic modules, unit tested in isolation
  popup/                                  setup dashboard + reading summary view
tests/                                    unit tests + synthetic fixtures
```

The extension itself has zero runtime dependencies (plain JS, no build
step) — `jsdom` is a devDependency used only by the test suite, to parse
real HTML fixtures of Beanstack's reading-log page.

**Why `background.js` exists.** `fetchHouseholdChildren` (see above) lives
on `parents.amazon.com`, a different origin than the Parent Dashboard
content script runs on (`www.amazon.com`) — a cross-origin request. The
intuitive fix is adding that origin to `host_permissions`, but that alone
doesn't work: `host_permissions` grants a cross-origin fetch bypass to the
extension's own privileged contexts (a background service worker, the
popup), not to a content script. A content script's network requests are
still dispatched through the *hosting page's* own stack and bound by that
page's real CORS policy, regardless of what the extension's manifest
grants — confirmed live (`No 'Access-Control-Allow-Origin' header...`)
before adding `background.js` to make the actual request from a context
where the bypass genuinely applies, reached via `chrome.runtime.sendMessage`
from `amazon.js`.

**Why `beanstack-main-world.js` exists.** Content scripts run in an
"isolated world" — sharing the page's DOM, but not its JS objects. Patching
`XMLHttpRequest` from the isolated world only replaces that world's own
copy; the page's real code has an entirely separate one, untouched by the
patch. `beanstack-main-world.js` runs in the page's actual world
(`"world": "MAIN"` in the manifest) to patch the real thing, and relays
what it observes to the regular (isolated-world) `beanstack.js` via
`postMessage` — the standard bridge between the two worlds.

**Why `fetchExistingLog` uses `cache: "no-store"`.** The idempotency check
(see above) needs to reflect current server truth every time it runs — if
you re-run "Find matches" shortly after a previous check, a normal cached
fetch can serve the browser's own HTTP cache for that same URL instead of
hitting the network, silently returning a stale snapshot. This surfaced
while building (and later removing) an "Undo last batch" feature, which
depended on this same fetch reflecting a submission that had *just*
happened — `no-store` forces a real round-trip every time.

**Why panel styles use `!important` everywhere.** Both floating panels are
appended straight onto the host page's `document.body`, which means they're
exposed to whatever that page's own CSS does to bare element selectors.
Live testing on Beanstack showed its own form-control styling (larger,
bolder default type) bleeding through despite matching class selectors here,
and its own `select` reset was forcing the reader-pairing dropdown to full
block width, dropping it onto its own line instead of sitting next to the
kid's name. Ordinary CSS specificity can't reliably out-rank an unknown
host page's rules, so `panel-chrome.js`'s injected stylesheet uses
`!important` throughout to guarantee the panel looks the same regardless of
what site it's sitting on.

The Amazon side originally used the same pattern for kid detection (patching
`window.fetch` to watch for the activities endpoint firing), but that turned
out to be unreliable: Amazon's own page bundle *also* instruments
`window.fetch` for its own analytics, and it was winning the race to be
"the" `window.fetch`, silently swallowing our patch — no error, detection
just quietly did nothing. It was replaced entirely once a much better
option turned up during real testing: `get-household-with-age`
(`parents.amazon.com`) returns every kid's name and `childDirectedId`
together in one request, no interception needed at all. Left here as a
cautionary example — the earlier failure mode couldn't have been caught by
testing the interception logic in isolation, since the bug was entirely
about *which JS world a script runs in*, not what the code inside it does.

Everything under `extension/lib/` is written as small, pure, independently
testable functions (request builders, response parsers, matching logic)
separated from the side-effecting content scripts that wire them together —
see any file there for the pattern.

## License

MIT — see [LICENSE](LICENSE).
