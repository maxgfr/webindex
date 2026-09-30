import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isNoWrite, writeArtifact } from "../no-write.js";
import { alignFrames, framesMarkdown, type FrameKind, type VideoFrame } from "./align.js";
import { DHASH_SAME, dhashStream, hamming } from "./dhash.js";
import { videoDeps, type VideoDeps } from "./ladder.js";
import { formatStamp } from "./markdown.js";
import { readVideoRun } from "./run.js";
import { videoSource } from "./url.js";
import { downloadMedia, withTempDir } from "./ytdlp.js";

// What is on screen: frames at every scene change and every chapter start,
// near-duplicates dropped, capped, and paired with what was said around them.
//
// The video itself is downloaded at 720p at most into a temp directory and
// removed whatever happens; only the chosen JPEGs stay, in `<run>/frames/`,
// with FRAMES.md and frames.json beside them.

/** How many frames each effort keeps at most. */
export const FRAME_EFFORT = { low: 20, med: 50, high: 100 } as const;
export type FrameEffort = keyof typeof FRAME_EFFORT;

const SCENE_THRESHOLD = 0.3;
// 720p at most. yt-dlp already leaves out formats it knows to be under DRM;
// one it only discovers when downloading (Vimeo's) is reported as such.
export const VIDEO_FORMAT = "bv*[height<=720]/b[height<=720]/bv*/b";
const FRAMES_TIMEOUT_MS = 30 * 60_000;
// A video with (almost) no scene change and no chapters — a talking head, a
// slide deck with fades — still gets this many frames, evenly spaced.
const MIN_FRAMES = 3;
const INTERVAL_FRAMES = 10;

// Full-range YUV is what the MJPEG encoder takes; a tv-range source (most of
// YouTube) otherwise fails with "Error while opening encoder".
const JPEG_FILTER = "scale='min(1280,iw)':-2:out_range=full,format=yuvj420p";

/** The `pts_time` of each frame `showinfo` logged, in output order. */
export function parseShowinfo(stderr: string): number[] {
  const out: number[] = [];
  for (const m of stderr.matchAll(/\bn:\s*(\d+)\s+pts:\s*-?\d+\s+pts_time:(-?[\d.]+)/g)) out[Number(m[1])] = Number(m[2]);
  return out.filter((t) => Number.isFinite(t));
}

/**
 * At most `max` frames, keeping the most widely spaced: the frame closest to
 * the one before it goes first, and a chapter frame only once nothing else is
 * left to drop. Sorted by time.
 */
export function capFrames<T extends { time: number; kind: FrameKind }>(frames: T[], max: number): T[] {
  const kept = [...frames].sort((a, b) => a.time - b.time);
  const limit = Math.max(1, max);
  while (kept.length > limit) {
    const spareChapters = kept.some((f) => f.kind !== "chapter");
    let worst = kept.length - 1;
    let gap = Number.POSITIVE_INFINITY;
    for (let i = 0; i < kept.length; i++) {
      if (spareChapters && kept[i]!.kind === "chapter") continue;
      // How close a frame is to its neighbour: the one before it, or for the first, the one after.
      const g = i ? kept[i]!.time - kept[i - 1]!.time : kept[1]!.time - kept[0]!.time;
      if (g < gap) {
        gap = g;
        worst = i;
      }
    }
    kept.splice(worst, 1);
  }
  return kept;
}

export type FramesResult =
  | { ok: true; dir: string; markdown: string; frames: VideoFrame[]; candidates: number; duplicates: number; effort: FrameEffort }
  | { ok: false; reason: string };

interface Candidate {
  path: string;
  time: number;
  kind: FrameKind;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const fileStamp = (t: number) => formatStamp(t).replace(/:/g, "-");

/**
 * Extract the frames of a video already fetched into `runDir` (see
 * fetchVideoRun). Never throws: a missing tool or a failed download is a reason.
 */
export async function extractFrames(
  runDir: string,
  opts: {
    effort?: FrameEffort;
    deps?: Partial<VideoDeps>;
    signal?: AbortSignal;
    /** The video's URL, as the caller approved it; else the page the run was read from. */
    url?: string;
    /** Only the known video hosts, and never yt-dlp's catch-all extractor (an MCP policy). */
    knownHostsOnly?: boolean;
  } = {},
): Promise<FramesResult> {
  // JPEGs are binary files, and the no-write gate collects text: there is
  // nothing honest to print instead of them. Said first, since under it no
  // run was written for the check below to find either.
  if (isNoWrite()) return { ok: false, reason: "frames are image files, and nothing may be written (NO_WRITE)" };
  const run = readVideoRun(runDir);
  if (!run) return { ok: false, reason: `no video run in ${runDir} — fetch the video first` };
  const deps = videoDeps(opts.deps);
  if (!deps.have("ffmpeg")) return { ok: false, reason: "frames need ffmpeg" };
  const effort = opts.effort ?? "med";
  const { meta, segments } = run;
  // The page to download from: the caller's own URL when it has one — a
  // meta.json on disk is not something to trust with a download — else the
  // page the run was read from, under the same rules as any other URL.
  const source = videoSource(opts.url ?? meta.webpageUrl, { anySite: !opts.knownHostsOnly });
  if (!source) return { ok: false, reason: `the run in ${runDir} names no page this may download the video from` };
  const duration = meta.duration ?? 0;

  return withTempDir("frames", async (tmp) => {
    const dl = await downloadMedia(["-f", VIDEO_FORMAT, "--no-playlist"], tmp, "video", {
      run: deps.run,
      url: source.url,
      knownOnly: opts.knownHostsOnly,
      timeoutMs: FRAMES_TIMEOUT_MS,
      signal: opts.signal,
    });
    if (opts.signal?.aborted) return { ok: false, reason: "cancelled" };
    if ("error" in dl) return { ok: false, reason: `the video download failed: ${dl.error}` };
    const video = dl.file;
    const input = join(tmp, video);
    const ffmpeg = (args: string[]) => deps.run("ffmpeg", ["-nostdin", "-hide_banner", ...args], { timeoutMs: FRAMES_TIMEOUT_MS, signal: opts.signal });

    // 1. Scene changes, their timestamps read back from showinfo.
    const sceneDir = join(tmp, "scene");
    mkdirSync(sceneDir);
    const scenes = await ffmpeg([
      "-i",
      input,
      "-vf",
      `select='gt(scene,${SCENE_THRESHOLD})',showinfo,${JPEG_FILTER}`,
      "-fps_mode",
      "vfr",
      "-q:v",
      "3",
      join(sceneDir, "%04d.jpg"),
    ]);
    if (opts.signal?.aborted) return { ok: false, reason: "cancelled" };
    const times = parseShowinfo(scenes.stderr);
    const sceneFiles = readdirSync(sceneDir).sort();
    const candidates: Candidate[] = sceneFiles.slice(0, times.length).map((f, i) => ({ path: join(sceneDir, f), time: times[i]!, kind: "scene" }));

    // 2. One frame just after each chapter starts, and evenly spaced ones for a video with too few of either.
    const single = async (time: number, kind: FrameKind) => {
      const path = join(tmp, `${kind}-${candidates.length}.jpg`);
      await ffmpeg(["-loglevel", "error", "-ss", time.toFixed(2), "-i", input, "-frames:v", "1", "-vf", JPEG_FILTER, "-q:v", "3", "-y", path]);
      if (existsSync(path)) candidates.push({ path, time, kind });
    };
    const last = duration > 1 ? duration - 0.5 : Number.POSITIVE_INFINITY;
    for (const c of meta.chapters ?? []) await single(Math.min(c.start + 1, last), "chapter");
    if (candidates.length < MIN_FRAMES && duration > 0) {
      const n = Math.min(FRAME_EFFORT[effort], INTERVAL_FRAMES);
      for (let i = 0; i < n; i++) await single((duration * (i + 0.5)) / n, "interval");
    }
    if (opts.signal?.aborted) return { ok: false, reason: "cancelled" };
    if (!candidates.length)
      return { ok: false, reason: `ffmpeg took no frame from the video${scenes.ok ? "" : ` (${scenes.stderr.trim().split("\n").pop()})`}` };
    candidates.sort((a, b) => a.time - b.time);

    // 3. Near-duplicates out: one ffmpeg pass shrinks every candidate to 9×8 grey.
    const candDir = join(tmp, "cand");
    mkdirSync(candDir);
    candidates.forEach((c, i) => copyFileSync(c.path, join(candDir, `${String(i + 1).padStart(4, "0")}.jpg`)));
    const raw = join(tmp, "hash.raw");
    await ffmpeg(["-loglevel", "error", "-i", join(candDir, "%04d.jpg"), "-vf", "scale=9:8,format=gray", "-f", "rawvideo", "-y", raw]);
    const hashes = existsSync(raw) ? dhashStream(readFileSync(raw)) : [];
    const kept: (Candidate & { hash?: bigint })[] = [];
    for (const [i, c] of candidates.entries()) {
      const hash = hashes.length === candidates.length ? hashes[i] : undefined;
      if (hash !== undefined && kept.some((k) => k.hash !== undefined && hamming(k.hash, hash) <= DHASH_SAME)) continue;
      kept.push({ ...c, ...(hash !== undefined ? { hash } : {}) });
    }

    // 4. Capped, renamed by time, written beside the transcript. The new set is
    // laid out in the temp directory and swapped in whole, so a failure — or a
    // concurrent call on the same video — never leaves FRAMES.md pointing at
    // a half-replaced set.
    const chosen = capFrames(kept, FRAME_EFFORT[effort]);
    const staged = join(tmp, "frames");
    mkdirSync(staged);
    const placed = chosen.map((c, i) => {
      const file = `frames/${String(i + 1).padStart(4, "0")}_${fileStamp(c.time)}.jpg`;
      copyFileSync(c.path, join(tmp, file));
      return { file, time: c.time, kind: c.kind };
    });
    const frames = alignFrames(placed, segments, meta.chapters ?? []);
    const dropped = candidates.length - kept.length;
    const note = `${plural(frames.length, "frame")} (effort ${effort}: at most ${FRAME_EFFORT[effort]}) from ${plural(candidates.length, "candidate")} — scene changes above ${SCENE_THRESHOLD}, one per chapter start, ${plural(dropped, "near-duplicate")} dropped`;
    const framesDir = join(runDir, "frames");
    try {
      const incoming = `${framesDir}.${process.pid}.${Date.now()}.new`;
      cpSync(staged, incoming, { recursive: true });
      rmSync(framesDir, { recursive: true, force: true });
      renameSync(incoming, framesDir);
      writeArtifact(join(runDir, "frames.json"), `${JSON.stringify(frames, null, 2)}\n`);
      const markdown = writeArtifact(join(runDir, "FRAMES.md"), framesMarkdown(meta, frames, note));
      return { ok: true, dir: framesDir, markdown, frames, candidates: candidates.length, duplicates: dropped, effort };
    } catch (e) {
      return { ok: false, reason: `cannot write the frames in ${runDir}: ${(e as Error).message}` };
    }
  });
}
