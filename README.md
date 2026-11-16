# Lyric Clipper

Pick a song, type the words, get the clip. A personal tool that runs on your laptop: it downloads the song, transcribes it with Whisper (word-level timestamps), finds your phrase, and exports just that part as `.ogg` or `.mp3`.

## Setup (Windows, once)

Needs Node.js 20 or newer.

```powershell
cd lyricclipper
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1   # ~500 MB download of tools and models into tools\
npm install
```

`setup.ps1` downloads yt-dlp, deno (yt-dlp needs it for YouTube), ffmpeg, whisper.cpp, the `small` and `base` models (quantised q5_1) and the Silero voice-detection model. It also creates `config.json`.

## M0: pick the fastest setting for this laptop (≈10 min)

```powershell
npm run bench -- "C:\path\to\Davido - Risky.mp3" "your body risky"
```

The benchmark runs each model/thread setting on the song, prints time, real-time speed and word count, then where each setting found the phrase. Check those times by ear in any player. Put the fastest setting that is still right into `config.json` (`whisper.model`, `whisper.threads`, `whisper.useVad`).

No audio file yet? Start the app (below), add a YouTube link, and use the file from `cache\<song>\audio.*` once it has downloaded.

## Run

```powershell
npm start
```

Open http://127.0.0.1:4321.

1. **Find the song.** Search YouTube, paste a link (YouTube, Audiomack or any site yt-dlp supports), or drop in an audio file.
2. **Wait for the words.** The song downloads, then transcribes. Words appear as they are found, so a phrase early in the song shows up before the end.
3. **Type the words.** Each hit shows its time and surrounding words. ▶ previews it, **Use** selects it. A close spelling match is marked ≈.
4. **Trim.** Drag the region edges, nudge ±0.1 s, add 0/+2/+5 s after the phrase, loop it. Space plays and pauses.
5. **Export.** The file downloads and is also kept in `exports\`.

Tick **Quick transcription** before adding a song to use the `base` model (faster, less accurate). A quick song gets a **Redo with accurate model** button.

If the words were misheard, open **Transcript** and click the word where the clip should start.

## Lyrics: why search finds lines Whisper misheard

Whisper is good at *when* words are sung and unreliable about *what* they are, especially in Pidgin, Yoruba or Patois over a beat. In one test it heard "yes your body risky" as "yes, you're a very risky".

So the app also fetches the song's plain lyrics from [LRCLIB](https://lrclib.net), during the download. It then lines them up word by word against Whisper's timed words, the way a diff tool lines up two texts. Each lyric word takes the time of the Whisper word it lines up with. Words with no partner get a time between their neighbours and show faded.

Search runs on those timed lyrics, so you type the real words.

The bar under the status tells you what happened:

- **✓ Lyrics from LRCLIB … % matched**: search uses the lyrics.
- **No lyrics found / don't seem to match**: search uses Whisper's words. Click **Change lyrics** to search LRCLIB with other words or paste lyrics from anywhere; a chorus alone is enough. If the check is wrong, **Use them anyway**.

Lyrics are saved in `cache\<song>\lyrics.json`.

## Tuning

| File | What to change |
| --- | --- |
| `config.json` | model, threads, voice detection, port, tool paths |
| `aliases.json` | spelling variants (`yuh` → `your`) and contractions (`im` → `i am`); applies on the next search |

## Troubleshooting

| Problem | Fix |
| --- | --- |
| YouTube downloads fail | yt-dlp is out of date: `tools\yt-dlp.exe -U`, or POST `/api/tools/update-ytdlp` |
| "Could not start …" | A tool is missing; re-run `scripts\setup.ps1`. Check http://127.0.0.1:4321/api/health |
| Windows Defender flags yt-dlp.exe | Add an exclusion for the `tools` folder |
| "No match" on a song you know has the line | The status shows how many words Whisper heard. Open **Transcript** to see how it heard the line and type it that way, or click the word to start there. Whisper's raw output is in `cache\<song>\whisper.log` |
| "Whisper only heard music" | Whisper labelled the whole song `[MUSIC]`. Add the lyrics (**Change lyrics** → Search LRCLIB, or paste them) and press **Retry**: Whisper then gets the lyrics as a hint. If it still hears nothing and LRCLIB has *synced* lyrics, their line timings are used instead (check by ear: a video's intro can shift them) |
| LRCLIB found nothing for a YouTube upload | Upload titles are messy. Type "Artist Title" in **Search LRCLIB**, e.g. `Stonebwoy Good Morning` |
| Very few words on a song full of vocals | Voice detection (`useVad`) can throw away singing. The app reruns without it automatically when that happens; set `"useVad": false` in `config.json` to skip the wasted first pass |
| Clip starts a little early or late | Nudge it; if it is always off, try the other model in the benchmark |
| Slow transcription | Plug in the laptop and use Best performance power mode; try 4 vs 8 threads; use Quick |

## Layout

```
src/server.ts    HTTP API, Server-Sent Events, static page
src/songs.ts     per-song pipeline: download → 16 kHz WAV → whisper → words.json; clip export
src/whisper.ts   whisper-cli arguments and output parsing (one word per line)
src/search.ts    phrase matching: normalise, aliases, typo tolerance, one skipped ad-lib
src/bench.ts     M0 benchmark
public/          the page (plain JS + wavesurfer.js, no build step)
cache/<song>/    meta.json, audio.*, words.json
exports/         your clips
```

Tests: `npm test`. Type-check: `npm run typecheck`.
