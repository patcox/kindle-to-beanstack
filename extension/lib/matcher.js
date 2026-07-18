// Picks the best Beanstack catalog candidate for a given Amazon title and
// assigns a confidence level, so the review UI can flag anything that
// needs a human look rather than silently trusting a fuzzy match.
// All pure — no I/O.

export function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Amazon listing titles often carry decorations Beanstack's own catalog
 * title doesn't have — a trailing "(imprint/series name)" annotation (e.g.
 * "(AMP! Comics for Kids)", "(Big Nate TV Series Graphic Novel)"), or a
 * "The Complete " prefix on a compilation edition — and an exact-title
 * search against those comes back with zero candidates even though the
 * underlying book is in Beanstack's catalog under a plainer title. When a
 * search comes back empty, retrying once with this simplified title can
 * still find it. Pure — returns null if there's nothing to strip, so the
 * caller knows a retry isn't worth it.
 */
export function simplifyTitleForSearch(title) {
  let simplified = title.replace(/\s*\([^)]*\)\s*$/, "").trim();
  simplified = simplified.replace(/^The Complete\s+/i, "").trim();
  return simplified && simplified !== title ? simplified : null;
}

/**
 * @param {{candidates: object[], queryTitle: string, queryIsbn?: string|null}} args
 * @returns {{candidate: object|null, confidence: "high"|"medium"|"low"|"none", reason: string}}
 */
export function pickBestMatch({ candidates, queryTitle, queryIsbn }) {
  if (!candidates || candidates.length === 0) {
    return { candidate: null, confidence: "none", reason: "Beanstack's catalog returned no matches" };
  }

  if (queryIsbn) {
    const isbnMatch = candidates.find(
      (c) => c.isbn_13 === queryIsbn || c.isbn_10 === queryIsbn
    );
    if (isbnMatch) {
      return { candidate: isbnMatch, confidence: "high", reason: "exact ISBN match" };
    }
  }

  const top = candidates[0];
  const normQuery = normalizeTitle(queryTitle);
  const normCandidate = normalizeTitle(top.title);
  if (normQuery === normCandidate) {
    return { candidate: top, confidence: "medium", reason: "exact title match, no ISBN to confirm edition" };
  }
  if (normCandidate.includes(normQuery) || normQuery.includes(normCandidate)) {
    return { candidate: top, confidence: "medium", reason: "close title match, no ISBN to confirm edition" };
  }
  return { candidate: top, confidence: "low", reason: "fuzzy match only — review before submitting" };
}
