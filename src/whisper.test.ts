import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLine, promptFromLyrics, whisperArgs } from "./whisper.js";

test("parses a whisper-cli word line", () => {
  assert.deepEqual(parseLine("[00:01:02.340 --> 00:01:02.700]   body"), { text: "body", start: 62.34, end: 62.7 });
  assert.deepEqual(parseLine("[01:00:00.000 --> 01:00:00.500]  risky,"), { text: "risky,", start: 3600, end: 3600.5 });
});

test("skips non-lyric lines", () => {
  assert.equal(parseLine(""), null);
  assert.equal(parseLine("whisper_init_from_file: loading model"), null);
  assert.equal(parseLine("[00:00:00.000 --> 00:00:04.000]   [Music]"), null);
  assert.equal(parseLine("[00:00:00.000 --> 00:00:04.000]   (laughs)"), null);
  assert.equal(parseLine("[00:00:00.000 --> 00:00:04.000]   ♪"), null);
  assert.equal(parseLine("[00:00:00.000 --> 00:00:04.000]   ."), null);
});

test("uses greedy decoding and one word per line", () => {
  const a = whisperArgs("song.wav", false);
  const after = (flag: string) => a[a.indexOf(flag) + 1];
  assert.equal(after("-bs"), "1");
  assert.equal(after("-ml"), "1");
  assert.ok(a.includes("-sow"));
  assert.equal(after("-f"), "song.wav");
});

test("music tags are always suppressed; a prompt is carried into every window", () => {
  assert.ok(whisperArgs("a.wav", false).includes("-sns"));
  assert.ok(!whisperArgs("a.wav", false).includes("--prompt"));
  const a = whisperArgs("a.wav", false, { prompt: "Good morning to the maker" });
  assert.equal(a[a.indexOf("--prompt") + 1], "Good morning to the maker");
  assert.ok(a.includes("--carry-initial-prompt"));
});

test("the lyrics prompt keeps each line once and stays short", () => {
  const p = promptFromLyrics("Good morning to the maker\nYou do me all this favor\nGood morning to the maker\n[Chorus]\nChilling in Jamaica", 12);
  assert.equal(p, "Good morning to the maker. You do me all this favor");
});
