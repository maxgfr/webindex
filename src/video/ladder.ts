import { envName } from "../brand.js";
import { have } from "../exec.js";
import { enginesFromEnv } from "../pdf/ladder.js";
import { videoSource } from "./url.js";
import { mergeSegments, parseVtt, type VideoSegment } from "./vtt.js";
import { resetWhisperBudget, whisperBudgetLeft, whisperTranscribe } from "./whisper.js";
import { defaultVideoRunner, downloadSubtitle, probeVideo, type VideoChapter, type VideoMeta, type VideoRunner } from "./ytdlp.js";

// The transcript ladder, modelled on the PDF one (pdf/ladder.ts): try the
// cheapest rung that can be trusted, fall through when it is missing or its
// output fails the quality gate, and say why when nothing is left.
//
//   1. manual-subs  what a person typed. Punctuated, exact, free.
//   2. auto-caps    YouTube's own speech recognition, in the video's language
//                   (`<lang>-orig`). Never one of its machine translations:
//                   a translated transcript quoted as what was said is a
//                   misquotation.
//   3. whisper      local transcription (./whisper.ts). Minutes, not seconds,
//                   and budgeted per process.

export type VideoTranscriberId = "manual-subs" | "auto-subs" | "whisper";

export const VIDEO_TRANSCRIBERS: VideoTranscriberId[] = ["manual-subs", "auto-subs", "whisper"];

export interface VideoTranscript {
  /** The transcript as plain text, one segment per line. Empty when every rung failed. */
  text: string;
  segments: VideoSegment[];
  chapters: VideoChapter[];
  /** Absent only when yt-dlp could not read the video at all. */
  meta?: VideoMeta;
  /** Which rung produced the transcript. */
  via?: VideoTranscriberId;
  /**
   * The subtitle track it was read from (`en`, `fr`, `en-orig`). A manual
   * track in another language than the video's is a translation, and a reader
   * quoting it must know.
   */
  track?: string;
  /** Why there is no transcript, when there is none. */
  reason?: string;
}

/** What the ladder shells out through. Injected by tests; the defaults run the real tools. */
export interface VideoDeps {
  run: VideoRunner;
  have: (cmd: string) => boolean;
}

export interface VideoLadderOptions {
  /** The preferred subtitle language (`fr`, `en-US`). Defaults to the video's own. */
  lang?: string;
  /** Restrict or reorder the rungs. Defaults to `<PREFIX>_VIDEO_ENGINES`, else all three. */
  engines?: VideoTranscriberId[];
  deps?: Partial<VideoDeps>;
  /** Stops the ladder, and kills whichever command it is running. */
  signal?: AbortSignal;
  /**
   * Read only the video hosts `knownVideo` recognises (YouTube, Vimeo,
   * Dailymotion…), not any http(s) URL. Off by default: an explicit request
   * for a video's transcript may name any page yt-dlp can read.
   */
  knownHostsOnly?: boolean;
  /** The probe of this very URL, already made (see probeVideo): the page is not extracted a second time. */
  probed?: { meta: VideoMeta; info: string };
}

// What the ladder runs through when a caller passes no deps of its own. A test
// seam: fetchAndExtract, the CLI and the MCP tools reach the ladder with no way
// to hand it a runner, so a test swaps the process-wide one instead.
let processDeps: Partial<VideoDeps> = {};

/** Test seam: the runner and `have` every later call uses by default; no argument restores the real tools. */
export function setVideoDeps(deps: Partial<VideoDeps> = {}): void {
  processDeps = deps;
}

/** The deps a call runs with: its own, else the process-wide ones, else the real tools. */
export function videoDeps(own?: Partial<VideoDeps>): VideoDeps {
  return { run: own?.run ?? processDeps.run ?? defaultVideoRunner, have: own?.have ?? processDeps.have ?? have };
}

// Rungs proven unavailable in this process, with the reason worth repeating.
const dead = new Map<VideoTranscriberId, string>();

/** Test seam: forget which rungs were found missing, and refill the whisper budget. */
export function resetVideoLadderCache(): void {
  dead.clear();
  resetWhisperBudget();
}

/** The rungs to try: an explicit list, else `<PREFIX>_VIDEO_ENGINES` (a comma list, or `none`), else all. */
export function enabledTranscribers(engines?: VideoTranscriberId[]): VideoTranscriberId[] {
  return engines ?? enginesFromEnv("VIDEO_ENGINES", VIDEO_TRANSCRIBERS) ?? VIDEO_TRANSCRIBERS;
}

const MIN_WORDS_PER_MINUTE = 5;

/**
 * Whether a transcript is worth citing: not empty, and for a video over a
 * minute at least 5 words a minute. The bar judges emptiness, not eloquence —
 * it is there so a music video's three captioned lines fall through to
 * whisper instead of passing for its transcript.
 */
export function assessTranscript(segments: VideoSegment[], duration?: number): { ok: true } | { ok: false; reason: string } {
  const words = segments.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
  if (!words) return { ok: false, reason: "empty transcript" };
  if (duration && duration > 60) {
    const minutes = duration / 60;
    if (words / minutes < MIN_WORDS_PER_MINUTE) {
      return { ok: false, reason: `transcript too sparse: ${words} words over ${Math.round(minutes)} min — music or a silent video?` };
    }
  }
  return { ok: true };
}

const base = (tag: string) => tag.toLowerCase().split(/[-_]/)[0]!;

/**
 * The manual track to download: the requested language, else the video's
 * own, else English, else the first one listed. A language matches exactly
 * first, then by its primary subtag (`en` finds `en-GB`).
 */
export function pickManualTrack(meta: VideoMeta, lang?: string): string | undefined {
  const tracks = meta.subtitles;
  if (!tracks.length) return undefined;
  for (const want of [lang, meta.language, "en"]) {
    if (!want) continue;
    const exact = tracks.find((t) => t.toLowerCase() === want.toLowerCase());
    if (exact) return exact;
    const sameBase = tracks.find((t) => base(t) === base(want));
    if (sameBase) return sameBase;
  }
  return tracks[0];
}

/**
 * The auto-caption track in the video's own language: `<lang>-orig`, else
 * `<lang>`. With the language unknown, the one `-orig` track YouTube lists is
 * the original. Undefined rather than a translation.
 */
export function pickAutoTrack(meta: VideoMeta): string | undefined {
  const tracks = meta.autoCaptions;
  const lang = meta.language;
  if (lang) {
    for (const want of [`${lang}-orig`, lang]) {
      const hit = tracks.find((t) => t.toLowerCase() === want.toLowerCase());
      if (hit) return hit;
    }
    const orig = tracks.find((t) => t.endsWith("-orig") && base(t) === base(lang));
    if (orig) return orig;
    return undefined;
  }
  const origs = tracks.filter((t) => t.endsWith("-orig"));
  return origs.length === 1 ? origs[0] : undefined;
}

const chapterStarts = (meta: VideoMeta) => meta.chapters.map((c) => c.start);

type RungOutcome = { segments: VideoSegment[]; track?: string } | { failure: string; noTrack?: boolean; unavailable?: boolean };

async function subtitleRung(auto: boolean, meta: VideoMeta, info: string, opts: VideoLadderOptions, deps: VideoDeps): Promise<RungOutcome> {
  const track = auto ? pickAutoTrack(meta) : pickManualTrack(meta, opts.lang);
  if (!track) return { failure: auto ? "no auto-captions in the video's language" : "no manual subtitles", noTrack: true };
  const got = await downloadSubtitle(info, track, auto, deps.run, opts.signal, opts.knownHostsOnly);
  if ("error" in got) return { failure: `${auto ? "auto-captions" : "subtitles"} (${track}): ${got.error}` };
  // Only an auto track rolls; a manual one that repeats a line means it.
  return { segments: mergeSegments(parseVtt(got.vtt, { rolling: auto }), chapterStarts(meta)), track };
}

async function whisperRung(meta: VideoMeta, info: string, opts: VideoLadderOptions, deps: VideoDeps): Promise<RungOutcome> {
  const missing = ["uvx", "ffmpeg"].filter((c) => !deps.have(c));
  if (missing.length) return { failure: "whisper needs uvx and ffmpeg", unavailable: true };
  if (whisperBudgetLeft() <= 0) return { failure: `this run's whisper budget is spent (raise ${envName("WHISPER_MAX")})` };
  const r = await whisperTranscribe(info, meta.language, deps.run, opts.signal, opts.knownHostsOnly);
  if ("segments" in r) return { segments: mergeSegments(r.segments, chapterStarts(meta)) };
  if ("declined" in r) return { failure: `this run's whisper budget is spent (raise ${envName("WHISPER_MAX")})` };
  return { failure: r.failed, unavailable: r.unavailable };
}

const plain = (segments: VideoSegment[]) => segments.map((s) => s.text).join("\n");

/**
 * A video's transcript — YouTube, or any site yt-dlp reads — from the first
 * rung whose output passes the quality gate. Never throws: every failure is a
 * `reason`.
 *
 * Only an http(s) URL is read, and it always reaches yt-dlp after `--`, so no
 * caller's string can be taken for an option. A known host's URL is rebuilt
 * from its id first (a YouTube watch URL, Vimeo's player).
 */
export async function transcribeVideo(url: string, opts: VideoLadderOptions = {}): Promise<VideoTranscript> {
  const none = (reason: string, meta?: VideoMeta): VideoTranscript => ({
    text: "",
    segments: [],
    chapters: meta?.chapters ?? [],
    ...(meta ? { meta } : {}),
    reason,
  });
  const source = videoSource(url, { anySite: !opts.knownHostsOnly });
  if (!source) return none(`not a video URL${opts.knownHostsOnly ? " on a known video host" : ""}: ${url}`);
  const deps = videoDeps(opts.deps);
  const rungs = enabledTranscribers(opts.engines);
  if (!rungs.length) return none(`every transcript rung is switched off (${envName("VIDEO_ENGINES")})`);

  const probe = opts.probed ?? (await probeVideo(source.url, deps.run, opts.signal, opts.knownHostsOnly));
  if ("error" in probe) return none(probe.error);
  const { meta, info } = probe;
  // A stream on air has no end to transcribe, and whisper would record it
  // until its timeout; one not started yet has nothing at all.
  if (meta.live) return none(`live stream ${meta.live === "live" ? "in progress" : "not started yet"} — read it once it has ended`, meta);

  const failures: string[] = [];
  let noTrack = 0;
  let subtitleRungs = 0;
  let whisperMissing = false;
  let gateReason: string | undefined;
  for (const rung of rungs) {
    if (opts.signal?.aborted) return none("cancelled", meta);
    if (rung !== "whisper") subtitleRungs++;
    const known = dead.get(rung);
    let got: RungOutcome;
    if (known) got = { failure: known, unavailable: true };
    else {
      try {
        got = rung === "whisper" ? await whisperRung(meta, info, opts, deps) : await subtitleRung(rung === "auto-subs", meta, info, opts, deps);
      } catch (e) {
        got = { failure: `${rung}: ${(e as Error).message}` }; // a rung must never take the run down
      }
    }
    if (opts.signal?.aborted) return none("cancelled", meta);
    if ("failure" in got) {
      if (got.unavailable) dead.set(rung, got.failure);
      if (rung === "whisper" && got.unavailable) whisperMissing = true;
      if (got.noTrack) noTrack++;
      failures.push(got.failure);
      continue;
    }
    const verdict = assessTranscript(got.segments, meta.duration);
    if (verdict.ok)
      return { text: plain(got.segments), segments: got.segments, chapters: meta.chapters, meta, via: rung, ...(got.track ? { track: got.track } : {}) };
    gateReason = verdict.reason;
  }

  // The common case said plainly, as the spec words it.
  let reason: string;
  if (subtitleRungs && noTrack === subtitleRungs && whisperMissing && !gateReason) reason = "no subtitles, and whisper needs uvx and ffmpeg";
  else reason = [...new Set([gateReason, ...failures].filter(Boolean))].join("; ");
  return none(reason || "no transcript", meta);
}
