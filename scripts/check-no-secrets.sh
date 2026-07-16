#!/usr/bin/env bash
# Guards against accidentally committing real Amazon childDirectedId values
# into this public repo. Run locally before pushing, and enforced in CI
# (.github/workflows/check-no-secrets.yml) on every push/PR.
#
# Scope note: this only reliably catches Amazon's childDirectedId, which has
# a distinctive "amzn1.account." prefix. Beanstack's profile_id is a bare
# integer with no distinguishing shape, so it can't be grepped for without
# either embedding the real value here (self-defeating) or drowning in false
# positives from dates/ISBNs/minute counts. The real defense for profile_id
# is structural: the extension never writes it to a file, only to
# chrome.storage.local. Don't treat a clean run of this script as proof a
# diff is free of personal data — always eyeball `git diff` too.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Real Amazon childDirectedId values look like: amzn1.account.XXXXXXXXXXXXXXXXXXXXXXXXX
PATTERNS=(
  'amzn1\.account\.[A-Z0-9]{20,}'
)

found=0
for pattern in "${PATTERNS[@]}"; do
  if git grep -nIE "$pattern" -- . ':(exclude)scripts/check-no-secrets.sh' 2>/dev/null; then
    echo "::error::Found a pattern matching a real Amazon account identifier ($pattern)." >&2
    found=1
  fi
done

if [ "$found" -ne 0 ]; then
  echo "" >&2
  echo "check-no-secrets: BLOCKED. Remove the matched value(s) above before committing/pushing." >&2
  echo "Personal identifiers belong in chrome.storage.local (set via the extension's setup UI), never in a repo file." >&2
  exit 1
fi

echo "check-no-secrets: OK, no matches found."
