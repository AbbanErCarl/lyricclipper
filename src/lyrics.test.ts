import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { alignFromSynced, alignLyrics, cleanTitle, lyricQueries, pickBest, plainFromSynced, similarity } from "./lyrics.js";
import { findMatches, loadDictionary } from "./search.js";
import type { Word } from "./whisper.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const RISKY = fs.readFileSync(path.join(here, "fixtures", "risky.txt"), "utf8");
const dict = loadDictionary();

/**
 * Fake a Whisper transcript of Risky the way it really went wrong on the laptop:
 * an intro it made up, "your body risky" heard as "you're a very risky", Pidgin and
 * Yoruba lines mangled, ad-libs and some words missing. 0.4 s a word, 2 s between lines.
 */
function misheardRisky() {
  const swaps: [RegExp, string][] = [
    [/\byes (your|yuh) body risky\b/gi, "yes, you're a very risky--"],
    [/\bkilo ko mi\b/gi, "kill a common"],
    [/\bodikwa\b/gi, "or the car"],
    [/\bchargie\b/gi, "charge"],
    [/\bfifty fifty\b/gi, "50-50"],
    [/\([^)]*\)/g, ""],
  ];
  const words: Word[] = [];
  const truth: number[] = []; // where each sung "your body risky" really starts
  let t = 0;
  for (const w of "two, plus one out two, jeez.".split(" ")) {
    words.push({ text: w, start: t, end: t + 0.35 });
    t += 0.4;
  }
  t += 3;
  let dropCounter = 0;
  for (const raw of RISKY.split("\n")) {
    let line = raw;
    for (const [re, to] of swaps) line = line.replace(re, to);
    const parts = line.split(/\s+/).filter(Boolean);
    parts.forEach((w, k) => {
      if (w === "you're" && parts[k + 1] === "a" && parts[k + 2] === "very") truth.push(t);
      if (++dropCounter % 11 === 0 && !/you're|very|risky/.test(w)) return; // Whisper skips a word now and then
      words.push({ text: w, start: t, end: t + 0.35 });
      t += 0.4;
    });
    t += 2;
  }
  return { words, truth };
}

test("cleanTitle strips YouTube clutter and the artist prefix", () => {
  const c = cleanTitle("Davido - Risky (Official Video) ft. Popcaan", "Davido");
  assert.equal(c.title, "Risky ft. Popcaan");
  assert.equal(c.track, "Risky");
  assert.equal(c.artist, "Davido");
  const d = cleanTitle("FKYO - Ready (Live) [Official Audio]", "");
  assert.equal(d.artist, "FKYO");
  assert.equal(d.track, "Ready");
  assert.equal(cleanTitle("Burna Boy & Ed Sheeran - For My Hand", "").primaryArtist, "Burna Boy");
});

test("pickBest prefers a name match with lyrics and the closest duration", () => {
  const recs = [
    { id: 1, trackName: "Risky", artistName: "Davido", duration: 300, plainLyrics: "x" },
    { id: 2, trackName: "Risky", artistName: "Davido", duration: 271, plainLyrics: "x" },
    { id: 3, trackName: "Risky", artistName: "Davido", duration: 270, instrumental: true },
    { id: 4, trackName: "Something Else", artistName: "Davido", duration: 270, plainLyrics: "x" },
  ];
  assert.equal(pickBest(recs, "Risky", 270)?.id, 2);
  assert.equal(pickBest([], "Risky", 270), null);
  // Unknown or equal duration: the fuller lyrics win over a stub.
  const stub = [
    { id: 5, trackName: "Risky", artistName: "Davido", duration: 271, plainLyrics: "risky risky" },
    { id: 6, trackName: "Risky", artistName: "Davido", duration: 272, plainLyrics: "Risky, risky\nYes yuh body risky\n…" },
  ];
  assert.equal(pickBest(stub, "Risky", 0)?.id, 6);
  assert.equal(pickBest(stub, "Risky", 271)?.id, 6);
});

test("plainFromSynced drops timestamps", () => {
  assert.equal(plainFromSynced("[00:12.34] Risky, risky\n[00:15.00]Yes yuh body risky"), "Risky, risky\nYes yuh body risky");
});

test("similarity tolerates sung spellings", () => {
  assert.ok(similarity("risky", "riskier") >= 0.6);
  assert.ok(similarity("your", "you") >= 0.6);
  assert.ok(similarity("body", "very") < 0.6);
});

test("aligned lyrics find every 'your body risky' Whisper misheard", () => {
  const { words, truth } = misheardRisky();

  // Whisper's own words: none of the misheard ones are found.
  const raw = findMatches(words, "your body risky", dict).filter((h) => !h.partial);
  assert.ok(truth.every((t0) => !raw.some((h) => Math.abs(h.start - t0) < 0.8)));

  const a = alignLyrics(RISKY, words, dict);
  assert.ok(a.usable, `coverage ${a.coverage}`);
  assert.ok(a.coverage > 0.4, `coverage ${a.coverage}`);

  const hits = findMatches(a.words, "your body risky", dict).filter((h) => h.exact);
  // Every sung "yes your/yuh body risky" that Whisper turned into "you're a very risky"…
  for (const t0 of truth) {
    const near = hits.find((h) => Math.abs(h.start - t0) < 0.8);
    assert.ok(near, `no hit near ${t0.toFixed(1)} s; hits at ${hits.map((h) => h.start.toFixed(1)).join(", ")}`);
  }
  // …and the timings are in song order.
  for (let i = 1; i < a.words.length; i++) assert.ok(a.words[i].start >= a.words[i - 1].start - 1e-6);
});

test("lyrics for a different song don't line up", () => {
  const { words } = misheardRisky();
  const short = "Hello from the other side\nI must have called a thousand times\nTo tell you I'm sorry\nFor everything that I've done";
  assert.equal(alignLyrics(short, words, dict).usable, false);
  const long = (
    "Twinkle twinkle little star how I wonder what you are up above the world so high like a diamond in the sky\n" +
    "Mary had a little lamb its fleece was white as snow and everywhere that Mary went the lamb was sure to go\n" +
    "Baby girl I'm ready oh I'm ready ready for you money in the bank and whiskey on the table\n"
  ).repeat(4);
  assert.equal(alignLyrics(long, words, dict).usable, false);
});

test("a pasted chorus alone still lines up", () => {
  const { words, truth } = misheardRisky();
  const a = alignLyrics("Risky, risky, yes your body risky\nRisky, me no won go fifty fifty\nRisky, risky, yes your body risky", words, dict);
  assert.ok(a.usable, `coverage ${a.coverage} density ${a.density}`);
  const hits = findMatches(a.words, "your body risky", dict);
  assert.ok(hits.some((h) => truth.some((t0) => Math.abs(h.start - t0) < 0.8)));
});

test("messy YouTube titles: uploader isn't the artist, no dash, no brackets", () => {
  const c = cleanTitle("Stonebwoy ft Chivv Good morning official video", "Cassi Sham");
  assert.equal(c.artist, "Stonebwoy");
  assert.equal(c.track, "Good morning");
  assert.equal(c.title, "Good morning ft. Chivv");
  assert.equal(c.trusted, true);
  // cleaning the cleaned result changes nothing
  assert.equal(cleanTitle(c.title, c.artist).title, c.title);
  // real metadata is trusted even when the title doesn't name the artist
  assert.equal(cleanTitle("Risky", "Davido", true).trusted, true);
  assert.equal(cleanTitle("Some Song", "Random Uploader").trusted, false);
});

test("LRCLIB searches: specific first, then free text without the guest", () => {
  const qs = lyricQueries("Stonebwoy ft Chivv Good morning official video", "Cassi Sham").map((q) => q.params);
  assert.deepEqual(qs[0], { track_name: "Good morning", artist_name: "Stonebwoy" });
  assert.ok(qs.some((p) => p.q === "Stonebwoy ft Chivv Good morning"));
  assert.ok(qs.some((p) => p.q === "Stonebwoy Good morning"));
  assert.ok(!qs.some((p) => JSON.stringify(p).includes("Cassi")));
});

test("pickBest prefers the known artist over a same-named song", () => {
  const recs = [
    { id: 1, trackName: "Good Morning", artistName: "Kanye West", duration: 196, plainLyrics: "x".repeat(900) },
    { id: 2, trackName: "Good Morning", artistName: "Stonebwoy", duration: 205, plainLyrics: "x".repeat(800) },
  ];
  assert.equal(pickBest(recs, "Good morning", 197, ["Stonebwoy"])?.id, 2);
  assert.equal(pickBest(recs, "Stonebwoy Good morning", 197)?.id, 2);
  assert.equal(pickBest(recs, "Something else entirely", 197), null);
});

test("synced lyrics give line timings when Whisper can't", () => {
  const a = alignFromSynced("[00:12.50] Good morning to the maker\n[00:15.00] You do me all this favor\n[00:17.80]\n[00:20.00] Chilling in Jamaica");
  assert.ok(a.usable);
  assert.equal(a.words[0].text, "Good");
  assert.equal(a.words[0].start, 12.5);
  assert.equal(a.words[5].text, "You");
  assert.equal(a.words[5].start, 15);
  assert.ok(a.words.every((w) => w.est));
  const hits = findMatches(a.words, "good morning", dict);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].start, 12.5);
});
