import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { brand, env } from "../brand.js";
import { ensureDir, isNoWrite, writeArtifact } from "../no-write.js";
import { bm25Score, buildBm25Index, type Bm25Doc } from "../rank.js";
import { transcribeVideo, videoDeps, type VideoLadderOptions, type VideoTranscriberId, type VideoTranscript } from "./ladder.js";
import { formatStamp, transcriptMarkdown } from "./markdown.js";
import { videoSource, videoUrlAt } from "./url.js";
import type { VideoSegment } from "./vtt.js";
import { probeVideo, type VideoChapter, type VideoMeta } from "./ytdlp.js";

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
 * Read a video into `<root>/<key>/` — the YouTube id, else `<site>-<id>` —
 * or reuse the run already there —
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
  const source = videoSource(url, { anySite: !opts.knownHostsOnly });
  if (!source) return { ok: false, reason: `not a video URL${opts.knownHostsOnly ? " on a known video host" : ""}: ${url}` };
  const kept = (key: string): VideoRunResult | undefined => {
    const dir = join(root, key);
    const run = opts.refresh ? undefined : readVideoRun(dir);
    if (!run || !existsSync(join(dir, "TRANSCRIPT.md")) || !servesLang(run.meta, opts.lang)) return undefined;
    return { ok: true, id: key, dir, transcript: join(dir, "TRANSCRIPT.md"), reused: true, meta: run.meta, segments: run.segments.length };
  };
  // A known host's URL names its run: no yt-dlp at all for a video already read.
  if (source.key) {
    const reused = kept(source.key);
    if (reused) return reused;
  }
  // Any other page is probed first — once, the ladder reuses the probe — to learn its key.
  let probed: VideoLadderOptions["probed"];
  if (!source.key) {
    const probe = await probeVideo(source.url, videoDeps(opts.deps).run, opts.signal, opts.knownHostsOnly);
    if ("error" in probe) return { ok: false, reason: probe.error };
    const reused = kept(probe.meta.key ?? probe.meta.id);
    if (reused) return reused;
    probed = probe;
  }
  const t: VideoTranscript = await transcribeVideo(url, { ...opts, ...(probed ? { probed } : {}) });
  // Written where the next lookup will look: the URL's own key when it has one.
  const id = source.key ?? t.meta?.key ?? t.meta?.id;
  if (!t.via || !t.meta || !id) return { ok: false, ...(id ? { id } : {}), reason: t.reason ?? "no transcript" };
  const dir = join(root, id);
  const transcriptPath = join(dir, "TRANSCRIPT.md");
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
  /** `V1`… when the directory is a corpus, else the run key. */
  label: string;
  /** The run key: the YouTube id, else `<site>-<id>`. */
  videoId: string;
  title: string;
  chapter?: string;
  /** Where the words that answer begin: the passage's best-matching segment, not the passage's own start. */
  start: number;
  stamp: string;
  url: string;
  /** The whole passage, for context. */
  text: string;
  score: number;
}

const PASSAGE_S = 45;

/** Consecutive segments grouped into passages of about 45 s — the unit a search returns — never across a chapter start. */
export function videoPassages(segments: VideoSegment[], chapterStarts: number[] = []): VideoSegment[] {
  return passageGroups(segments, chapterStarts).map((g) => ({ start: g[0]!.start, end: g[g.length - 1]!.end, text: g.map((s) => s.text).join(" ") }));
}

/** The segments of each passage, kept apart so a hit can point at the one that answers. */
function passageGroups(segments: VideoSegment[], chapterStarts: number[]): VideoSegment[][] {
  const out: VideoSegment[][] = [];
  let cur: VideoSegment[] = [];
  for (const s of segments) {
    if (cur.length && chapterStarts.some((b) => b > cur[0]!.start + 0.5 && b <= s.start + 0.5)) {
      out.push(cur);
      cur = [];
    }
    cur.push(s);
    if (s.end - cur[0]!.start >= PASSAGE_S) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

export { videoUrlAt };

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
  const docs: (Bm25Doc & { parts: VideoSegment[]; meta: VideoRunMeta; key: string; chapter?: string })[] = [];
  for (const run of listVideoRuns(dir)) {
    const { meta } = run;
    const key = meta.key ?? meta.id;
    for (const parts of passageGroups(
      run.segments,
      (meta.chapters ?? []).map((c) => c.start),
    )) {
      const chapter = chapterAt(meta.chapters ?? [], parts[0]!.start);
      docs.push({ id: `${key}@${parts[0]!.start}`, title: "", headings: chapter ?? "", body: parts.map((s) => s.text).join(" "), parts, meta, key, chapter });
    }
  }
  const index = buildBm25Index(query, docs);
  const scored = docs
    .map((d) => ({ d, score: Math.round(bm25Score(index, d) * 1000) / 1000 }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.d.key.localeCompare(b.d.key) || a.d.parts[0]!.start - b.d.parts[0]!.start)
    .slice(0, opts.limit ?? 10);
  return scored.map(({ d, score }) => {
    // The stamp a reader cites: the segment inside the passage that matches
    // best, not a passage start up to 45 s before the words that answer.
    let best = d.parts[0]!;
    let top = 0;
    for (const s of d.parts) {
      const sc = bm25Score(index, { id: `${d.id}#${s.start}`, title: "", headings: "", body: s.text });
      if (sc > top) {
        top = sc;
        best = s;
      }
    }
    return {
      label: labels.get(d.key) ?? d.key,
      videoId: d.key,
      title: d.meta.title,
      ...(d.chapter ? { chapter: d.chapter } : {}),
      start: best.start,
      stamp: formatStamp(best.start),
      url: videoUrlAt(d.meta.webpageUrl, best.start),
      text: d.body,
      score,
    };
  });
}
