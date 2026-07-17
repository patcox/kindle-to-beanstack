// Thin wrapper around chrome.storage.local. All personal identifiers
// (childDirectedId, Beanstack profile_id, kid names) live only here — never
// written to a file in this repo. See README "Privacy & data handling".

const KIDS_KEY = "kb_kids"; // [{ childDirectedId, name }]
const READING_DATASET_KEY = "kb_reading_dataset"; // [{ childDirectedId, date, asin, title, minutes, isbn }]
const MIN_MINUTES_KEY = "kb_min_minutes_threshold";

// Default chosen from a real-data analysis (see README): a 5-minute cutoff
// trims ~16% of log entries for a ~0.7% loss in total credited minutes —
// a good trade. 10+ minutes starts cutting real reading time for kids whose
// sessions run shorter (e.g. comic-issue readers), so it isn't the default.
const DEFAULT_MIN_MINUTES = 5;

export async function getMinMinutesThreshold() {
  const { [MIN_MINUTES_KEY]: minutes } = await chrome.storage.local.get(MIN_MINUTES_KEY);
  return minutes ?? DEFAULT_MIN_MINUTES;
}

export async function setMinMinutesThreshold(minutes) {
  await chrome.storage.local.set({ [MIN_MINUTES_KEY]: minutes });
}

export async function getKids() {
  const { [KIDS_KEY]: kids } = await chrome.storage.local.get(KIDS_KEY);
  return kids ?? [];
}

export async function setKids(kids) {
  await chrome.storage.local.set({ [KIDS_KEY]: kids });
}

export async function addOrUpdateKid({ childDirectedId, name }) {
  const kids = await getKids();
  const existing = kids.find((k) => k.childDirectedId === childDirectedId);
  if (existing) {
    existing.name = name;
  } else {
    kids.push({ childDirectedId, name });
  }
  await setKids(kids);
  return kids;
}

/** Removes one kid (e.g. a stale/test entry) by childDirectedId. */
export async function removeKid(childDirectedId) {
  const kids = await getKids();
  const remaining = kids.filter((k) => k.childDirectedId !== childDirectedId);
  await setKids(remaining);
  return remaining;
}

export async function getReadingDataset() {
  const { [READING_DATASET_KEY]: dataset } = await chrome.storage.local.get(READING_DATASET_KEY);
  return dataset ?? [];
}

export async function setReadingDataset(dataset) {
  await chrome.storage.local.set({ [READING_DATASET_KEY]: dataset });
}

/**
 * Merges freshly-pulled entries into the stored dataset, keyed by
 * (childDirectedId, date, asin) so re-pulling an overlapping date range is
 * idempotent rather than creating duplicates.
 */
export async function mergeReadingDataset(newEntries) {
  const existing = await getReadingDataset();
  const byKey = new Map(existing.map((e) => [entryKey(e), e]));
  for (const entry of newEntries) {
    byKey.set(entryKey(entry), entry);
  }
  const merged = [...byKey.values()];
  await setReadingDataset(merged);
  return merged;
}

export function entryKey(entry) {
  return `${entry.childDirectedId}|${entry.date}|${entry.asin}`;
}
