import { formatStamp } from "./markdown.js";
import type { VideoSegment } from "./vtt.js";
import type { VideoChapter, VideoMeta } from "./ytdlp.js";

// A frame is only evidence once it says what was being said while it was on
// screen. Each frame is paired with the transcript from 5 s before it to 10 s
// after: a slide usually appears as the speaker starts on it, and is talked
// about for a while after.

const BEFORE_S = 5;
const AFTER_S = 10;

/** Why a frame was taken: a scene change, a chapter start, or — for a video with neither — a regular interval. */
export type FrameKind = "scene" | "chapter" | "interval";

/** One kept frame, with the transcript around it. */
export interface VideoFrame {
  /** Path relative to the run directory: `frames/0003_01-23.jpg`. */
  file: string;
  time: number;
  stamp: string;
  kind: FrameKind;
  chapter?: string;
  /** The segments spoken from 5 s before the frame to 10 s after, stamped. */
  text: string;
}

/** The segments that overlap [t − 5 s, t + 10 s], each stamped. */
export function transcriptAround(segments: VideoSegment[], t: number): string {
  return segments
    .filter((s) => s.end >= t - BEFORE_S && s.start <= t + AFTER_S)
    .map((s) => `[${formatStamp(s.start)}] ${s.text}`)
    .join("\n");
}

const chapterAt = (chapters: VideoChapter[], t: number) => [...chapters].sort((a, b) => b.start - a.start).find((c) => c.start <= t + 0.5)?.title;

/** Pair each frame with its chapter and the transcript around it. */
export function alignFrames(frames: { file: string; time: number; kind: FrameKind }[], segments: VideoSegment[], chapters: VideoChapter[]): VideoFrame[] {
  return frames.map((f) => {
    const chapter = chapterAt(chapters, f.time);
    return { file: f.file, time: f.time, stamp: formatStamp(f.time), kind: f.kind, ...(chapter ? { chapter } : {}), text: transcriptAround(segments, f.time) };
  });
}

/** FRAMES.md: every frame, its image, and what was said around it. */
export function framesMarkdown(meta: VideoMeta, frames: VideoFrame[], note: string): string {
  const out = [`# ${meta.title} — frames`, "", `- URL: ${meta.webpageUrl}`, `- ${note}`, ""];
  // A long segment spans several frames; it is quoted under the first and
  // pointed at from the others, so the page reads once through.
  const quoted = new Set<string>();
  for (const f of frames) {
    out.push(`## [${f.stamp}]${f.chapter ? ` ${f.chapter}` : ""}`, "", `![${f.stamp}](${f.file})`, "");
    const lines = f.text ? f.text.split("\n") : [];
    const fresh = lines.filter((l) => !quoted.has(l));
    for (const l of fresh) quoted.add(l);
    if (fresh.length) out.push(...fresh.map((l) => `> ${l}`), "");
    else if (lines.length) out.push(`_(said over the passage quoted above, from ${lines[0]!.slice(0, lines[0]!.indexOf("]") + 1)})_`, "");
    else out.push("_(nothing said around this frame)_", "");
  }
  return out.join("\n").trimEnd() + "\n";
}
