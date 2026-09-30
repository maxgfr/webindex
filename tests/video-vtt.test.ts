import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mergeSegments, parseVtt } from "../src/video.js";

// Captured once from YouTube with yt-dlp (see tests/fixtures/video/) and trimmed:
// a manual English track, its French translation, the rolling auto-captions of
// the same talk, and the first video ever uploaded.
const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", "video", name), "utf8");

describe("parseVtt", () => {
  it("reads a manual track cue by cue, lines joined", () => {
    const cues = parseVtt(fixture("zoo-manual.en.vtt"));
    expect(cues).toHaveLength(6);
    expect(cues[0]).toEqual({ start: 1.2, end: 3.36, text: "All right, so here we are, in front of the elephants" });
    expect(cues[5]!.text).toBe("and that's pretty much all there is to say");
  });

  it("keeps accented text and speaker cues of a translated track", () => {
    const cues = parseVtt(fixture("ted-manual.fr.vtt"));
    expect(cues.map((c) => c.text)).toContain("Bonjour. Comment ça va ?");
    expect(cues.map((c) => c.text)).toContain("(Rires)");
  });

  it("drops the rolling repetition of auto-captions", () => {
    const cues = parseVtt(fixture("ted-auto.en-orig.vtt"));
    const text = cues.map((c) => c.text).join(" ");
    expect(text).toContain("good morning how are you it's been great hasn't it it's been i've been blown away by the whole thing");
    // No word-timing tag survives, and no line is said twice in a row.
    expect(text).not.toMatch(/<|>/);
    const lines = cues.map((c) => c.text);
    for (let i = 1; i < lines.length; i++) expect(lines[i], `cue ${i}`).not.toBe(lines[i - 1]);
    // The 10 ms bridge cues carry nothing new and are gone.
    expect(cues.every((c) => c.end - c.start > 0.05)).toBe(true);
    expect(text.match(/good morning/g)).toHaveLength(1);
  });

  it("keeps a line a rolling track says twice on purpose", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:02.000 align:start position:0%",
      " ",
      "no<00:00:01.500><c> no</c>",
      "",
      "00:00:02.000 --> 00:00:02.010 align:start position:0%",
      "no no",
      " ",
      "",
      "00:00:02.010 --> 00:00:03.000 align:start position:0%",
      "no no",
      "no<00:00:02.500><c> no</c>",
      "",
      "00:00:03.000 --> 00:00:04.000 align:start position:0%",
      "no no",
      "thank<00:00:03.500><c> you</c>",
      "",
    ].join("\n");
    expect(parseVtt(vtt).map((c) => c.text)).toEqual(["no no", "no no", "thank you"]);
  });

  it("dedupes a rolling track it is told is one, even without timing tags", () => {
    const vtt = "WEBVTT\n\n00:01.000 --> 00:02.000\nhello there\n\n00:02.000 --> 00:03.000\nhello there\ngeneral kenobi\n";
    expect(parseVtt(vtt, { rolling: true }).map((c) => c.text)).toEqual(["hello there", "general kenobi"]);
    expect(parseVtt(vtt).map((c) => c.text)).toEqual(["hello there", "hello there general kenobi"]);
  });

  it("strips tags and decodes entities", () => {
    const vtt = "WEBVTT\n\nNOTE a comment\n\n00:01.000 --> 00:02.500 align:start position:0%\n<v Roger>Tom &amp; Jerry&#39;s <i>&lt;show&gt;</i>&nbsp;now\n";
    expect(parseVtt(vtt)).toEqual([{ start: 1, end: 2.5, text: "Tom & Jerry's <show> now" }]);
  });

  it("reads hour stamps, CRLF files and cue identifiers", () => {
    const vtt = "WEBVTT\r\n\r\n1\r\n01:02:03.500 --> 01:02:05.000\r\nlate line\r\n";
    expect(parseVtt(vtt)).toEqual([{ start: 3723.5, end: 3725, text: "late line" }]);
  });

  it("keeps a line a manual track really says twice", () => {
    const vtt = "WEBVTT\n\n00:01.000 --> 00:02.000\nNever gonna give you up\n\n00:02.000 --> 00:03.000\nNever gonna give you up\n";
    expect(parseVtt(vtt).map((c) => c.text)).toEqual(["Never gonna give you up", "Never gonna give you up"]);
  });

  it("reads an SRT track as well (Dailymotion serves nothing else)", () => {
    const srt = "1\n00:00:00,000 --> 00:00:04,960\nLorem ipsum dolor sit amet,\n\n2\n00:00:05,520 --> 00:00:09,860\nconsectetur adipiscing elit\n";
    expect(parseVtt(srt)).toEqual([
      { start: 0, end: 4.96, text: "Lorem ipsum dolor sit amet," },
      { start: 5.52, end: 9.86, text: "consectetur adipiscing elit" },
    ]);
  });

  it("returns nothing for something that is not WebVTT", () => {
    expect(parseVtt("")).toEqual([]);
    expect(parseVtt("<html>blocked</html>")).toEqual([]);
  });
});

describe("mergeSegments", () => {
  it("groups a manual track into sentence-sized segments", () => {
    const segs = mergeSegments(parseVtt(fixture("ted-manual.en.vtt")));
    expect(segs.length).toBeGreaterThan(3);
    expect(segs.length).toBeLessThan(36);
    for (const s of segs) {
      expect(s.end - s.start, s.text).toBeLessThanOrEqual(30);
      expect(s.text).toBe(s.text.trim());
    }
    // A segment closes on a sentence end, so none but the last stops mid-sentence.
    for (const s of segs.slice(0, -1)) expect(s.text, s.text).toMatch(/[.!?…)"”]$/);
    expect(segs[0]!.start).toBeCloseTo(27.103);
    expect(segs[0]!.text.startsWith("Good morning. How are you?")).toBe(true);
  });

  it("caps an unpunctuated auto-caption stream at 30 s per segment", () => {
    const segs = mergeSegments(parseVtt(fixture("ted-auto.en-orig.vtt")));
    expect(segs.length).toBeGreaterThan(2);
    for (const s of segs) expect(s.end - s.start).toBeLessThanOrEqual(30);
    // Nothing is lost in the merge.
    const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
    const cues = parseVtt(fixture("ted-auto.en-orig.vtt"));
    expect(segs.reduce((n, s) => n + words(s.text), 0)).toBe(cues.reduce((n, c) => n + words(c.text), 0));
  });

  it("starts a new segment after a long silence", () => {
    const segs = mergeSegments([
      { start: 0, end: 2, text: "first thought" },
      { start: 20, end: 22, text: "after a pause" },
    ]);
    expect(segs.map((s) => s.text)).toEqual(["first thought", "after a pause"]);
  });

  it("never lets a segment straddle a chapter start", () => {
    const cues = parseVtt(fixture("zoo-manual.en.vtt"));
    expect(mergeSegments(cues)[0]!.text).toContain("really long trunks");
    const segs = mergeSegments(cues, [0, 5, 17]);
    expect(segs.map((s) => Math.floor(s.start))).toEqual([1, 5, 16]);
    expect(segs[0]!.text).toBe("All right, so here we are, in front of the elephants");
  });

  it("closes after three sentences", () => {
    const segs = mergeSegments([
      { start: 0, end: 1, text: "One." },
      { start: 1, end: 2, text: "Two." },
      { start: 2, end: 3, text: "Three." },
      { start: 3, end: 4, text: "Four." },
    ]);
    expect(segs.map((s) => s.text)).toEqual(["One. Two. Three.", "Four."]);
  });
});
