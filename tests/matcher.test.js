import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { normalizeTitle, pickBestMatch, simplifyTitleForSearch } from "../extension/lib/matcher.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadFixture(name) {
  const raw = await readFile(path.join(__dirname, "fixtures", name), "utf8");
  return JSON.parse(raw);
}

test("normalizeTitle lowercases and strips punctuation", () => {
  assert.equal(normalizeTitle("The Secret Zoo: Riddles and Danger!"), "the secret zoo riddles and danger");
});

test("pickBestMatch returns 'none' for an empty candidate list", () => {
  const result = pickBestMatch({ candidates: [], queryTitle: "Dog Man" });
  assert.equal(result.confidence, "none");
  assert.equal(result.candidate, null);
});

test("pickBestMatch picks the ISBN-matching candidate with high confidence", async () => {
  const candidates = await loadFixture("beanstack-search-response.json");
  const result = pickBestMatch({
    candidates,
    queryTitle: "Diary of a Wimpy Kid",
    queryIsbn: "9780810970687",
  });
  assert.equal(result.confidence, "high");
  assert.equal(result.candidate.id, 67890);
});

test("pickBestMatch falls back to medium confidence on exact title match without ISBN", async () => {
  const candidates = await loadFixture("beanstack-search-response.json");
  const result = pickBestMatch({ candidates, queryTitle: "Diary of a Wimpy Kid" });
  assert.equal(result.confidence, "medium");
  assert.equal(result.candidate.id, 12345); // top candidate
});

test("pickBestMatch returns low confidence when the top title doesn't closely match", async () => {
  const candidates = await loadFixture("beanstack-search-response.json");
  const result = pickBestMatch({ candidates, queryTitle: "Some Completely Different Book" });
  assert.equal(result.confidence, "low");
});

test("simplifyTitleForSearch strips a trailing parenthetical annotation", () => {
  assert.equal(
    simplifyTitleForSearch("Big Nate: Destined for Awesomeness (Big Nate TV Series Graphic Novel)"),
    "Big Nate: Destined for Awesomeness"
  );
});

test("simplifyTitleForSearch strips a leading 'The Complete ' prefix", () => {
  assert.equal(
    simplifyTitleForSearch("The Complete Big Nate: #15 (AMP! Comics for Kids)"),
    "Big Nate: #15"
  );
});

test("simplifyTitleForSearch returns null when there's nothing to strip", () => {
  assert.equal(simplifyTitleForSearch("Diary of a Wimpy Kid"), null);
});
