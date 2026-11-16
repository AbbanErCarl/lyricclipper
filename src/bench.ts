/**
 * M0 benchmark: how fast is each model/thread setting on this laptop, and do the words line up?
 *   npm run bench -- "C:\Music\Davido - Risky.mp3" "your body risky"
 * Prints one row per setting, then the hits each setting found so you can check them by ear.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { run } from "./proc.js";
import { findMatches } from "./search.js";
import { probeDuration } from "./songs.js";
import { parseLine, whisperArgs, type Word, type WhisperOverride } from "./whisper.js";

const [file, phrase = ""] = process.argv.slice(2);
if (!file || !fs.existsSync(file)) {
  console.error('Usage: npm run bench -- <audio file> ["phrase to look for"]');
  process.exit(1);
}

const w = config.whisper;
const variants: (WhisperOverride & { name: string })[] = [
  { name: "small, 4 threads, VAD", model: w.model, threads: 4, vad: true },
  { name: "small, 8 threads, VAD", model: w.model, threads: 8, vad: true },
  { name: "small, 4 threads, no VAD", model: w.model, threads: 4, vad: false },
  ...(w.quickModel && fs.existsSync(w.quickModel)
    ? [
        { name: "base, 4 threads, VAD", model: w.quickModel, threads: 4, vad: true },
        { name: "base, 8 threads, VAD", model: w.quickModel, threads: 8, vad: true },
      ]
    : []),
];

const wav = path.join(os.tmpdir(), `lyricclipper-bench-${process.pid}.wav`);
await run(config.tools.ffmpeg, ["-y", "-v", "error", "-i", file, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
const duration = await probeDuration(file);
console.log(`Song: ${path.basename(file)} (${duration.toFixed(0)} s). ${variants.length} runs; this can take several minutes.\n`);

const results: { name: string; secs: number; words: Word[] }[] = [];
for (const v of variants) {
  process.stdout.write(`${v.name.padEnd(26)} … `);
  const words: Word[] = [];
  const t0 = performance.now();
  let first = 0;
  await run(config.tools.whisper, whisperArgs(wav, false, v), {
    onLine: (l) => {
      const word = parseLine(l);
      if (!word) return;
      if (!first) first = (performance.now() - t0) / 1000;
      words.push(word);
    },
  });
  const secs = (performance.now() - t0) / 1000;
  results.push({ name: v.name, secs, words });
  console.log(
    `${secs.toFixed(1).padStart(6)} s total · first word after ${first.toFixed(1)} s · ` +
      `${(duration / secs).toFixed(1)}× real time · ${words.length} words`,
  );
}
fs.rmSync(wav, { force: true });

if (phrase) {
  console.log(`\nHits for "${phrase}" (check each start time by ear in any player):`);
  for (const r of results) {
    const hits = findMatches(r.words, phrase);
    const list = hits.map((h) => `${h.start.toFixed(2)}s${h.exact ? "" : "≈"}`).join("  ") || "none";
    console.log(`  ${r.name.padEnd(26)} ${list}`);
  }
}
console.log("\nPick the fastest setting whose hits are right, then set model/threads/useVad in config.json.");
