// Tracks which (childDirectedId, date, asin) reading entries have already
// been submitted to Beanstack, so re-opening the review panel is safe to
// do repeatedly without creating duplicate log entries.

import { entryKey } from "./store.js";

const SUBMITTED_KEY = "kb_submitted"; // string[] of entryKey(...) results
const LAST_BATCH_KEY = "kb_last_batch"; // { entry, loggedBookId }[] — undo target

export async function getSubmittedKeys() {
  const { [SUBMITTED_KEY]: keys } = await chrome.storage.local.get(SUBMITTED_KEY);
  return new Set(keys ?? []);
}

export async function markSubmitted(entries) {
  const set = await getSubmittedKeys();
  for (const entry of entries) set.add(entryKey(entry));
  await chrome.storage.local.set({ [SUBMITTED_KEY]: [...set] });
}

/** Removes entries from the submitted set, e.g. after undoing a batch. */
export async function unmarkSubmitted(entries) {
  const set = await getSubmittedKeys();
  for (const entry of entries) set.delete(entryKey(entry));
  await chrome.storage.local.set({ [SUBMITTED_KEY]: [...set] });
}

export function isSubmitted(submittedSet, entry) {
  return submittedSet.has(entryKey(entry));
}

/**
 * Records the most recently submitted batch, pairing each entry with the
 * Beanstack log ID it turned out to have (learned by re-reading the log
 * after submission — the create response itself carries no ID). Replaces
 * any previously recorded batch; only the most recent one is undo-able.
 * @param {{entry: object, loggedBookId: string|null}[]} records
 */
export async function recordBatch(records) {
  await chrome.storage.local.set({ [LAST_BATCH_KEY]: records });
}

export async function getLastBatch() {
  const { [LAST_BATCH_KEY]: records } = await chrome.storage.local.get(LAST_BATCH_KEY);
  return records ?? [];
}

export async function clearLastBatch() {
  await chrome.storage.local.set({ [LAST_BATCH_KEY]: [] });
}
