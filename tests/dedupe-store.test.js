import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getSubmittedKeys,
  markSubmitted,
  unmarkSubmitted,
  isSubmitted,
  recordBatch,
  getLastBatch,
  clearLastBatch,
} from "../extension/lib/dedupe-store.js";

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

test("getSubmittedKeys starts empty", async () => {
  assert.deepEqual(await getSubmittedKeys(), new Set());
});

test("markSubmitted then isSubmitted reflects marked entries", async () => {
  const entry = { childDirectedId: "c1", date: "2026-07-01", asin: "B1" };
  const other = { childDirectedId: "c1", date: "2026-07-02", asin: "B1" };
  assert.equal(isSubmitted(await getSubmittedKeys(), entry), false);
  await markSubmitted([entry]);
  const set = await getSubmittedKeys();
  assert.equal(isSubmitted(set, entry), true);
  assert.equal(isSubmitted(set, other), false);
});

test("unmarkSubmitted removes an entry so it becomes eligible again", async () => {
  const entry = { childDirectedId: "c1", date: "2026-07-01", asin: "B1" };
  await markSubmitted([entry]);
  assert.equal(isSubmitted(await getSubmittedKeys(), entry), true);
  await unmarkSubmitted([entry]);
  assert.equal(isSubmitted(await getSubmittedKeys(), entry), false);
});

test("getLastBatch starts empty", async () => {
  assert.deepEqual(await getLastBatch(), []);
});

test("recordBatch/getLastBatch round-trip, and a new batch replaces the old one", async () => {
  const batch1 = [{ entry: { title: "A" }, loggedBookId: "1" }];
  const batch2 = [{ entry: { title: "B" }, loggedBookId: "2" }];
  await recordBatch(batch1);
  assert.deepEqual(await getLastBatch(), batch1);
  await recordBatch(batch2);
  assert.deepEqual(await getLastBatch(), batch2);
});

test("clearLastBatch empties the recorded batch", async () => {
  await recordBatch([{ entry: { title: "A" }, loggedBookId: "1" }]);
  await clearLastBatch();
  assert.deepEqual(await getLastBatch(), []);
});
