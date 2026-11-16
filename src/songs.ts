import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { run } from "./proc.js";
import { alignFromSynced, alignLyrics, cleanTitle, fetchLyrics, type Alignment, type LyricsInfo } from "./lyrics.js";
import { findMatches } from "./search.js";
import { promptFromLyrics, transcribe, vadAvailable, type Word } from "./whisper.js";

export type Status = "queued" | "downloading" | "converting" | "transcribing" | "ready" | "error";

export interface SongMeta {
  key: string;
  title: string; // cleaned for display
  artist: string;
  rawTitle?: string; // as the site or file name gave it
  rawArtist?: string; // song metadata, or just the uploader's name
  artistIsReal?: boolean; // rawArtist came from song metadata, not the uploader
  duration: number; // seconds, 0 until known
  source: "url" | "file";
  url?: string;
  audioFile?: string; // file name inside the song folder
  status: Status;
  transcribedTo: number; // seconds of audio transcribed so far
  wordCount?: number;
  quick: boolean; // transcribed with the faster, less accurate model
  error?: string;
  lyrics?: LyricsState;
  createdAt: number;
  lastUsedAt: number;
}

export interface LyricsState {
  status: "searching" | "found" | "none" | "error";
  source?: "lrclib" | "pasted";
  trackName?: string;
  artistName?: string;
  coverage?: number; // share of lyric words Whisper heard, once aligned
  usable?: boolean; // lyrics line up with this recording
  forced?: boolean;
  timing?: "whisper" | "synced"; // where the lyric timings came from
  error?: string;
}

interface Song {
  meta: SongMeta;
  words: Word[];
  events: EventEmitter;
  busy: boolean;
  lyrics?: LyricsInfo;
  aligned?: Alignment;
  lyricsBusy?: boolean;
}

export const KEY_RE = /^[a-z0-9]+-[A-Za-z0-9_-]{4,64}$/;
const songs = new Map<string, Song>();

const dirOf = (key: string) => path.join(config.cacheDir, key);
const metaPath = (key: string) => path.join(dirOf(key), "meta.json");
const wordsPath = (key: string) => path.join(dirOf(key), "words.json");
const lyricsPath = (key: string) => path.join(dirOf(key), "lyrics.json");

function save(song: Song) {
  fs.writeFileSync(metaPath(song.meta.key), JSON.stringify(song.meta, null, 2));
}

function setState(song: Song, patch: Partial<SongMeta>) {
  Object.assign(song.meta, patch);
  save(song);
  song.events.emit("state", song.meta);
}

/** Load a song from memory or from its cache folder. */
export function getSong(key: string): Song | undefined {
  if (!KEY_RE.test(key)) return undefined;
  const cached = songs.get(key);
  if (cached) return cached;
  if (!fs.existsSync(metaPath(key))) return undefined;
  const meta = JSON.parse(fs.readFileSync(metaPath(key), "utf8")) as SongMeta;
  const words = fs.existsSync(wordsPath(key)) ? (JSON.parse(fs.readFileSync(wordsPath(key), "utf8")) as Word[]) : [];
  // A song left half-done by a restart is shown as an error the user can retry.
  if (meta.status !== "ready" && meta.status !== "error") {
    meta.status = "error";
    meta.error = "Interrupted. Press Retry.";
  }
  meta.wordCount = words.length;
  if (!meta.rawTitle) Object.assign(meta, { rawTitle: meta.title, rawArtist: meta.artist }); // older songs
  Object.assign(meta, titleFields(meta.rawTitle!, meta.rawArtist ?? "", meta.artistIsReal));
  if (meta.lyrics?.status === "searching") meta.lyrics = undefined; // interrupted lookup: try again
  const song: Song = { meta, words, events: new EventEmitter(), busy: false };
  if (fs.existsSync(lyricsPath(key))) song.lyrics = JSON.parse(fs.readFileSync(lyricsPath(key), "utf8")) as LyricsInfo;
  realign(song);
  song.events.setMaxListeners(50);
  songs.set(key, song);
  return song;
}

/** Display title/artist from the raw ones, keeping the raw ones for lyrics searches. */
function titleFields(rawTitle: string, rawArtist: string, artistIsReal = false) {
  const c = cleanTitle(rawTitle, rawArtist, artistIsReal);
  return { title: c.title, artist: c.artist, rawTitle, rawArtist, artistIsReal };
}

function createSong(key: string, init: Partial<SongMeta>): Song {
  fs.mkdirSync(dirOf(key), { recursive: true });
  const now = Date.now();
  const meta: SongMeta = {
    key,
    title: "Fetching…",
    artist: "",
    duration: 0,
    source: "url",
    status: "queued",
    transcribedTo: 0,
    quick: false,
    createdAt: now,
    lastUsedAt: now,
    ...init,
  };
  const song: Song = { meta, words: [], events: new EventEmitter(), busy: false };
  song.events.setMaxListeners(50);
  songs.set(key, song);
  save(song);
  return song;
}

export function listRecent(limit = 12): SongMeta[] {
  const out: SongMeta[] = [];
  for (const name of fs.readdirSync(config.cacheDir)) {
    const s = getSong(name);
    if (s) out.push(s.meta);
  }
  return out.sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, limit);
}

export function touch(song: Song) {
  song.meta.lastUsedAt = Date.now();
  save(song);
}

// ---- keys ---------------------------------------------------------------

const YT_ID = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

export function keyForUrl(url: string): string {
  const yt = YT_ID.exec(url);
  if (yt) return `youtube-${yt[1]}`;
  return `url-${crypto.createHash("sha1").update(url.trim()).digest("hex").slice(0, 16)}`;
}

// ---- one job at a time: transcription already uses every CPU core ----------

let chain: Promise<void> = Promise.resolve();
function enqueue(song: Song, job: () => Promise<void>) {
  song.busy = true;
  chain = chain
    .then(job)
    .catch((e: Error) => setState(song, { status: "error", error: e.message }))
    .finally(() => {
      song.busy = false;
    });
}

// ---- pipeline -----------------------------------------------------------

function findAudioFile(key: string): string | undefined {
  return fs
    .readdirSync(dirOf(key))
    .find((f) => f.startsWith("audio.") && !f.endsWith(".json") && !f.endsWith(".part") && !f.endsWith(".ytdl"));
}

async function download(song: Song) {
  setState(song, { status: "downloading", error: undefined });
  const dir = dirOf(song.meta.key);
  const args = [
    song.meta.url!,
    "--no-playlist",
    "--no-progress",
    "-f", "bestaudio[ext=m4a]/bestaudio/best",
    "-o", path.join(dir, "audio.%(ext)s"),
    "--write-info-json",
  ];
  if (path.isAbsolute(config.tools.ffmpeg)) args.push("--ffmpeg-location", path.dirname(config.tools.ffmpeg));
  await run(config.tools.ytdlp, args);
  const audioFile = findAudioFile(song.meta.key);
  if (!audioFile) throw new Error("Download finished but no audio file was found.");
  const infoPath = path.join(dir, "audio.info.json");
  const info = fs.existsSync(infoPath) ? JSON.parse(fs.readFileSync(infoPath, "utf8")) : {};
  const uploader = String(info.channel ?? info.uploader ?? "").replace(/ - Topic$/, "");
  setState(song, {
    audioFile,
    ...titleFields(
      String(info.track ?? info.title ?? "Unknown title"),
      String(info.artist ?? info.creator ?? uploader),
      Boolean(info.artist ?? info.creator),
    ),
    duration: Number(info.duration) || (await probeDuration(path.join(dir, audioFile))),
  });
  if (fs.existsSync(infoPath)) fs.rmSync(infoPath); // it can be several MB
  void ensureLyrics(song); // look the lyrics up while Whisper works
}

export async function probeDuration(file: string): Promise<number> {
  const out = await run(config.tools.ffprobe, [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file,
  ]);
  return Number(out.trim()) || 0;
}

async function transcribeSong(song: Song) {
  const dir = dirOf(song.meta.key);
  const wav = path.join(dir, "whisper.wav");
  setState(song, { status: "converting" });
  await run(config.tools.ffmpeg, [
    "-y", "-v", "error", "-i", path.join(dir, song.meta.audioFile!), "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav,
  ]);
  const logFile = path.join(dir, "whisper.log");
  const pass = async (vad: boolean, prompt?: string) => {
    song.words = [];
    setState(song, { status: "transcribing", transcribedTo: 0, wordCount: 0 });
    song.events.emit("reset");
    let lastSave = 0;
    await transcribe(
      wav,
      song.meta.quick,
      (w) => {
        song.words.push(w);
        song.meta.transcribedTo = w.end;
        song.meta.wordCount = song.words.length;
        song.events.emit("word", w);
        if (w.end - lastSave > 15) {
          lastSave = w.end;
          setState(song, {}); // persist progress now and then
        }
      },
      { vad, prompt, logFile },
    );
  };
  // Even slow songs have ~30 words a minute; well under that means Whisper mostly heard "music".
  const tooFew = () => song.words.length < Math.max(10, (song.meta.duration / 60) * 20);
  const keepLog = (name: string) => fs.existsSync(logFile) && fs.renameSync(logFile, path.join(dir, name));
  try {
    const useVad = vadAvailable();
    await pass(useVad);
    // Voice detection is trained on speech and can throw away sung vocals over a loud beat.
    if (useVad && tooFew()) {
      keepLog("whisper-vad.log");
      await pass(false);
    }
    // Still too little: give Whisper the lyrics as a prompt, and keep whichever pass heard more.
    if (tooFew() && song.lyrics?.plain) {
      const first = song.words;
      keepLog("whisper-noprompt.log");
      await pass(false, promptFromLyrics(song.lyrics.plain));
      if (song.words.length < first.length) song.words = first;
    }
  } finally {
    fs.rmSync(wav, { force: true });
  }
  fs.writeFileSync(wordsPath(song.meta.key), JSON.stringify(song.words));
  realign(song);
  if (song.words.length === 0 && !song.aligned?.usable) {
    throw new Error(
      song.lyrics
        ? "Whisper only heard music, even with the lyrics as a hint. Select the part by hand on the waveform."
        : "Whisper only heard music. Add the lyrics (Change lyrics), then press Retry: Whisper uses them as a hint.",
    );
  }
  setState(song, { status: "ready", transcribedTo: song.meta.duration, wordCount: song.words.length });
  song.events.emit("lyrics", lyricsPayload(song));
}

// ---- lyrics -----------------------------------------------------------------

/**
 * Give the lyrics times: line them up with Whisper's words when it heard enough; otherwise fall
 * back to LRCLIB's synced line times (if it has them).
 */
function realign(song: Song) {
  if (!song.lyrics) {
    song.aligned = undefined;
    return;
  }
  let a: Alignment | undefined;
  let timing: "whisper" | "synced" | undefined;
  if (song.words.length) {
    a = alignLyrics(song.lyrics.plain, song.words);
    if (song.lyrics.forced) a.usable = true;
    if (a.usable) timing = "whisper";
  }
  if (!a?.usable && song.lyrics.synced) {
    const coverage = a?.coverage;
    a = alignFromSynced(song.lyrics.synced);
    if (coverage !== undefined) a.coverage = coverage;
    timing = a.usable ? "synced" : undefined;
  }
  song.aligned = a;
  if (song.meta.lyrics) {
    song.meta.lyrics = { ...song.meta.lyrics, coverage: song.words.length ? a?.coverage : undefined, usable: a?.usable, timing };
  }
}

export function lyricsPayload(song: Song) {
  return {
    meta: song.meta.lyrics ?? null,
    words: song.aligned?.usable ? song.aligned.words : [],
  };
}

export function lyricsText(song: Song): string {
  return song.lyrics?.plain ?? "";
}

function setLyricsState(song: Song, state: LyricsState) {
  song.meta.lyrics = state;
  realign(song);
  // A song that failed only because Whisper heard nothing becomes usable once lyrics carry timings.
  if (song.meta.status === "error" && !song.busy && song.meta.audioFile && song.aligned?.usable) {
    Object.assign(song.meta, { status: "ready", error: undefined });
  }
  save(song);
  song.events.emit("state", song.meta);
  song.events.emit("lyrics", lyricsPayload(song));
}

function applyLyrics(song: Song, info: LyricsInfo) {
  song.lyrics = info;
  fs.writeFileSync(lyricsPath(song.meta.key), JSON.stringify(info, null, 2));
  setLyricsState(song, { status: "found", source: info.source, trackName: info.trackName, artistName: info.artistName, forced: info.forced });
}

/** Use the current lyrics even though the fit check rejected them. */
export function forceLyrics(song: Song) {
  if (song.lyrics) applyLyrics(song, { ...song.lyrics, forced: true });
}

/** Look the song up on LRCLIB (or with a custom query). Runs beside the job queue: network only. */
export async function ensureLyrics(song: Song, query?: string, force = false): Promise<void> {
  if (song.lyricsBusy) return;
  if (!force && song.meta.lyrics && song.meta.lyrics.status !== "error") return;
  if (!force && song.lyrics) return;
  song.lyricsBusy = true;
  setLyricsState(song, { status: "searching" });
  try {
    const m = song.meta;
    const info = await fetchLyrics(m.rawTitle ?? m.title, m.rawArtist ?? m.artist, m.duration, query, m.artistIsReal);
    if (info && info.plain) applyLyrics(song, info);
    else setLyricsState(song, { status: "none" });
  } catch (e) {
    setLyricsState(song, { status: "error", error: (e as Error).message });
  } finally {
    song.lyricsBusy = false;
  }
}

export function setPastedLyrics(song: Song, text: string) {
  const plain = text.replace(/\r\n/g, "\n").trim();
  if (!plain) {
    song.lyrics = undefined;
    fs.rmSync(lyricsPath(song.meta.key), { force: true });
    setLyricsState(song, { status: "none" });
    return;
  }
  applyLyrics(song, { source: "pasted", plain });
}

/** Search the aligned lyrics when they line up with the recording; otherwise Whisper's words. */
export function searchSong(song: Song, query: string) {
  if (song.aligned?.usable) {
    const words = song.aligned.words;
    const hits = findMatches(words, query).map((h) => ({
      ...h,
      source: "lyrics" as const,
      // The clip's edges come from the first and last word; a guessed word in the middle doesn't move them.
      est: words[h.startWord].est || words[h.endWord].est,
    }));
    if (hits.length) return hits;
  }
  return findMatches(song.words, query).map((h) => ({ ...h, source: "whisper" as const, est: false }));
}

/** Start (or resume) preparing a song from a URL. Returns immediately. */
export function addFromUrl(url: string, quick: boolean): SongMeta {
  const key = keyForUrl(url);
  const existing = getSong(key);
  if (existing) {
    touch(existing);
    if (existing.meta.status === "error" && !existing.busy) retry(existing.meta.key, quick);
    return existing.meta;
  }
  const song = createSong(key, { source: "url", url, quick });
  enqueue(song, async () => {
    await download(song);
    await transcribeSong(song);
  });
  return song.meta;
}

/** Add an audio file the user dropped in. */
export function addFromFile(fileName: string, data: Buffer, quick: boolean): SongMeta {
  const key = `file-${crypto.createHash("sha1").update(data).digest("hex").slice(0, 16)}`;
  const existing = getSong(key);
  if (existing) {
    touch(existing);
    return existing.meta;
  }
  const ext = (path.extname(fileName).toLowerCase().replace(/[^.a-z0-9]/g, "") || ".mp3").slice(0, 6);
  const base = path.basename(fileName, path.extname(fileName));
  const [artist, title] = base.includes(" - ") ? base.split(" - ", 2) : ["", base];
  const song = createSong(key, { source: "file", ...titleFields(title.trim(), artist.trim(), Boolean(artist.trim())), quick, audioFile: `audio${ext}` });
  const file = path.join(dirOf(key), `audio${ext}`);
  fs.writeFileSync(file, data);
  // Length first (LRCLIB picks the version by duration), then lyrics, beside the transcription queue.
  const probed = probeDuration(file).then((duration) => setState(song, { duration }));
  void probed.then(() => ensureLyrics(song)).catch(() => ensureLyrics(song));
  enqueue(song, async () => {
    await probed;
    await transcribeSong(song);
  });
  return song.meta;
}

/** Redo a failed song, or re-transcribe a ready one with the other model. */
export function retry(key: string, quick?: boolean): SongMeta | undefined {
  const song = getSong(key);
  if (!song || song.busy) return song?.meta;
  if (quick !== undefined) song.meta.quick = quick;
  setState(song, { status: "queued", error: undefined });
  enqueue(song, async () => {
    if (!song.meta.audioFile || !findAudioFile(key)) await download(song);
    await transcribeSong(song);
  });
  return song.meta;
}

export function audioPath(key: string): string | undefined {
  const s = getSong(key);
  return s?.meta.audioFile ? path.join(dirOf(key), s.meta.audioFile) : undefined;
}

// ---- export ---------------------------------------------------------------

const safeName = (s: string) =>
  s.replace(/[\\/:*?"<>|\x00-\x1f]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "clip";

export async function exportClip(key: string, start: number, end: number, format: "ogg" | "mp3", label: string) {
  const song = getSong(key);
  const src = audioPath(key);
  if (!song || !src) throw new Error("Song not found.");
  const len = end - start;
  if (!(start >= 0) || !(len >= 0.5) || len > 60) throw new Error("Clip must be between 0.5 and 60 seconds.");
  const fadeOut = Math.min(0.15, len / 4);
  const name = `${safeName([song.meta.artist, label].filter(Boolean).join(" - "))} ${Date.now().toString(36)}.${format}`;
  const out = path.join(config.exportsDir, name);
  const codec =
    format === "ogg"
      ? ["-c:a", "libopus", "-b:a", "96k", "-ar", "48000"]
      : ["-c:a", "libmp3lame", "-q:a", "2", "-ar", "44100"];
  await run(config.tools.ffmpeg, [
    "-y", "-v", "error",
    "-ss", start.toFixed(3), "-i", src, "-t", len.toFixed(3),
    "-vn", "-af", `afade=t=in:d=0.05,afade=t=out:st=${(len - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`,
    ...codec, out,
  ]);
  touch(song);
  return name;
}

export function subscribe(key: string) {
  return getSong(key);
}
