// Thin wrapper around chrome.storage.local. All personal identifiers
// (childDirectedId, Beanstack profile_id, kid names) live only here — never
// written to a file in this repo. See README "Privacy & data handling".

const KIDS_KEY = "kb_kids"; // [{ childDirectedId, name }]
const READING_DATASET_KEY = "kb_reading_dataset"; // [{ childDirectedId, date, asin, title, minutes, isbn }]

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
