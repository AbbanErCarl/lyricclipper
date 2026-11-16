import fs from "node:fs";
import { config } from "./config.js";
import { run } from "./proc.js";

export interface Word {
  text: string;
  start: number; // seconds
  end: number; // seconds
}

const LINE = /^\[(\d{2}):(\d{2}):(\d{2})[.,](\d{3}) --> (\d{2}):(\d{2}):(\d{2})[.,](\d{3})\]\s*(.*)$/;

const secs = (h: string, m: string, s: string, ms: string) => +h * 3600 + +m * 60 + +s + +ms / 1000;

/**
 * Parse one whisper-cli output line. With --max-len 1 --split-on-word each line is one word:
 * "[00:01:02.340 --> 00:01:02.700]   body"
 * Returns null for non-timestamp lines and for non-lyric tokens like "[Music]" or "(applause)".
 */
export function parseLine(line: string): Word | null {
  const m = LINE.exec(line.trim());
  if (!m) return null;
  const text = m[9].trim();
  if (!text) return null;
  if (/^[[(*♪].*[\])*♪]$/.test(text)) return null; // [Music], (laughs), *music*, ♪
  if (!/[\p{L}\p{N}]/u.test(text)) return null; // punctuation only
  return { text, start: secs(m[1], m[2], m[3], m[4]), end: secs(m[5], m[6], m[7], m[8]) };
}

export interface WhisperOverride {
  model?: string;
  threads?: number;
  vad?: boolean;
  /** Text Whisper reads before every 30 s window: biases it toward these words. */
  prompt?: string;
}

export function whisperArgs(wavPath: string, quick: boolean, o: WhisperOverride = {}): string[] {
  const w = config.whisper;
  const model = o.model ?? (quick && w.quickModel && fs.existsSync(w.quickModel) ? w.quickModel : w.model);
  const args = [
    "-m", model,
    "-f", wavPath,
    "-l", w.language,
    "-t", String(o.threads ?? w.threads),
    // Greedy decoding instead of beam search 5: the biggest speed win on CPU.
    "-bs", "1",
    "-bo", "1",
    // One word per output line, with its own timestamps.
    "-ml", "1",
    "-sow",
    // Never write [MUSIC], (applause), ♪ and the like. On songs Whisper otherwise tends to label
    // a whole 30 s window [MUSIC] and skip to the next one without writing a single word.
    "-sns",
  ];
  if (o.prompt) args.push("--prompt", o.prompt, "--carry-initial-prompt");
  if ((o.vad ?? w.useVad) && w.vadModel && fs.existsSync(w.vadModel)) {
    // Skips instrumental stretches; whisper.cpp maps timestamps back to the original audio.
    args.push("--vad", "-vm", w.vadModel);
  }
  return [...args, ...w.extraArgs];
}

export function vadAvailable(): boolean {
  const w = config.whisper;
  return Boolean(w.useVad && w.vadModel && fs.existsSync(w.vadModel));
}

/** Transcribe a 16 kHz mono WAV, calling onWord for each word as soon as whisper prints it. */
export async function transcribe(
  wavPath: string,
  quick: boolean,
  onWord: (w: Word) => void,
  opts: { vad?: boolean; prompt?: string; logFile?: string } = {},
): Promise<void> {
  if (!fs.existsSync(config.whisper.model)) {
    throw new Error(`Whisper model not found at ${config.whisper.model}. Run scripts/setup.ps1.`);
  }
  await run(config.tools.whisper, whisperArgs(wavPath, quick, { vad: opts.vad, prompt: opts.prompt }), {
    logFile: opts.logFile,
    onLine: (line) => {
      const w = parseLine(line);
      if (w) onWord(w);
    },
  });
}

/**
 * A short prompt from the lyrics: the first appearance of each line, in order, about 80 words.
 * Whisper reads it before every window, which pulls it toward the song's real vocabulary
 * (names, Pidgin, Patois) instead of "[MUSIC]" or look-alike English.
 */
export function promptFromLyrics(plain: string, maxWords = 80): string {
  const seen = new Set<string>();
  const out: string[] = [];
  let count = 0;
  for (const raw of plain.split(/\r?\n/)) {
    const line = raw.replace(/\[[^\]]*\]/g, "").replace(/\s+/g, " ").trim();
    const key = line.toLowerCase();
    if (!line || seen.has(key)) continue;
    seen.add(key);
    const words = line.split(" ");
    if (count + words.length > maxWords) break;
    out.push(line);
    count += words.length;
  }
  return out.join(". ");
}
