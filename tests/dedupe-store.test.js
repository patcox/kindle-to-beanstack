import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getSubmittedKeys, markSubmitted, isSubmitted } from "../extension/lib/dedupe-store.js";

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
