import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { brand, env } from "../brand.js";
import { ensureDir, isNoWrite, writeArtifact } from "../no-write.js";
import { bm25Score, buildBm25Index, type Bm25Doc } from "../rank.js";
import { transcribeVideo, type VideoLadderOptions, type VideoTranscriberId, type VideoTranscript } from "./ladder.js";
import { formatStamp, transcriptMarkdown } from "./markdown.js";
import { youtubeVideoId } from "./url.js";
import type { VideoSegment } from "./vtt.js";
import type { VideoChapter, VideoMeta } from "./ytdlp.js";

// A video read once and kept: `<root>/<videoId>/` holds the transcript as
// Markdown (TRANSCRIPT.md, what a reader opens), its segments (segments.json,
// what search and citation checks read) and its metadata (meta.json).
//
// The directory IS the cache. Asking about a video already read costs no
// yt-dlp call at all — which is the point: a question about a talk should not
// re-download its subtitles, let alone transcribe it again with whisper.

/** Where video runs live: `--out`, else `<PREFIX>_VIDEO_DIR`, else `<tmp>/<brand>/video`. */
export function videoRoot(out?: string): string {
  return resolve(out ?? env("VIDEO_DIR") ?? join(tmpdir(), brand().name, "video"));
}

/** meta.json: the video's metadata plus how and when its transcript was made. */
export interface VideoRunMeta extends VideoMeta {
  via: VideoTranscriberId;
  /** The subtitle track read (`en`, `fr`, `en-orig`); absent for whisper. */
  track?: string;
  /** The language the caller asked for, when it asked. */
  lang?: string;
  fetchedAt: string;
}

export type VideoRunResult =
  | {
      ok: true;
      id: string;
      dir: string;
      transcript: string;
      reused: boolean;
      meta: VideoRunMeta;
      segments: number;
      /** The transcript itself, when nothing was written (NO_WRITE): `transcript` then names a file that does not exist. */
      markdown?: string;
    }
  | { ok: false; id?: string; reason: string };

const baseLang = (tag: string) =>
  tag
    .toLowerCase()
    .replace(/-orig$/, "")
    .split(/[-_]/)[0];

/** Whether a kept run answers a request for `lang`: any run when none is asked, else one read in that language. */
function servesLang(meta: VideoRunMeta, lang: string | undefined): boolean {
  if (!lang) return true;
  const read = meta.track ?? meta.lang ?? meta.language;
  return read !== undefined && baseLang(read) === baseLang(lang);
}

const readJson = <T>(path: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
};

/** A run already on disk: its metadata and segments, or undefined when either is missing or unreadable. */
export function readVideoRun(dir: string): { meta: VideoRunMeta; segments: VideoSegment[] } | undefined {
  const meta = readJson<VideoRunMeta>(join(dir, "meta.json"));
  const segments = readJson<VideoSegment[]>(join(dir, "segments.json"));
  if (!meta?.id || !Array.isArray(segments)) return undefined;
  return { meta, segments };
}

/**
 * Read a video into `<root>/<videoId>/`, or reuse the run already there —
 * unless `refresh`, or the run was read in another language than `lang` asks.
 * Never throws: a video with no transcript, or a run that cannot be written,
 * comes back as a reason.
 *
 * meta.json is written last, so a run cut short is never taken for a whole
 * one. Under NO_WRITE nothing is written, and nothing is collected either —
 * the transcript comes back in `markdown`: a long-lived MCP server would
 * otherwise keep every transcript it ever read in memory.
 */
export async function fetchVideoRun(url: string, root: string, opts: VideoLadderOptions & { refresh?: boolean } = {}): Promise<VideoRunResult> {
  const id = youtubeVideoId(url);
  if (!id) return { ok: false, reason: `not a YouTube video URL: ${url}` };
  const dir = join(root, id);
  const transcriptPath = join(dir, "TRANSCRIPT.md");
  if (!opts.refresh) {
    const kept = readVideoRun(dir);
    if (kept && existsSync(transcriptPath) && servesLang(kept.meta, opts.lang))
      return { ok: true, id, dir, transcript: transcriptPath, reused: true, meta: kept.meta, segments: kept.segments.length };
  }
  const t: VideoTranscript = await transcribeVideo(url, opts);
  if (!t.via || !t.meta) return { ok: false, id, reason: t.reason ?? "no transcript" };
  const meta: VideoRunMeta = {
    ...t.meta,
    via: t.via,
    ...(t.track ? { track: t.track } : {}),
    ...(opts.lang ? { lang: opts.lang } : {}),
    fetchedAt: new Date().toISOString(),
  };
  const markdown = transcriptMarkdown(t);
  const done = { ok: true as const, id, dir, transcript: transcriptPath, reused: false, meta, segments: t.segments.length };
  if (isNoWrite()) return { ...done, markdown };
  try {
    ensureDir(dir);
    writeArtifact(join(dir, "segments.json"), `${JSON.stringify(t.segments, null, 1)}\n`);
    writeArtifact(transcriptPath, markdown);
    writeArtifact(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  } catch (e) {
    return { ok: false, id, reason: `cannot write the run in ${dir}: ${(e as Error).message}` };
  }
  return done;
}

/** One passage a search found: where it is, a link that opens the video there, and its text. */
export interface VideoHit {
  /** `V1`… when the directory is a corpus, else the video id. */
  label: string;
  videoId: string;
  title: string;
  chapter?: string;
  start: number;
  stamp: string;
  url: string;
  text: string;
  score: number;
}

const PASSAGE_S = 45;

/** Consecutive segments grouped into passages of about 45 s — the unit a search returns — never across a chapter start. */
export function videoPassages(segments: VideoSegment[], chapterStarts: number[] = []): VideoSegment[] {
  const out: VideoSegment[] = [];
  let cur: VideoSegment | undefined;
  for (const s of segments) {
    if (cur && chapterStarts.some((b) => b > cur!.start + 0.5 && b <= s.start + 0.5)) {
      out.push(cur);
      cur = undefined;
    }
    cur = cur ? { start: cur.start, end: s.end, text: `${cur.text} ${s.text}` } : { ...s };
    if (cur.end - cur.start >= PASSAGE_S) {
      out.push(cur);
      cur = undefined;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** The watch URL opened at `seconds`. */
export function videoUrlAt(webpageUrl: string, seconds: number): string {
  try {
    const u = new URL(webpageUrl);
    u.searchParams.set("t", `${Math.floor(seconds)}s`);
    return u.toString();
  } catch {
    return webpageUrl;
  }
}

/** The runs under a directory, in a stable order: the directory itself when it is one run, else its children that are. */
export function listVideoRuns(dir: string): { dir: string; meta: VideoRunMeta; segments: VideoSegment[] }[] {
  const self = readVideoRun(dir);
  if (self) return [{ dir, ...self }];
  let names: string[] = [];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const child = join(dir, name);
    try {
      if (!statSync(child).isDirectory()) return [];
    } catch {
      return [];
    }
    const run = readVideoRun(child);
    return run ? [{ dir: child, ...run }] : [];
  });
}

/** A corpus directory's V# labels (from its corpus.json), keyed by video id; empty for any other directory. */
export function corpusLabels(dir: string): Map<string, string> {
  const c = readJson<{ videos?: { label?: unknown; id?: unknown }[] }>(join(dir, "corpus.json"));
  const out = new Map<string, string>();
  for (const v of c?.videos ?? []) if (typeof v.id === "string" && typeof v.label === "string") out.set(v.id, v.label);
  return out;
}

const chapterAt = (chapters: VideoChapter[], t: number) => [...chapters].reverse().find((c) => c.start <= t + 0.5)?.title;

/**
 * Search the transcripts under `dir` — one run, or every run in it — for a
 * question: ~45 s passages ranked by BM25F, chapter titles weighted as
 * headings. Each hit is labelled with its video's V# when `dir` is a corpus
 * (see fetchVideoCorpus), or `labels` says so; with its id otherwise.
 */
export function searchVideoRuns(dir: string, query: string, opts: { limit?: number; labels?: Map<string, string> } = {}): VideoHit[] {
  const labels = opts.labels ?? corpusLabels(dir);
  const docs: (Bm25Doc & { hit: Omit<VideoHit, "score"> })[] = [];
  for (const run of listVideoRuns(dir)) {
    const { meta } = run;
    for (const p of videoPassages(
      run.segments,
      (meta.chapters ?? []).map((c) => c.start),
    )) {
      const chapter = chapterAt(meta.chapters ?? [], p.start);
      docs.push({
        id: `${meta.id}@${p.start}`,
        title: "",
        headings: chapter ?? "",
        body: p.text,
        hit: {
          label: labels.get(meta.id) ?? meta.id,
          videoId: meta.id,
          title: meta.title,
          ...(chapter ? { chapter } : {}),
          start: p.start,
          stamp: formatStamp(p.start),
          url: videoUrlAt(meta.webpageUrl, p.start),
          text: p.text,
        },
      });
    }
  }
  const index = buildBm25Index(query, docs);
  return docs
    .map((d) => ({ ...d.hit, score: Math.round(bm25Score(index, d) * 1000) / 1000 }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score || a.videoId.localeCompare(b.videoId) || a.start - b.start)
    .slice(0, opts.limit ?? 10);
}
