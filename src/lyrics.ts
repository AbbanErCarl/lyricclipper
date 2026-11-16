/**
 * Lyrics: look them up on LRCLIB, then line them up against Whisper's timed words so every
 * lyric word gets a time. Whisper supplies WHEN, the lyrics supply WHAT.
 *
 *   lyrics:  yes  your  body  risky
 *   whisper: yes  you're  a  very  risky      (misheard, but timed)
 *
 * A global alignment (Needleman-Wunsch, like a diff) pairs the two token streams in order.
 * Paired tokens take Whisper's time; lyric tokens with no partner get times interpolated
 * from their neighbours and are flagged `est` (estimated).
 */
import { levenshtein, loadDictionary, normalizeToken, type Dictionary } from "./search.js";
import type { Word } from "./whisper.js";

export interface LyricsInfo {
  source: "lrclib" | "pasted";
  id?: number;
  trackName?: string;
  artistName?: string;
  duration?: number;
  plain: string;
  synced?: string; // LRCLIB's line-timed lyrics, when it has them
  forced?: boolean; // the user said to use them even though they don't seem to line up
}

export interface TimedWord extends Word {
  est: boolean; // timing interpolated or taken from a dissimilar Whisper word
  line: number;
}

export interface Alignment {
  words: TimedWord[];
  coverage: number; // share of the lyrics' content words Whisper heard (near-)correctly
  density: number; // share of Whisper's content words (where the lyrics land) the lyrics explain
  usable: boolean; // the lyrics belong to this recording
}

// ---- titles ----------------------------------------------------------------------

const JUNK =
  /\s*[([][^)\]]*\b(official|video|audio|lyrics?|visuali[sz]er|music video|hd|4k|explicit|clean|performance)\b[^)\]]*[)\]]/gi;
// The same clutter without brackets, at the end: "… Good morning official video"
const TRAILING_JUNK =
  /\s*[-–|:]?\s*\b(?:official\s+(?:music\s+)?(?:video|audio|visuali[sz]er|lyrics?(?:\s+video)?)|music\s+video|lyrics?\s+video|official|visuali[sz]er|lyrics|hd|4k)\s*$/i;
const FEAT = /\s*[([]?\b(?:ft|feat|featuring)\b\.?\s.*$/i;
// "Stonebwoy ft Chivv Good morning": artist, one-word guest, title
const ARTIST_FT_GUEST_TITLE = /^(.+?)\s+(?:ft|feat|featuring)\.?\s+(\S+)\s+(.+)$/i;

const lower = (s: string) => s.toLowerCase();

/**
 * "Davido - Risky (Official Video) ft. Popcaan" -> title "Risky ft. Popcaan", track "Risky", artist "Davido".
 * `trusted` is false when the artist is probably just the uploader (not named in the title).
 */
export function cleanTitle(rawTitle: string, rawArtist: string, artistIsReal = false) {
  let title = rawTitle.replace(JUNK, "").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3 && TRAILING_JUNK.test(title); i++) title = title.replace(TRAILING_JUNK, "").trim();
  const bare = title; // cleaned, before splitting off the artist: good for free-text search
  let artist = rawArtist.trim();
  let trusted = artistIsReal && Boolean(artist);
  const dash = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dash) {
    const [, left, right] = dash;
    const a = lower(artist), l = lower(left);
    if (!artist || a.includes(l) || l.includes(a)) {
      artist = artist || left.trim();
      title = right.trim();
      trusted = true;
    }
  }
  if (!trusted && artist && lower(title).includes(lower(artist.split(/[,&]/)[0].trim()))) trusted = true;
  if (!trusted) {
    const m = title.match(ARTIST_FT_GUEST_TITLE);
    if (m) {
      artist = m[1].trim();
      title = `${m[3].trim()} ft. ${m[2]}`;
      trusted = true;
    }
  }
  const track = title.replace(FEAT, "").replace(/[([][^)\]]*[)\]]/g, "").trim() || title;
  const primaryArtist = artist.split(/\s*(?:,|&|\bx\b|\bft\.?|\bfeat\.?|\band\b)\s*/i)[0].trim() || artist;
  return { title, track, artist, primaryArtist, trusted, bare };
}

// ---- LRCLIB ----------------------------------------------------------------------

interface LrclibRecord {
  id: number;
  trackName: string;
  artistName: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

export function plainFromSynced(synced: string): string {
  return synced
    .split(/\r?\n/)
    .map((l) => l.replace(/^(\s*\[[^\]]*\])+\s?/, ""))
    .join("\n")
    .trim();
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "");

/**
 * Best record: has lyrics, its title is in what we searched for, then the artist we know,
 * then duration closest to the recording, then the fullest lyrics.
 */
export function pickBest(records: LrclibRecord[], searched: string, duration: number, artists: string[] = []): LrclibRecord | null {
  const withText = records.filter((r) => !r.instrumental && (r.plainLyrics || r.syncedLyrics));
  if (!withText.length) return null;
  const hay = norm(searched);
  const named = withText.filter((r) => {
    const n = norm(r.trackName ?? "");
    return n.length > 0 && (hay.includes(n) || n.includes(hay));
  });
  if (!named.length) return null;
  const hints = [...artists.map(norm).filter(Boolean), hay];
  const artistMiss = (r: LrclibRecord) => {
    const a = norm(r.artistName ?? "");
    return a && hints.some((h) => h.includes(a) || a.includes(h)) ? 0 : 1;
  };
  // Durations within 3 s count as equal; stubs and partial entries exist, so fuller lyrics win ties.
  const dist = (r: LrclibRecord) => (duration && r.duration ? Math.round(Math.abs(r.duration - duration) / 3) : 0);
  const size = (r: LrclibRecord) => (r.plainLyrics ?? r.syncedLyrics ?? "").length;
  return [...named].sort((a, b) => artistMiss(a) - artistMiss(b) || dist(a) - dist(b) || size(b) - size(a))[0];
}

async function lrclib(params: Record<string, string>): Promise<LrclibRecord[]> {
  const base = process.env.LRCLIB_URL ?? "https://lrclib.net";
  const url = `${base}/api/search?${new URLSearchParams(params)}`;
  const r = await fetch(url, {
    headers: { "User-Agent": "lyricclipper/0.3 (personal tool)" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!r.ok) throw new Error(`LRCLIB answered ${r.status}`);
  return (await r.json()) as LrclibRecord[];
}

/** The searches to try, most specific first. */
export function lyricQueries(rawTitle: string, rawArtist: string, query?: string, artistIsReal = false) {
  if (query) return [{ params: { q: query }, searched: query, artists: [] as string[] }];
  const c = cleanTitle(rawTitle, rawArtist, artistIsReal);
  const artists = c.trusted ? [c.primaryArtist] : [];
  const noGuest = c.bare.replace(/\b(?:ft|feat|featuring)\.?\s+\S+/i, "").replace(/\s+/g, " ").trim();
  const list: { params: Record<string, string>; searched: string }[] = [
    ...(c.trusted ? [{ params: { track_name: c.track, artist_name: c.primaryArtist }, searched: c.track }] : []),
    ...(c.trusted ? [{ params: { q: `${c.primaryArtist} ${c.track}` }, searched: c.track }] : []),
    { params: { q: c.bare }, searched: c.bare },
    { params: { q: noGuest }, searched: noGuest },
    { params: { q: c.track }, searched: c.track },
  ];
  const seen = new Set<string>();
  return list
    .filter((x) => {
      const k = JSON.stringify(x.params);
      if (seen.has(k) || !Object.values(x.params).every(Boolean)) return false;
      seen.add(k);
      return true;
    })
    .map((x) => ({ ...x, artists }));
}

/** Search LRCLIB a few ways. Returns null when it has nothing usable. */
export async function fetchLyrics(
  rawTitle: string,
  rawArtist: string,
  duration: number,
  query?: string,
  artistIsReal = false,
): Promise<LyricsInfo | null> {
  for (const { params, searched, artists } of lyricQueries(rawTitle, rawArtist, query, artistIsReal)) {
    const best = pickBest(await lrclib(params), searched, duration, artists);
    if (best) {
      return {
        source: "lrclib",
        id: best.id,
        trackName: best.trackName,
        artistName: best.artistName,
        duration: best.duration,
        plain: best.plainLyrics?.trim() || plainFromSynced(best.syncedLyrics ?? ""),
        synced: best.syncedLyrics?.trim() || undefined,
      };
    }
  }
  return null;
}

/**
 * Timing straight from LRCLIB's synced lyrics (one timestamp per line), for when Whisper can't
 * place the words. Words in a line are spread from its timestamp. All of it is `est`: a music
 * video with a longer intro than the album version shifts every line.
 */
export function alignFromSynced(synced: string): Alignment {
  const lines: { t: number; text: string }[] = [];
  for (const raw of synced.split(/\r?\n/)) {
    const m = raw.match(/^\s*\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/);
    if (m) lines.push({ t: +m[1] * 60 + +m[2], text: m[3].trim() });
  }
  const words: TimedWord[] = [];
  lines.forEach((l, li) => {
    const parts = l.text.split(/\s+/).filter((w) => normalizeToken(w));
    if (!parts.length) return;
    const next = lines.slice(li + 1).find((x) => x.text)?.t ?? l.t + parts.length * 0.45;
    const per = Math.min(0.45, Math.max(0.15, (next - l.t) / parts.length));
    parts.forEach((text, k) => words.push({ text, line: li, start: l.t + k * per, end: l.t + (k + 1) * per, est: true }));
  });
  return { words, coverage: 0, density: 0, usable: words.length > 0 };
}

// ---- alignment -------------------------------------------------------------------

function tokensOf(text: string, dict: Dictionary): string[] {
  const n = normalizeToken(text);
  if (!n) return [];
  return (dict.contractions[n] ?? n).split(" ").map((p) => dict.aliases[p] ?? p);
}

const skeleton = (s: string) => s.replace(/[aeiouy]/g, "").replace(/(.)\1+/g, "$1");

/** 0..1 how alike two tokens look. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const sq = (s: string) => s.replace(/(.)\1+/g, "$1");
  if (sq(a) === sq(b)) return 0.9;
  let s = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  if (a.length >= 3 && b.length >= 3 && skeleton(a) === skeleton(b)) s = Math.max(s, 0.7);
  // Same stem: "risky" / "riskier", "money" / "moneys".
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  if (p >= 4 && p >= 0.75 * Math.min(a.length, b.length)) s = Math.max(s, 0.7);
  return s;
}

const GOOD = 0.6; // at or above: Whisper heard this token (near-)correctly
const GAP_LYRIC = -1.2; // a lyric token Whisper didn't produce
const GAP_WHISPER = -0.7; // a Whisper token not in the lyrics (ad-lib, hallucination)
const pairScore = (s: number) => (s >= 0.8 ? 3 : s >= GOOD ? 1.5 : -1);

export function alignLyrics(plain: string, words: Word[], dict: Dictionary = loadDictionary()): Alignment {
  // Lyric side: surface words (kept for display) -> tokens.
  const surface: { text: string; line: number }[] = [];
  const L: { tok: string; si: number }[] = [];
  plain.split(/\r?\n/).forEach((rawLine, line) => {
    if (/^\s*\[[^\]]*\]\s*$/.test(rawLine)) return; // [Chorus], [Verse 1: …]
    for (const w of rawLine.split(/\s+/)) {
      const toks = tokensOf(w, dict);
      if (!toks.length) continue;
      const si = surface.push({ text: w, line }) - 1;
      for (const tok of toks) L.push({ tok, si });
    }
  });

  // Whisper side: tokens with times (a word that expands to 2 tokens splits its time).
  const W: { tok: string; start: number; end: number }[] = [];
  for (const w of words) {
    const toks = tokensOf(w.text, dict);
    const step = (w.end - w.start) / Math.max(1, toks.length);
    toks.forEach((tok, k) => W.push({ tok, start: w.start + k * step, end: w.start + (k + 1) * step }));
  }

  const m = L.length, n = W.length;
  if (m === 0 || n === 0) return { words: [], coverage: 0, density: 0, usable: false };

  // Fill. Leading and trailing Whisper tokens are free (intros, skits, outros).
  const cols = n + 1;
  const trace = new Uint8Array((m + 1) * cols); // 0 diag, 1 skip lyric, 2 skip whisper
  let prev = new Float32Array(cols);
  let cur = new Float32Array(cols);
  for (let i = 1; i <= m; i++) {
    cur[0] = i * GAP_LYRIC;
    trace[i * cols] = 1;
    const a = L[i - 1].tok;
    for (let j = 1; j <= n; j++) {
      const diag = prev[j - 1] + pairScore(similarity(a, W[j - 1].tok));
      const up = prev[j] + GAP_LYRIC;
      const left = cur[j - 1] + (i === m ? 0 : GAP_WHISPER);
      if (diag >= up && diag >= left) { cur[j] = diag; trace[i * cols + j] = 0; }
      else if (up >= left) { cur[j] = up; trace[i * cols + j] = 1; }
      else { cur[j] = left; trace[i * cols + j] = 2; }
    }
    [prev, cur] = [cur, prev];
  }
  for (let j = 1; j <= n; j++) trace[j] = 2; // row 0: leading Whisper tokens are free

  // Trace back: which Whisper token each lyric token sits on.
  const pair = new Int32Array(m).fill(-1);
  const sim = new Float32Array(m);
  for (let i = m, j = n; i > 0; ) {
    const t = j === 0 ? 1 : trace[i * cols + j];
    if (t === 0) { pair[i - 1] = j - 1; sim[i - 1] = similarity(L[i - 1].tok, W[j - 1].tok); i--; j--; }
    else if (t === 1) i--;
    else j--;
  }

  // Times for paired tokens; interpolate the runs in between.
  const start = new Float64Array(m), end = new Float64Array(m);
  const est = new Uint8Array(m);
  for (let i = 0; i < m; i++) {
    if (pair[i] >= 0) {
      start[i] = W[pair[i]].start;
      end[i] = W[pair[i]].end;
      est[i] = sim[i] >= GOOD ? 0 : 1;
    }
  }
  const PER = 0.35; // seconds per token when there is nothing to go on
  for (let i = 0; i < m; ) {
    if (pair[i] >= 0) { i++; continue; }
    let k = i;
    while (k < m && pair[k] < 0) k++;
    const count = k - i;
    const before = i > 0 ? end[i - 1] : null;
    const after = k < m ? start[k] : null;
    let from: number, per: number;
    if (before !== null && after !== null) {
      const span = Math.max(0, after - before);
      per = Math.min(span / count, 0.45);
      from = before;
    } else if (before !== null) {
      per = PER;
      from = before;
    } else {
      per = PER;
      from = Math.max(0, (after ?? 0) - count * PER);
    }
    for (let x = 0; x < count; x++) {
      start[i + x] = from + x * per;
      end[i + x] = from + (x + 1) * per;
      est[i + x] = 1;
    }
    i = k;
  }

  // Back to surface words.
  const out: TimedWord[] = surface.map((s) => ({ text: s.text, line: s.line, start: Infinity, end: 0, est: false }));
  L.forEach((t, i) => {
    const o = out[t.si];
    o.start = Math.min(o.start, start[i]);
    o.end = Math.max(o.end, end[i]);
    if (est[i]) o.est = true;
  });
  for (const o of out) {
    o.start = Math.round(o.start * 1000) / 1000;
    o.end = Math.round(Math.max(o.end, o.start + 0.05) * 1000) / 1000;
  }

  const fit = fitStats(L.map((t) => t.tok), W.map((t) => t.tok), pair, sim);
  return {
    words: out,
    coverage: Math.round(fit.coverage * 100) / 100,
    density: Math.round(fit.density * 100) / 100,
    usable: fit.content >= 4 && fit.coverage >= MIN_COVERAGE && fit.density >= MIN_DENSITY,
  };
}

// Short common words ("I", "you", "the") line up with almost anything, so the fit check
// only counts content words.
const STOP = new Set(
  "the and you your are for but not that this with was what all can get got its into when then than there their them they she her his him our out who why how too yes yeah ooh".split(" "),
);
const isContent = (t: string) => t.length >= 3 && !STOP.has(t);

export const MIN_COVERAGE = 0.2; // share of the lyrics' content words Whisper heard
export const MIN_DENSITY = 0.2; // share of Whisper's content words, over the stretch the lyrics cover, that they explain

/**
 * coverage: of the lyrics' content words, how many Whisper heard (near-)correctly.
 * density: over the stretch of the transcript those matches span, how many of Whisper's content
 *   words they account for. Wrong lyrics can pick up scattered matches (high-ish coverage for a
 *   short paste) but never densely; right lyrics, even a chorus only, match densely.
 */
function fitStats(lt: string[], wt: string[], pair: Int32Array, sim: Float32Array) {
  let content = 0, good = 0, first = Infinity, last = -1;
  for (let i = 0; i < lt.length; i++) {
    if (!isContent(lt[i])) continue;
    content++;
    if (pair[i] >= 0 && sim[i] >= GOOD) {
      good++;
      first = Math.min(first, pair[i]);
      last = Math.max(last, pair[i]);
    }
  }
  let span = 0;
  for (let j = first; j <= last; j++) if (isContent(wt[j])) span++;
  return { content, coverage: content ? good / content : 0, density: span ? good / span : 0 };
}
