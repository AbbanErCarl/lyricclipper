import express, { type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { config, ROOT } from "./config.js";
import { run } from "./proc.js";
import {
  addFromFile, addFromUrl, audioPath, ensureLyrics, exportClip, getSong, KEY_RE, listRecent, lyricsPayload,
  forceLyrics, lyricsText, retry, searchSong, setPastedLyrics, touch,
} from "./songs.js";
import type { Word } from "./whisper.js";

const app = express();
app.use(express.json());

const fail = (res: Response, code: number, message: string) => res.status(code).json({ error: message });

// ---- YouTube search (via yt-dlp, no API key) -----------------------------------
const searchCache = new Map<string, { at: number; results: unknown[] }>();

app.get("/api/search", async (req, res) => {
  const q = String(req.query.q ?? "").trim().slice(0, 200);
  if (!q) return fail(res, 400, "Type something to search for.");
  const hit = searchCache.get(q);
  if (hit && Date.now() - hit.at < 3_600_000) return res.json(hit.results);
  try {
    const out = await run(config.tools.ytdlp, [`ytsearch10:${q}`, "--flat-playlist", "-J", "--no-warnings"]);
    const data = JSON.parse(out);
    const results = (data.entries ?? []).map((e: any) => ({
      id: e.id,
      title: e.title,
      channel: e.channel ?? e.uploader ?? "",
      duration: e.duration ?? 0,
      url: `https://www.youtube.com/watch?v=${e.id}`,
      thumb: `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`,
    }));
    searchCache.set(q, { at: Date.now(), results });
    res.json(results);
  } catch (e) {
    fail(res, 502, (e as Error).message);
  }
});

// ---- songs -------------------------------------------------------------------------
app.get("/api/songs", (_req, res) => res.json(listRecent()));

app.post("/api/songs", (req, res) => {
  const url = String(req.body?.url ?? "").trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return fail(res, 400, "Paste a full http(s) link.");
  res.json(addFromUrl(url, Boolean(req.body?.quick)));
});

app.post(
  "/api/songs/upload",
  express.raw({ type: "application/octet-stream", limit: "200mb" }),
  (req, res) => {
    const name = decodeURIComponent(String(req.header("x-filename") ?? "upload.mp3"));
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return fail(res, 400, "Empty file.");
    res.json(addFromFile(name, req.body, req.query.quick === "1"));
  },
);

function songOr404(req: Request, res: Response) {
  const key = String(req.params.key);
  const song = KEY_RE.test(key) ? getSong(key) : undefined;
  if (!song) fail(res, 404, "Unknown song.");
  return song;
}

app.get("/api/songs/:key", (req, res) => {
  const song = songOr404(req, res);
  if (!song) return;
  touch(song);
  if (!song.meta.lyrics) void ensureLyrics(song); // songs added before lyrics support
  res.json({ ...song.meta, words: song.words, lyricWords: lyricsPayload(song).words });
});

app.get("/api/songs/:key/lyrics", (req, res) => {
  const song = songOr404(req, res);
  if (!song) return;
  res.json({ ...lyricsPayload(song), text: lyricsText(song) });
});

/** body {text}: use pasted lyrics (empty clears) · {query}: search LRCLIB · {force: true}: use them even if they don't fit */
app.post("/api/songs/:key/lyrics", async (req, res) => {
  const song = songOr404(req, res);
  if (!song) return;
  if (req.body?.force === true) {
    forceLyrics(song);
  } else if (typeof req.body?.text === "string") {
    setPastedLyrics(song, req.body.text.slice(0, 50_000));
  } else {
    const query = String(req.body?.query ?? "").trim().slice(0, 200);
    await ensureLyrics(song, query || undefined, true);
  }
  res.json(lyricsPayload(song));
});

app.post("/api/songs/:key/retry", (req, res) => {
  const song = songOr404(req, res);
  if (!song) return;
  const quick = req.body?.quick;
  res.json(retry(song.meta.key, typeof quick === "boolean" ? quick : undefined));
});

/** Server-Sent Events: current state + words so far, then each new word as whisper prints it. */
app.get("/api/songs/:key/events", (req, res) => {
  const song = songOr404(req, res);
  if (!song) return;
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("state", song.meta);
  send("words", song.words);
  send("lyrics", lyricsPayload(song));
  if (!song.meta.lyrics) void ensureLyrics(song);
  const onState = (m: unknown) => send("state", m);
  const onWord = (w: Word) => send("words", [w]);
  const onReset = () => send("reset", {});
  const onLyrics = (p: unknown) => send("lyrics", p);
  song.events.on("state", onState);
  song.events.on("word", onWord);
  song.events.on("reset", onReset);
  song.events.on("lyrics", onLyrics);
  const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
  req.on("close", () => {
    clearInterval(ping);
    song.events.off("state", onState);
    song.events.off("word", onWord);
    song.events.off("reset", onReset);
    song.events.off("lyrics", onLyrics);
  });
});

app.get("/api/songs/:key/audio", (req, res) => {
  const song = songOr404(req, res);
  if (!song) return;
  const file = audioPath(song.meta.key);
  if (!file || !fs.existsSync(file)) return fail(res, 404, "Audio not downloaded yet.");
  res.sendFile(file); // handles Range requests for seeking
});

app.get("/api/songs/:key/matches", (req, res) => {
  const song = songOr404(req, res);
  if (!song) return;
  res.json(searchSong(song, String(req.query.q ?? "")));
});

// ---- clips -------------------------------------------------------------------------
app.post("/api/clips", async (req, res) => {
  const { key, start, end, format, label } = req.body ?? {};
  if (!KEY_RE.test(String(key))) return fail(res, 400, "Bad song key.");
  if (format !== "ogg" && format !== "mp3") return fail(res, 400, "Format must be ogg or mp3.");
  try {
    const name = await exportClip(String(key), Number(start), Number(end), format, String(label ?? "").slice(0, 60));
    res.json({ name, url: `/exports/${encodeURIComponent(name)}` });
  } catch (e) {
    fail(res, 400, (e as Error).message);
  }
});

app.use("/exports", express.static(config.exportsDir, { setHeaders: (r) => r.setHeader("Content-Disposition", "attachment") }));

// ---- tools -------------------------------------------------------------------------
app.get("/api/health", async (_req, res) => {
  const version = async (cmd: string, args: string[]) => {
    try {
      return (await run(cmd, args)).split(/\r?\n/)[0].trim();
    } catch (e) {
      return `MISSING (${(e as Error).message.slice(0, 120)})`;
    }
  };
  res.json({
    ytdlp: await version(config.tools.ytdlp, ["--version"]),
    ffmpeg: await version(config.tools.ffmpeg, ["-version"]),
    whisper: fs.existsSync(config.tools.whisper) || config.tools.whisper === "whisper-cli" ? config.tools.whisper : "MISSING",
    model: fs.existsSync(config.whisper.model) ? path.basename(config.whisper.model) : "MISSING",
    quickModel: config.whisper.quickModel && fs.existsSync(config.whisper.quickModel) ? path.basename(config.whisper.quickModel) : "none",
    vad: config.whisper.useVad && config.whisper.vadModel && fs.existsSync(config.whisper.vadModel) ? "on" : "off",
    threads: config.whisper.threads,
  });
});

app.post("/api/tools/update-ytdlp", async (_req, res) => {
  try {
    res.json({ output: await run(config.tools.ytdlp, ["-U"]) });
  } catch (e) {
    fail(res, 500, (e as Error).message);
  }
});

// ---- page --------------------------------------------------------------------------
app.use("/vendor/wavesurfer", express.static(path.join(ROOT, "node_modules", "wavesurfer.js", "dist")));
app.use(express.static(path.join(ROOT, "public")));

app.listen(config.port, config.host, () => {
  console.log(`Lyric Clipper running at http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}`);
});
