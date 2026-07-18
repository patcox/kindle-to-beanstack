// Tracks which (childDirectedId, date, asin) reading entries have already
// been submitted to Beanstack, so re-opening the review panel is safe to
// do repeatedly without creating duplicate log entries.

import { entryKey } from "./store.js";

const SUBMITTED_KEY = "kb_submitted"; // string[] of entryKey(...) results

export async function getSubmittedKeys() {
  const { [SUBMITTED_KEY]: keys } = await chrome.storage.local.get(SUBMITTED_KEY);
  return new Set(keys ?? []);
}

export async function markSubmitted(entries) {
  const set = await getSubmittedKeys();
  for (const entry of entries) set.add(entryKey(entry));
  await chrome.storage.local.set({ [SUBMITTED_KEY]: [...set] });
}

export function isSubmitted(submittedSet, entry) {
  return submittedSet.has(entryKey(entry));
}
