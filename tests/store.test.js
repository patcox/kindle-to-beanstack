import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getKids,
  setKids,
  addOrUpdateKid,
  getReadingDataset,
  mergeReadingDataset,
  entryKey,
  getMinMinutesThreshold,
  setMinMinutesThreshold,
} from "../extension/lib/store.js";

function installMockChromeStorage() {
  const data = {};
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          return { [key]: data[key] };
        },
        async set(obj) {
          Object.assign(data, obj);
        },
      },
    },
  };
  return data;
}

beforeEach(() => {
  installMockChromeStorage();
});

test("entryKey combines childDirectedId, date, and asin", () => {
  assert.equal(entryKey({ childDirectedId: "c1", date: "2026-07-01", asin: "B1" }), "c1|2026-07-01|B1");
});

test("getKids returns an empty array when nothing is stored", async () => {
  assert.deepEqual(await getKids(), []);
});

test("setKids/getKids round-trip", async () => {
  await setKids([{ childDirectedId: "c1", name: "Alex" }]);
  assert.deepEqual(await getKids(), [{ childDirectedId: "c1", name: "Alex" }]);
});

test("addOrUpdateKid adds a new kid and updates an existing one by childDirectedId", async () => {
  await addOrUpdateKid({ childDirectedId: "c1", name: "Alex" });
  await addOrUpdateKid({ childDirectedId: "c2", name: "Sam" });
  await addOrUpdateKid({ childDirectedId: "c1", name: "Alexandra" });
  assert.deepEqual(await getKids(), [
    { childDirectedId: "c1", name: "Alexandra" },
    { childDirectedId: "c2", name: "Sam" },
  ]);
});

test("getMinMinutesThreshold defaults to 5 minutes when unset", async () => {
  assert.equal(await getMinMinutesThreshold(), 5);
});

test("setMinMinutesThreshold/getMinMinutesThreshold round-trip", async () => {
  await setMinMinutesThreshold(8);
  assert.equal(await getMinMinutesThreshold(), 8);
});

test("mergeReadingDataset dedupes by (childDirectedId, date, asin), keeping the newest value", async () => {
  await mergeReadingDataset([{ childDirectedId: "c1", date: "2026-07-01", asin: "B1", title: "T", minutes: 10 }]);
  await mergeReadingDataset([{ childDirectedId: "c1", date: "2026-07-01", asin: "B1", title: "T", minutes: 15 }]);
  await mergeReadingDataset([{ childDirectedId: "c1", date: "2026-07-02", asin: "B1", title: "T", minutes: 5 }]);
  const dataset = await getReadingDataset();
  assert.equal(dataset.length, 2);
  const day1 = dataset.find((e) => e.date === "2026-07-01");
  assert.equal(day1.minutes, 15);
});
