// Aggregates the normalized reading dataset (from amazon-client) into
// per-title and per-week (Mon–Sun) totals, for the in-extension summary
// view. Pure — no I/O. Ports the logic originally prototyped in Python
// during initial research into the shared module used by the extension.

/**
 * Returns the Monday (YYYY-MM-DD) of the week containing the given
 * YYYY-MM-DD date string. Does all arithmetic in UTC-space to avoid the
 * classic JS pitfall of mixing a UTC-parsed date with local-timezone
 * getters — the input is already a plain calendar date with no timezone
 * attached, so this never needs to consult a real IANA time zone.
 */
export function mondayOf(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const utcDate = new Date(Date.UTC(y, m - 1, d));
  const dow = utcDate.getUTCDay(); // 0 = Sun .. 6 = Sat
  const diff = dow === 0 ? 6 : dow - 1; // days since Monday
  utcDate.setUTCDate(utcDate.getUTCDate() - diff);
  return utcDate.toISOString().slice(0, 10);
}

/** Adds `days` to a YYYY-MM-DD string, returning YYYY-MM-DD. Pure. */
export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const utcDate = new Date(Date.UTC(y, m - 1, d));
  utcDate.setUTCDate(utcDate.getUTCDate() + days);
  return utcDate.toISOString().slice(0, 10);
}

/**
 * @param {{date: string, asin: string, title: string, minutes: number}[]} entries
 * @returns {{title: string, asin: string, minutes: number}[]} sorted by minutes desc
 */
export function aggregateByTitle(entries) {
  const byAsin = new Map();
  for (const entry of entries) {
    const key = entry.asin ?? entry.title;
    const existing = byAsin.get(key);
    if (existing) {
      existing.minutes += entry.minutes;
    } else {
      byAsin.set(key, { title: entry.title, asin: entry.asin, minutes: entry.minutes });
    }
  }
  return [...byAsin.values()]
    .map((t) => ({ ...t, minutes: Math.round(t.minutes * 10) / 10 }))
    .sort((a, b) => b.minutes - a.minutes);
}

/**
 * @param {{date: string, minutes: number}[]} entries
 * @returns {{weekStart: string, weekEnd: string, minutes: number}[]} sorted by weekStart asc
 */
export function aggregateByWeek(entries) {
  const byWeek = new Map();
  for (const entry of entries) {
    const weekStart = mondayOf(entry.date);
    byWeek.set(weekStart, (byWeek.get(weekStart) ?? 0) + entry.minutes);
  }
  return [...byWeek.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekStart, minutes]) => ({
      weekStart,
      weekEnd: addDays(weekStart, 6),
      minutes: Math.round(minutes * 10) / 10,
    }));
}

/**
 * Builds a full report for one kid's entries.
 * @returns {{titles: object[], weeks: object[], totalMinutes: number}}
 */
export function buildKidReport(entries) {
  return {
    titles: aggregateByTitle(entries),
    weeks: aggregateByWeek(entries),
    totalMinutes: Math.round(entries.reduce((sum, e) => sum + e.minutes, 0) * 10) / 10,
  };
}

/**
 * Builds reports for every kid in the dataset, keyed by childDirectedId.
 * @param {object[]} dataset - the full merged reading dataset
 * @param {{childDirectedId: string, name: string}[]} kids
 */
export function buildReport(dataset, kids) {
  const report = {};
  for (const kid of kids) {
    const entries = dataset.filter((e) => e.childDirectedId === kid.childDirectedId);
    report[kid.childDirectedId] = { name: kid.name, ...buildKidReport(entries) };
  }
  return report;
}

/**
 * Splits entries into those meeting a minimum-minutes threshold and those
 * below it. A short reading blip (a couple minutes checking a dictionary
 * definition, say) usually isn't worth a separate Beanstack log entry —
 * see README for the real-data analysis behind picking a default. Pure.
 * @returns {{kept: object[], excluded: object[]}}
 */
export function splitByThreshold(entries, minMinutes) {
  const kept = [];
  const excluded = [];
  for (const entry of entries) {
    (entry.minutes >= minMinutes ? kept : excluded).push(entry);
  }
  return { kept, excluded };
}
