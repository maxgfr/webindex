// WebVTT → timestamped text.
//
// Two kinds of track come out of YouTube and they need opposite handling:
//
//   - Manual subtitles are what a person typed: one cue per line or two,
//     punctuated, no repetition. They only need their lines joined.
//   - Auto-captions ROLL. Each cue shows the previous line again above the new
//     one, the new words carry `<00:00:01.234><c>` timing tags, and a 10 ms
//     "bridge" cue repeats the line on its own between the two. Read naively,
//     every sentence appears three times.
//
// parseVtt undoes the rolling (a cue keeps only what was not already said),
// and mergeSegments turns the cues — a few words each — into segments of one
// to three sentences, which is the unit worth citing with a timestamp.

/** One timed piece of transcript, in seconds from the start of the video. */
export interface VideoSegment {
  start: number;
  end: number;
  text: string;
}

const TIMING = /^((?:\d+:)?\d{1,2}:\d{2}\.\d{3})\s+-->\s+((?:\d+:)?\d{1,2}:\d{2}\.\d{3})/;
// The bridge cues of a rolling track last 10 ms; nothing a person can read does.
const MIN_CUE_S = 0.05;

function seconds(stamp: string): number {
  const parts = stamp.split(":").map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", lrm: "", rlm: "" };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

// Tags first, entities second: `&lt;show&gt;` is text, and must not be read as a tag.
const clean = (line: string) =>
  decode(line.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();

/**
 * The cues of a WebVTT file, tags stripped and entities decoded, with the
 * rolling repetition of auto-captions removed: a line already said is dropped,
 * and a line that continues the last one keeps only what it adds. Empty for
 * anything that is not WebVTT.
 */
export function parseVtt(src: string): VideoSegment[] {
  const text = src.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!/^WEBVTT/.test(text)) return [];
  const out: VideoSegment[] = [];
  // Only a rolling track repeats itself on purpose; a manual one that says
  // "No." twice means it twice. The word-timing tags give a rolling one away.
  const rolling = /<\d{2}:\d{2}[:.]\d/.test(text) || /<c>/.test(text);
  // What the viewer has already read: the last two lines emitted.
  const said: string[] = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => TIMING.test(l));
    if (at < 0) continue; // the header, NOTE, STYLE and REGION blocks
    const m = TIMING.exec(lines[at]!)!;
    const start = seconds(m[1]!);
    const end = seconds(m[2]!);
    if (end - start < MIN_CUE_S) continue;
    const fresh: string[] = [];
    for (const raw of lines.slice(at + 1)) {
      let line = clean(raw);
      if (!line) continue;
      if (!rolling) {
        fresh.push(line);
        continue;
      }
      if (said.includes(line)) continue;
      const last = said[said.length - 1];
      if (last && line.startsWith(`${last} `)) line = line.slice(last.length + 1);
      fresh.push(line);
      said.push(clean(raw));
      if (said.length > 2) said.shift();
    }
    if (fresh.length) out.push({ start, end, text: fresh.join(" ") });
  }
  return out;
}

// A sentence ends on . ! ? or …, possibly inside a closing quote or bracket.
const SENTENCE_END = /[.!?…]+["'”’)\]]*(?=\s|$)/g;
const MAX_SEGMENT_S = 30;
const MAX_SENTENCES = 3;
const PAUSE_S = 5;
const WORDS_TO_CLOSE = 25;
const BREAK_SLACK_S = 0.5;

/**
 * Cues merged into segments of one to three sentences: a segment closes after
 * its third sentence, or on a sentence end once it holds a couple of lines'
 * worth of words. It never spans more than 30 s — which is what bounds an
 * unpunctuated auto-caption stream — nor a pause of more than 5 s, nor any
 * of `breaks` (chapter starts, in seconds).
 */
export function mergeSegments(cues: VideoSegment[], breaks: number[] = []): VideoSegment[] {
  const out: VideoSegment[] = [];
  let cur: VideoSegment | undefined;
  const flush = () => {
    if (cur) out.push(cur);
    cur = undefined;
  };
  // A segment never straddles a break (a chapter start): its heading would
  // otherwise land a paragraph late, or not at all.
  const crossesBreak = (from: number, to: number) => breaks.some((b) => b > from + BREAK_SLACK_S && b <= to + BREAK_SLACK_S);
  for (const cue of cues) {
    if (cur && (cue.start - cur.end > PAUSE_S || cue.end - cur.start > MAX_SEGMENT_S || crossesBreak(cur.start, cue.start))) flush();
    cur = cur ? { start: cur.start, end: Math.max(cur.end, cue.end), text: `${cur.text} ${cue.text}` } : { ...cue };
    const sentences = cur.text.match(SENTENCE_END)?.length ?? 0;
    const endsSentence = /[.!?…]+["'”’)\]]*$/.test(cur.text);
    const words = cur.text.split(/\s+/).length;
    if (sentences >= MAX_SENTENCES || (endsSentence && words >= WORDS_TO_CLOSE)) flush();
  }
  flush();
  return out;
}
