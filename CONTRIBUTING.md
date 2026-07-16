# Contributing

This started as a personal tool to stop re-typing my kids' Kindle reading
into Beanstack by hand. Contributions are welcome, especially:

- Support for other reading platforms (Epic!, Libby, etc.) as additional
  "source" modules alongside `extension/lib/amazon-client.js`.
- Support for other library systems' Beanstack tenants (this should already
  work for any `*.beanstack.com` subdomain, but more real-world testing
  helps).
- Firefox/Edge portability (v1 only targets Chrome).

## Before you open a PR

- Run `npm test` — unit tests run against synthetic fixtures in
  `tests/fixtures/`, never real personal data.
- Run `bash scripts/check-no-secrets.sh` — also enforced in CI. If you're
  testing against your own Amazon/Beanstack accounts during development,
  double-check `git diff` before committing; the check-no-secrets script
  only reliably catches Amazon's `childDirectedId` pattern (see the comment
  at the top of that script for why Beanstack's `profile_id` can't be
  pattern-matched the same way).
- If you're adding fixtures, use fabricated names/dates paired with real,
  publicly-known book titles/ISBNs — not real people's reading history.

## Reporting issues with Amazon/Beanstack's undocumented endpoints

Both integrations rely on internal endpoints that aren't official APIs and
could change without notice. If something breaks, a screenshot of the
relevant Network tab request/response (with any personal identifiers
redacted) is the most useful thing to include in an issue.
