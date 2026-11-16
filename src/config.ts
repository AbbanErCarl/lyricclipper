import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface RawConfig {
  port: number;
  host: string;
  cacheDir: string;
  exportsDir: string;
  tools: { ytdlp: string; ffmpeg: string; ffprobe: string; whisper: string };
  whisper: {
    model: string;
    quickModel?: string;
    vadModel?: string;
    useVad: boolean;
    threads: number;
    language: string;
    extraArgs: string[];
  };
}

function loadRaw(): RawConfig {
  const own = path.join(ROOT, "config.json");
  const file = fs.existsSync(own) ? own : path.join(ROOT, "config.example.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as RawConfig;
}

const abs = (p: string) => (path.isAbsolute(p) ? p : path.join(ROOT, p));

/** Use the configured binary if it exists; otherwise fall back to the bare name on PATH. */
function tool(configured: string, fallback: string): string {
  const p = abs(configured);
  return fs.existsSync(p) ? p : fallback;
}

const raw = loadRaw();

export const config = {
  port: Number(process.env.PORT ?? raw.port),
  host: process.env.HOST ?? raw.host,
  cacheDir: abs(raw.cacheDir),
  exportsDir: abs(raw.exportsDir),
  tools: {
    ytdlp: tool(raw.tools.ytdlp, "yt-dlp"),
    ffmpeg: tool(raw.tools.ffmpeg, "ffmpeg"),
    ffprobe: tool(raw.tools.ffprobe, "ffprobe"),
    whisper: tool(raw.tools.whisper, "whisper-cli"),
  },
  whisper: {
    ...raw.whisper,
    model: abs(raw.whisper.model),
    quickModel: raw.whisper.quickModel ? abs(raw.whisper.quickModel) : undefined,
    vadModel: raw.whisper.vadModel ? abs(raw.whisper.vadModel) : undefined,
  },
};

fs.mkdirSync(config.cacheDir, { recursive: true });
fs.mkdirSync(config.exportsDir, { recursive: true });

/** Child processes see tools/ first on PATH, so yt-dlp can find deno.exe and ffmpeg. */
export const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: [path.join(ROOT, "tools"), path.join(ROOT, "tools", "ffmpeg"), process.env.PATH ?? ""].join(path.delimiter),
};
