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
   in the panel — see below for why), searches Beanstack's book catalog for
   each remaining title (using title/author, and ISBN when available, for a
   more precise match), shows you a review table before anything is
   submitted, and — only for entries you accept — submits the reading log
   the same way Beanstack's own "Log Reading" form does.
3. Nothing is submitted without you reviewing it first.

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
negligible lost credit. The effect isn't uniform across kids, though: a
reader whose sessions run short (e.g. lots of individual comic issues)
loses proportionally more at higher thresholds than one who reads in long
novel-length sessions. That's why it's an adjustable setting, not a
hardcoded constant, and why excluded entries are reported as a count
rather than silently dropped.

## Setup

1. Load `extension/` as an unpacked extension in Chrome
   (`chrome://extensions` → Developer mode → Load unpacked).
2. Open your Amazon Parent Dashboard. A floating panel appears — click
   "Detect kids", then click each kid's profile icon at the top of the page
   one at a time; the panel will ask you to name each one as it's detected
   (this is network-based, not a guess at Amazon's DOM structure, so it's
   more resilient to Amazon changing their page).
3. Find each kid's Beanstack `profile_id`: open "Log Reading" on Beanstack
   while that reader is selected, pick any book, and look at the URL/page —
   or just check your browser's Network tab for a `logged_book[profile_id]`
   value. Enter it in the pairing box in the Beanstack-side panel. (A future
   version could auto-detect this the same way Amazon detection works; v1
   asks you to enter it once per kid.)
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
- **`program_id` behavior for kids in 2+ simultaneous Beanstack challenges is
  still unverified** — confirmed working (live, real submission) when
  omitted entirely for a reader with exactly one active challenge; untested
  for a reader enrolled in two overlapping challenges at once.
- No automated end-to-end tests exist against the live services (both
  require an authenticated session) — see `tests/` for what *is* covered
  (the pure request/response logic, against synthetic fixtures).

## Development

```
npm test                          # unit tests (node --test), no framework needed
bash scripts/check-no-secrets.sh  # same check CI runs on every push/PR
```

Project layout:

```
extension/
  manifest.json
  content-scripts/amazon.js      floating panel on the Parent Dashboard
  content-scripts/beanstack.js   floating panel on Beanstack
  lib/                           pure-logic modules, unit tested in isolation
  popup/                         setup dashboard + reading summary view
tests/                           unit tests + synthetic fixtures
```

Everything under `extension/lib/` is written as small, pure, independently
testable functions (request builders, response parsers, matching logic)
separated from the side-effecting content scripts that wire them together —
see any file there for the pattern.

## License

MIT — see [LICENSE](LICENSE).
