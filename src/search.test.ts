import assert from "node:assert/strict";
import { test } from "node:test";
import { findMatches, loadDictionary, normalizeToken, tokenize } from "./search.js";
import type { Word } from "./whisper.js";

const dict = loadDictionary();

/** Fake a word list: one word every 0.4 s. */
const wordsOf = (text: string): Word[] =>
  text.split(/\s+/).filter(Boolean).map((t, i) => ({ text: t, start: i * 0.4, end: i * 0.4 + 0.35 }));

test("normalizeToken squashes stretched letters and punctuation", () => {
  assert.equal(normalizeToken("Readyyy,"), "ready");
  assert.equal(normalizeToken("I'm"), "im");
  assert.equal(normalizeToken("body"), "body");
  assert.equal(normalizeToken("good"), "good"); // a double letter is not squashed
});

test("tokenize expands contractions and applies aliases", () => {
  assert.deepEqual(tokenize("I'm ready, yuh body (yeah)", dict), ["i", "am", "ready", "your", "body"]);
});

test("finds both spellings of the Risky line", () => {
  const words = wordsOf("Risky, risky, yes yuh body risky Risky, me no won go fifty fifty Risky, risky, yes your body risky");
  const hits = findMatches(words, "your body risky", dict);
  assert.equal(hits.length, 2);
  assert.ok(hits.every((h) => h.exact));
  assert.equal(hits[0].match, "yuh body risky");
  assert.equal(hits[1].match, "your body risky");
  assert.ok(hits[0].start < hits[1].start);
});

test("tolerates one ad-lib between words and a one-letter typo", () => {
  const words = wordsOf("baby girl I'm ready oh I'm readdy ready for you");
  const hits = findMatches(words, "ready for you", dict);
  assert.equal(hits.length, 1);
  const fuzzy = findMatches(wordsOf("I am readi for youu"), "I'm ready for you", dict);
  assert.equal(fuzzy.length, 1);
  assert.equal(fuzzy[0].exact, false);
  const adlib = findMatches(wordsOf("your yeah body risky"), "your body risky", dict);
  assert.equal(adlib.length, 1);
});

test("finds a phrase when Whisper misheard or dropped one word", () => {
  const misheard = findMatches(wordsOf("Risky risky yes yo body risky me no won go"), "your body risky", dict);
  assert.equal(misheard.length, 1);
  assert.equal(misheard[0].partial, true);
  assert.equal(misheard[0].match, "yo body risky");

  const dropped = findMatches(wordsOf("yes body risky me no won go"), "your body risky", dict);
  assert.equal(dropped.length, 1);
  assert.ok(dropped[0].match.endsWith("body risky")); // starts at "body", or at "yes" read as a misheard "your"
  assert.equal(dropped[0].partial, true);

  const lastWrong = findMatches(wordsOf("your body tonight"), "your body risky", dict);
  assert.equal(lastWrong.length, 1);
  assert.equal(lastWrong[0].partial, true);
});

test("a full match beats an overlapping partial one", () => {
  const [h] = findMatches(wordsOf("oh your body risky oh"), "your body risky", dict);
  assert.equal(h.partial, false);
  assert.equal(h.match, "your body risky");
});

test("two-word phrases never match partially", () => {
  assert.equal(findMatches(wordsOf("my body is"), "your body", dict).length, 0);
});

test("does not match different words", () => {
  assert.equal(findMatches(wordsOf("pour the whiskey get tipsy"), "your body risky", dict).length, 0);
  assert.equal(findMatches(wordsOf("anything"), "", dict).length, 0);
});

test("a hit carries timings of its first and last words", () => {
  const words = wordsOf("take me take me everywhere you want to go");
  const [h] = findMatches(words, "everywhere you want", dict);
  assert.equal(h.start, words[4].start);
  assert.equal(h.end, words[6].end);
  assert.equal(h.before, "take me take me");
});
