import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";
import type { Word } from "./whisper.js";

export interface Dictionary {
  aliases: Record<string, string>;
  contractions: Record<string, string>;
}

export interface Hit {
  startWord: number;
  endWord: number;
  start: number;
  end: number;
  score: number; // query length = perfect
  exact: boolean;
  partial: boolean; // one query word was misheard or missing
  before: string;
  match: string;
  after: string;
}

export function loadDictionary(file = path.join(ROOT, "aliases.json")): Dictionary {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    return { aliases: d.aliases ?? {}, contractions: d.contractions ?? {} };
  } catch {
    return { aliases: {}, contractions: {} };
  }
}

/** Lowercase, drop apostrophes, squash stretched letters ("readyyy" -> "ready"). */
export function normalizeToken(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // accents
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .replace(/(.)\1{2,}/g, "$1");
}

/** Text -> canonical tokens, expanding contractions and applying aliases. */
export function tokenize(text: string, dict: Dictionary): string[] {
  const out: string[] = [];
  const cleaned = text.replace(/\([^)]*\)|\[[^\]]*\]/g, " "); // drop (ad-libs) and [tags]
  for (const piece of cleaned.split(/[\s\-–—/]+/)) {
    const t = normalizeToken(piece);
    if (!t) continue;
    for (const part of (dict.contractions[t] ?? t).split(" ")) {
      out.push(dict.aliases[part] ?? part);
    }
  }
  return out;
}

const squashDoubles = (s: string) => s.replace(/(.)\1+/g, "$1");

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** 0 = same word, small positive = close spelling, null = different word. */
export function tokenCost(q: string, t: string): number | null {
  if (q === t) return 0;
  if (squashDoubles(q) === squashDoubles(t)) return 0.25; // "ready" vs "readdy"
  if (q.length >= 4 && t.length >= 4 && levenshtein(q, t) <= 1) return 1;
  return null;
}

interface Path {
  cost: number;
  last: number; // index of the last transcript token used
  misses: number;
  skips: number;
}

const MISS_COST = 1.5; // a query word Whisper heard as something else, or left out
const SKIP_COST = 0.5; // an extra transcript word (an ad-lib) between query words

/**
 * Find every place the query's words occur in order. Tolerates:
 * - spelling variants (aliases.json) and one-letter typos in words of 4+ letters
 * - one extra word between query words (an ad-lib: "your yeah body risky")
 * - for 3+ word phrases, one misheard or missing word ("yo body risky"); 6+ words, two
 * A hit with a misheard word is marked `partial`.
 */
export function findMatches(words: Word[], query: string, dict: Dictionary = loadDictionary()): Hit[] {
  const q = tokenize(query, dict).slice(0, 12);
  if (q.length === 0) return [];
  const t: { tok: string; wi: number }[] = [];
  words.forEach((w, wi) => tokenize(w.text, dict).forEach((tok) => t.push({ tok, wi })));

  const maxMisses = q.length >= 6 ? 2 : q.length >= 3 ? 1 : 0;
  const maxFuzz = Math.max(1, Math.floor(q.length / 2));

  // Cheapest way to consume q[qi..] starting at transcript token ti.
  const best = (qi: number, ti: number, last: number, misses: number, skips: number, fuzz: number): Path | null => {
    if (qi === q.length) return { cost: 0, last, misses: 0, skips: 0 };
    let out: Path | null = null;
    const consider = (p: Path | null, add: number, miss: number, skip: number) => {
      if (!p) return;
      const cand = { cost: p.cost + add, last: p.last, misses: p.misses + miss, skips: p.skips + skip };
      if (!out || cand.cost < out.cost || (cand.cost === out.cost && cand.misses < out.misses)) out = cand;
    };
    if (ti < t.length) {
      const c = tokenCost(q[qi], t[ti].tok);
      if (c !== null && (c === 0 || fuzz >= c)) consider(best(qi + 1, ti + 1, ti, misses, skips, fuzz - c), c, 0, 0);
      if (misses > 0) consider(best(qi + 1, ti + 1, ti, misses - 1, skips, fuzz), MISS_COST, 1, 0); // misheard
    }
    if (qi > 0) {
      if (misses > 0) consider(best(qi + 1, ti, last, misses - 1, skips, fuzz), MISS_COST, 1, 0); // left out
      if (skips > 0 && ti < t.length) consider(best(qi, ti + 1, last, misses, skips - 1, fuzz), SKIP_COST, 0, 1); // ad-lib
    }
    return out;
  };

  const matches = (qi: number, ti: number) => qi < q.length && ti < t.length && tokenCost(q[qi], t[ti].tok) !== null;
  const cheaper = (a: Path | null, b: Path | null) => (!a ? b : !b ? a : b.cost < a.cost ? b : a);

  const raw: Hit[] = [];
  for (let i = 0; i < t.length; i++) {
    // Anchor every hit on something Whisper actually heard:
    //  - t[i] matches the first query word, or
    //  - the first query word was misheard as t[i] and t[i+1] matches the second, or
    //  - the first query word is missing and t[i] matches the second.
    let p: Path | null = null;
    if (matches(0, i)) p = best(0, i, i, maxMisses, 1, maxFuzz);
    if (maxMisses > 0 && matches(1, i + 1)) p = cheaper(p, best(0, i, i, maxMisses, 1, maxFuzz));
    if (maxMisses > 0 && matches(1, i)) {
      const rest = best(1, i, i, maxMisses - 1, 1, maxFuzz);
      if (rest) p = cheaper(p, { ...rest, cost: rest.cost + MISS_COST, misses: rest.misses + 1 });
    }
    if (!p) continue;
    const startWord = t[i].wi;
    const endWord = t[p.last].wi;
    const cost = p.cost;
    const skips = p.skips;
    const ctx = (a: number, b: number) => words.slice(Math.max(0, a), Math.max(0, b)).map((w) => w.text).join(" ");
    raw.push({
      startWord,
      endWord,
      start: words[startWord].start,
      end: words[endWord].end,
      score: Math.round((q.length - cost) * 100) / 100,
      exact: cost === 0 && skips === 0,
      partial: p.misses > 0,
      before: ctx(startWord - 6, startWord),
      match: ctx(startWord, endWord + 1),
      after: ctx(endWord + 1, endWord + 7),
    });
  }

  // Keep the best hit where hits overlap, then list in song order.
  raw.sort((a, b) => b.score - a.score || a.start - b.start);
  const kept: Hit[] = [];
  for (const h of raw) {
    if (!kept.some((k) => h.startWord <= k.endWord && k.startWord <= h.endWord)) kept.push(h);
  }
  return kept.sort((a, b) => a.start - b.start);
}
