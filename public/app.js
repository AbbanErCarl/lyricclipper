import WaveSurfer from "wavesurfer";
import RegionsPlugin from "wavesurfer/regions";

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) n.append(k);
  return n;
};
const fmt = (s) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
};
const api = async (url, opts) => {
  const r = await fetch(url, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
};

const LEAD_IN = 0.3; // seconds before the first matched word
let song = null;
let words = [];
let events = null;
let ws = null;
let regions = null;
let region = null;
let lastHit = null;
let tail = 0.5;
let prevStatus = null;
let lyrics = { meta: null, words: [] }; // aligned lyric words (empty when none or they don't line up)

// ---------------------------------------------------------------- find a song
$("source").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("q").value.trim();
  $("find-msg").textContent = "";
  if (/^https?:\/\//i.test(q)) return addUrl(q);
  $("results").replaceChildren(el("li", { className: "empty", textContent: "Searching YouTube…" }));
  try {
    const results = await api(`/api/search?q=${encodeURIComponent(q)}`);
    $("results").replaceChildren(
      ...results.map((r) => {
        const official = /- Topic$|official audio|audio/i.test(`${r.channel} ${r.title}`);
        const title = el("div", { className: "t", textContent: r.title });
        if (official) title.append(el("span", { className: "badge", textContent: "audio" }));
        const li = el(
          "li", {},
          el("img", { src: r.thumb, alt: "", loading: "lazy" }),
          el("div", {}, title, el("div", { className: "c", textContent: r.channel })),
          el("span", { className: "c", textContent: r.duration ? fmt(r.duration).replace(/\.\d$/, "") : "" }),
        );
        li.onclick = () => addUrl(r.url);
        return li;
      }),
    );
    if (!results.length) $("results").replaceChildren(el("li", { className: "empty", textContent: "No results." }));
  } catch (err) {
    $("results").replaceChildren();
    $("find-msg").textContent = err.message;
  }
});

async function addUrl(url) {
  try {
    const meta = await api("/api/songs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, quick: $("quick").checked }),
    });
    $("results").replaceChildren();
    openSong(meta.key);
  } catch (err) {
    $("find-msg").textContent = err.message;
  }
}

async function addFile(file) {
  $("find-msg").textContent = `Uploading ${file.name}…`;
  try {
    const meta = await api(`/api/songs/upload?quick=${$("quick").checked ? 1 : 0}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent(file.name) },
      body: file,
    });
    $("find-msg").textContent = "";
    openSong(meta.key);
  } catch (err) {
    $("find-msg").textContent = err.message;
  }
}

$("file").addEventListener("change", (e) => e.target.files[0] && addFile(e.target.files[0]));
let dragDepth = 0;
addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; $("drop").hidden = false; });
addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("drop").hidden = true; } });
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("drop").hidden = true;
  const f = e.dataTransfer.files[0];
  if (f) addFile(f);
});

async function loadRecent() {
  const list = await api("/api/songs").catch(() => []);
  $("recent-wrap").hidden = list.length === 0;
  $("recent").replaceChildren(
    ...list.map((m) => {
      const li = el("li", { textContent: [m.artist, m.title].filter(Boolean).join(" – ") });
      li.onclick = () => openSong(m.key);
      return li;
    }),
  );
}

// ---------------------------------------------------------------- song page
async function openSong(key) {
  events?.close();
  ws?.destroy();
  ws = regions = region = lastHit = null;
  words = [];
  prevStatus = null;
  lyrics = { meta: null, words: [] };
  $("lyrics-panel").hidden = true;
  $("editor").hidden = true;
  $("hits").replaceChildren();
  $("transcript").replaceChildren();
  $("export-msg").textContent = "";
  $("song").hidden = false;
  history.replaceState(null, "", `#${key}`);

  events = new EventSource(`/api/songs/${key}/events`);
  events.addEventListener("state", (e) => renderState(JSON.parse(e.data)));
  events.addEventListener("reset", () => {
    words = [];
    renderTranscript();
  });
  events.addEventListener("words", (e) => {
    const batch = JSON.parse(e.data);
    words.push(...batch);
    if (lyrics.words.length) return;
    appendTranscript(batch);
    scheduleSearch();
  });
  events.addEventListener("lyrics", (e) => {
    lyrics = JSON.parse(e.data);
    renderLyricsBar();
    renderTranscript();
    scheduleSearch();
  });
  $("phrase").focus();
  loadRecent();
}

const STATUS_TEXT = {
  queued: "Waiting for the previous song to finish…",
  downloading: "Downloading audio…",
  converting: "Preparing audio for transcription…",
  transcribing: "Transcribing",
  ready: "Ready",
  error: "Error",
};

function renderState(meta) {
  song = meta;
  $("title").textContent = meta.title;
  $("artist").textContent = meta.artist + (meta.quick ? "  ·  quick model" : "");
  let text = STATUS_TEXT[meta.status] ?? meta.status;
  let pct = 0;
  if (meta.status === "transcribing" && meta.duration) {
    pct = Math.min(100, (meta.transcribedTo / meta.duration) * 100);
    text += ` ${fmt(meta.transcribedTo)} / ${fmt(meta.duration)} — hits appear as they are found`;
  }
  if (meta.status === "ready") {
    pct = 100;
    text += ` · Whisper heard ${meta.wordCount ?? words.length} words`;
  }
  if (meta.status === "error") text += `: ${meta.error ?? ""}`;
  if (meta.status !== prevStatus && (meta.status === "ready" || meta.status === "error")) {
    loadRecent(); // the chip was added while the title was still "Fetching…"
    scheduleSearch();
  }
  prevStatus = meta.status;
  $("status-text").textContent = text;
  $("bar-fill").style.width = `${pct}%`;
  $("retry").hidden = meta.status !== "error";
  $("redo").hidden = meta.status !== "ready";
  $("redo").textContent = meta.quick ? "Redo with accurate model" : "Transcribe again";
  if (meta.audioFile && !ws) initWave(meta.key);
}

$("retry").onclick = () => api(`/api/songs/${song.key}/retry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
$("redo").onclick = () =>
  api(`/api/songs/${song.key}/retry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ quick: false }) });

// ---------------------------------------------------------------- lyrics
function renderLyricsBar() {
  const m = lyrics.meta;
  const bar = $("lyrics-bar");
  const change = el("button", { className: "link", textContent: "Change lyrics" });
  change.onclick = openLyricsPanel;
  const who = m && m.trackName ? `“${m.trackName}” by ${m.artistName}` : "";
  const pct = m && m.coverage != null ? `${Math.round(m.coverage * 100)}% of words matched the audio` : "";
  if (!m) bar.replaceChildren();
  else if (m.status === "searching") bar.replaceChildren("Looking up lyrics on LRCLIB…");
  else if (m.status === "error") bar.replaceChildren(`Couldn't reach LRCLIB (${m.error}). `, change);
  else if (m.status === "none") {
    change.textContent = "Paste the lyrics";
    bar.replaceChildren("No lyrics found on LRCLIB, so search uses what Whisper heard. ", change, " to fix misheard words.");
  } else if (m.timing === "synced") {
    bar.replaceChildren(
      `Timing from LRCLIB's synced lyrics (${who}), because Whisper couldn't place the words. ` +
        "If this upload has a longer intro than the album version every line is shifted, so check by ear and drag. ",
      change,
    );
  } else if (m.coverage == null) {
    bar.replaceChildren(`Lyrics found: ${who || "your pasted lyrics"}. They get lined up with the audio when transcription finishes. `, change);
  } else if (m.usable) {
    const src = m.source === "pasted" ? "Your pasted lyrics" : `Lyrics from LRCLIB: ${who}`;
    const note = m.forced ? " (used on your say-so)" : "";
    bar.replaceChildren(`${src} · ${pct}${note}. Search uses these. `, change);
  } else {
    const src = m.source === "pasted" ? "Your pasted lyrics" : `LRCLIB's lyrics (${who})`;
    const force = el("button", { className: "link", textContent: "Use them anyway" });
    force.onclick = () =>
      api(`/api/songs/${song.key}/lyrics`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"force":true}' });
    bar.replaceChildren(`${src} don't seem to match this recording (${pct}), so search uses what Whisper heard. `, change, " · ", force);
  }
  bar.className = `lyrics-bar small${m && m.usable ? " ok" : ""}`;
}

async function openLyricsPanel() {
  const panel = $("lyrics-panel");
  panel.hidden = false;
  $("lyrics-msg").textContent = "";
  $("lyrics-query").value = [song.artist, song.title].filter(Boolean).join(" ");
  const cur = await api(`/api/songs/${song.key}/lyrics`).catch(() => ({ text: "" }));
  $("lyrics-text").value = cur.text || "";
  $("lyrics-text").focus();
}

$("lyrics-cancel").onclick = () => ($("lyrics-panel").hidden = true);
$("lyrics-use").onclick = async () => {
  $("lyrics-msg").textContent = "Lining up…";
  try {
    await api(`/api/songs/${song.key}/lyrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: $("lyrics-text").value }),
    });
    $("lyrics-panel").hidden = true;
  } catch (err) {
    $("lyrics-msg").textContent = err.message;
  }
};
$("lyrics-search").onclick = async () => {
  $("lyrics-msg").textContent = "Searching LRCLIB…";
  try {
    const out = await api(`/api/songs/${song.key}/lyrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: $("lyrics-query").value }),
    });
    if (out.meta?.status === "found") {
      const cur = await api(`/api/songs/${song.key}/lyrics`);
      $("lyrics-text").value = cur.text || "";
      $("lyrics-msg").textContent = `Found “${out.meta.trackName}” by ${out.meta.artistName}. It's in use now; edit below and press Use these lyrics if needed.`;
    } else {
      $("lyrics-msg").textContent = out.meta?.status === "error" ? out.meta.error : "Nothing found. Paste the lyrics instead.";
    }
  } catch (err) {
    $("lyrics-msg").textContent = err.message;
  }
};

// ---------------------------------------------------------------- transcript + hits
function wordSpan(w) {
  const s = el("span", { textContent: w.text, title: `${fmt(w.start)}${w.est ? " (estimated)" : ""}` });
  if (w.est) s.className = "est";
  s.onclick = () => useRange(w.start - LEAD_IN, w.end + 1.5, null);
  return s;
}

function renderTranscript() {
  const t = $("transcript");
  t.replaceChildren();
  if (lyrics.words.length) {
    $("transcript-label").textContent = "Lyrics (click a word to start the clip there; faded = timing estimated)";
    let line = null, p = null;
    for (const w of lyrics.words) {
      if (w.line !== line) {
        p = el("div", { className: "lyric-line" });
        t.append(p);
        line = w.line;
      }
      p.append(wordSpan(w), " ");
    }
  } else {
    $("transcript-label").textContent = "What Whisper heard (click a word to start the clip there)";
    appendTranscript(words);
  }
}

function appendTranscript(batch) {
  const frag = document.createDocumentFragment();
  batch.forEach((w) => frag.append(wordSpan(w), " "));
  $("transcript").append(frag);
}

let searchTimer = null;
function scheduleSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(search, 400);
}
$("phrase").addEventListener("input", scheduleSearch);

async function search() {
  const q = $("phrase").value.trim();
  if (!song || !q) return $("hits").replaceChildren();
  const hits = await api(`/api/songs/${song.key}/matches?q=${encodeURIComponent(q)}`).catch(() => []);
  if (!hits.length) {
    const li = el("li", { className: "empty" });
    if (song.status !== "ready") {
      li.textContent = "No match yet — still transcribing.";
    } else {
      const show = el("button", { className: "link", textContent: "Open the transcript" });
      show.onclick = () => {
        $("transcript-wrap").open = true;
        $("transcript-wrap").scrollIntoView({ behavior: "smooth", block: "start" });
      };
      if (lyrics.words.length) {
        show.textContent = "Open the lyrics";
        li.append("No match in the lyrics. ", show, " to check the wording, or click a word to start there.");
      } else {
        const fix = el("button", { className: "link", textContent: "add the lyrics" });
        fix.onclick = openLyricsPanel;
        li.append(`No match in the ${words.length} words Whisper heard. `, show, " to see how it heard the line, or ", fix, ".");
      }
    }
    return $("hits").replaceChildren(li);
  }
  $("hits").replaceChildren(
    ...hits.map((h) => {
      const ctx = el("span", { className: "ctx" }, `${h.before} `, el("mark", { textContent: h.match }), ` ${h.after}`);
      const play = el("button", { textContent: "▶", title: "Preview" });
      const use = el("button", { textContent: "Use", className: "primary-ghost" });
      const li = el("li", {}, el("span", { className: "time", textContent: fmt(h.start) }), ctx, play, use);
      const notes = [];
      if (h.partial) notes.push("one word differs");
      else if (!h.exact) notes.push("close match");
      if (h.est) notes.push("timing estimated");
      if (h.source === "whisper" && lyrics.words.length) notes.push("from Whisper's words");
      if (notes.length) ctx.append(el("span", { className: "fuzzy", textContent: `  ≈ ${notes.join(" · ")}` }));
      play.onclick = () => {
        useHit(h, li);
        playRegion();
      };
      use.onclick = () => useHit(h, li);
      if (lastHit && lastHit.start === h.start) li.classList.add("active");
      return li;
    }),
  );
}

function useHit(h, li) {
  lastHit = h;
  document.querySelectorAll(".hits li").forEach((n) => n.classList.remove("active"));
  li?.classList.add("active");
  useRange(h.start - LEAD_IN, h.end + tail, h);
}

// ---------------------------------------------------------------- waveform editor
function initWave(key) {
  $("editor").hidden = false;
  regions = RegionsPlugin.create();
  ws = WaveSurfer.create({
    container: "#wave",
    url: `/api/songs/${key}/audio`,
    height: 96,
    minPxPerSec: 60,
    waveColor: getComputedStyle(document.documentElement).getPropertyValue("--muted").trim() || "#999",
    progressColor: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#d1462f",
    cursorWidth: 2,
    autoCenter: true,
    plugins: [regions],
  });
  regions.on("region-updated", () => updateLen());
  regions.on("region-out", (r) => {
    if (r !== region) return;
    if ($("loop").checked) r.play();
    else ws.pause();
  });
  ws.on("decode", () => region && ws.setScrollTime(Math.max(0, region.start - 2)));
}

function useRange(start, end, hit) {
  if (!ws) return;
  if (!hit) lastHit = null;
  start = Math.max(0, start);
  const max = song?.duration || end;
  end = Math.min(max, Math.max(end, start + 0.5));
  if (region) region.setOptions({ start, end });
  else region = regions.addRegion({ start, end, drag: true, resize: true, color: "rgba(209, 70, 47, 0.18)" });
  ws.setTime(start);
  ws.setScrollTime(Math.max(0, start - 2));
  updateLen();
  $("export-msg").textContent = "";
}

function updateLen() {
  if (!region) return;
  const len = region.end - region.start;
  $("len").textContent = `${len.toFixed(1)} s`;
  $("len").style.color = len > 20 ? "var(--accent)" : "";
}

function playRegion() {
  if (region) region.play();
}

$("play").onclick = () => (ws?.isPlaying() ? ws.pause() : playRegion());

document.querySelectorAll("[data-nudge]").forEach((b) => {
  b.onclick = () => {
    if (!region) return;
    const [edge, d] = b.dataset.nudge.split(":");
    const next = Math.max(0, region[edge] + Number(d));
    if (edge === "start" && next < region.end - 0.3) region.setOptions({ start: next });
    if (edge === "end" && next > region.start + 0.3) region.setOptions({ end: next });
    updateLen();
  };
});

document.querySelectorAll("[data-tail]").forEach((b) => {
  b.onclick = () => {
    tail = Number(b.dataset.tail) + 0.5;
    if (lastHit) useRange(region.start, lastHit.end + tail, lastHit);
  };
});

$("export").onclick = async () => {
  if (!region) return ($("export-msg").textContent = "Pick a hit or click a word first.");
  const len = region.end - region.start;
  if (len > 20 && !confirm(`This clip is ${len.toFixed(0)} s long. Export anyway?`)) return;
  $("export-msg").textContent = "Exporting…";
  try {
    const out = await api("/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: song.key,
        start: region.start,
        end: region.end,
        format: $("format").value,
        label: $("phrase").value.trim() || song.title,
      }),
    });
    const a = el("a", { href: out.url, download: out.name, textContent: `Download ${out.name}` });
    $("export-msg").replaceChildren(a);
    a.click();
  } catch (err) {
    $("export-msg").textContent = err.message;
  }
};

// Keyboard: space plays/pauses the selection when not typing.
addEventListener("keydown", (e) => {
  if (e.code === "Space" && document.activeElement?.tagName !== "INPUT" && region) {
    e.preventDefault();
    $("play").click();
  }
});

loadRecent();
if (location.hash.length > 1) openSong(location.hash.slice(1));
