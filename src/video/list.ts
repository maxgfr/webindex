import { join } from "node:path";
import { ensureDir, isNoWrite, writeArtifact } from "../no-write.js";
import { mapLimit } from "../pool.js";
import { videoDeps, type VideoDeps, type VideoLadderOptions } from "./ladder.js";
import { formatStamp } from "./markdown.js";
import { fetchVideoRun } from "./run.js";
import { knownVideo, youtubeListKind, youtubeVideoId } from "./url.js";
import { classifyYtdlpError, runYtdlp } from "./ytdlp.js";

// Several videos at once: a playlist or a channel listed without reading any
// of them (`--flat-playlist`), each video then kept as its own run, and a
// corpus file naming them V1…Vn — the labels an answer cites across videos.

const LIST_TIMEOUT_MS = 120_000;
const DEFAULT_LIMIT = 10;
// Two videos at a time: each is a couple of yt-dlp calls, and YouTube is
// quicker to refuse a client that opens many at once.
const CORPUS_CONCURRENCY = 2;

/** One video a listing names. */
export interface ListedVideo {
  /** The site's id for it. */
  id: string;
  /** Its run key, when its URL gives one (every YouTube video does). */
  key?: string;
  title: string;
  duration?: number;
  url: string;
}

/** The URL yt-dlp should list: a channel's own page lists its tabs, so a channel with no tab named gets `/videos`. */
function listingUrl(url: string): string {
  const u = new URL(url);
  if (youtubeListKind(url) === "channel" && /^\/(?:@[^/]+|(?:channel|c|user)\/[^/]+)\/?$/.test(u.pathname)) {
    u.pathname = `${u.pathname.replace(/\/$/, "")}/videos`;
  }
  return u.toString();
}

/**
 * The first `limit` videos of a playlist or channel, without reading any of
 * them. Never throws: a URL that names no list, or a refusal, is an error.
 */
export async function listVideos(
  url: string,
  opts: { limit?: number; deps?: Partial<VideoDeps>; signal?: AbortSignal; knownHostsOnly?: boolean } = {},
): Promise<{ title?: string; videos: ListedVideo[] } | { error: string }> {
  // YouTube's lists are recognised by their URL; on any other site the URL
  // is handed to yt-dlp as is, and its answer says whether it was a list.
  const u = /^https?:\/\//i.test(url) ? url : undefined;
  if (!u || (!youtubeListKind(url) && (opts.knownHostsOnly || knownVideo(url))))
    return { error: `not a playlist or channel URL${opts.knownHostsOnly ? " on YouTube" : ""}: ${url}` };
  const limit = Math.max(1, Math.trunc(opts.limit ?? DEFAULT_LIMIT));
  const r = await runYtdlp(["--flat-playlist", "-J", "--playlist-end", String(limit), "--no-warnings"], {
    run: videoDeps(opts.deps).run,
    url: listingUrl(url),
    timeoutMs: LIST_TIMEOUT_MS,
    signal: opts.signal,
  });
  if (r.missing) return { error: "install yt-dlp (https://github.com/yt-dlp/yt-dlp) to read videos" };
  if (!r.ok) return { error: classifyYtdlpError(r.stderr) };
  try {
    const info = JSON.parse(r.stdout) as { title?: string; entries?: Record<string, unknown>[] };
    const videos = (info.entries ?? []).flatMap((e): ListedVideo[] => {
      const id = typeof e.id === "string" ? e.id : "";
      // A channel tab or a nested playlist is not a video, whatever its id looks like.
      if (!id || e._type === "playlist") return [];
      const title = typeof e.title === "string" ? e.title : id;
      const duration = typeof e.duration === "number" ? { duration: e.duration } : {};
      if (e.ie_key === "Youtube" || (e.ie_key === undefined && youtubeListKind(url))) {
        const watch = `https://www.youtube.com/watch?v=${id}`;
        return youtubeVideoId(watch) ? [{ id, key: id, title, ...duration, url: watch }] : [];
      }
      const entryUrl = [e.url, e.webpage_url].find((v): v is string => typeof v === "string" && /^https?:\/\//i.test(v));
      if (!entryUrl) return [];
      const known = knownVideo(entryUrl);
      return [{ id, ...(known?.key ? { key: known.key } : {}), title, ...duration, url: entryUrl }];
    });
    // A playlist can hold one video twice: read once, labelled once.
    const unique = videos.filter((v, i) => videos.findIndex((w) => w.url === v.url) === i);
    return { ...(info.title ? { title: info.title } : {}), videos: unique.slice(0, limit) };
  } catch {
    return { error: "yt-dlp returned an unreadable listing" };
  }
}

/** One row of a corpus: V#, and the run it points at or why there is none. */
export interface CorpusVideo {
  label: string;
  id: string;
  title: string;
  duration?: number;
  via?: string;
  dir?: string;
  reused?: boolean;
  reason?: string;
}

export interface VideoCorpus {
  source: string;
  title?: string;
  createdAt: string;
  videos: CorpusVideo[];
}

export type CorpusResult = { ok: true; dir: string; corpus: string; videos: CorpusVideo[]; title?: string } | { ok: false; reason: string };

/** CORPUS.md: the V1…Vn table an answer cites from. */
export function corpusMarkdown(c: VideoCorpus, root: string): string {
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ");
  const rows = c.videos.map((v) =>
    [
      v.label,
      v.id,
      cell(v.title),
      v.duration !== undefined ? formatStamp(v.duration) : "",
      v.via ?? "—",
      v.dir ? `${v.id}/TRANSCRIPT.md` : cell(`not read: ${v.reason ?? "no transcript"}`),
    ].join(" | "),
  );
  const read = c.videos.filter((v) => v.dir).length;
  return [
    `# ${c.title ?? "Video corpus"}`,
    "",
    `- Source: ${c.source}`,
    `- Directory: ${root}`,
    `- ${read} of ${c.videos.length} videos read, ${c.createdAt}`,
    "",
    "| V# | id | title | duration | via | transcript |",
    "|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r} |`),
    "",
  ].join("\n");
}

/**
 * Read a playlist or channel into `root`: every listed video kept as its own
 * run (an existing one reused), then CORPUS.md and corpus.json naming them
 * V1…Vn in listing order. A video that cannot be read keeps its label, with
 * the reason, so the numbering never shifts under an answer.
 */
export async function fetchVideoCorpus(
  url: string,
  root: string,
  opts: VideoLadderOptions & { limit?: number; refresh?: boolean; onVideo?: (done: number, total: number, title: string) => void } = {},
): Promise<CorpusResult> {
  // A corpus is files other commands read back; with nothing written there is
  // nothing to cite V1…Vn from.
  if (isNoWrite()) return { ok: false, reason: "a corpus is kept on disk, and nothing may be written (NO_WRITE)" };
  const listed = await listVideos(url, { limit: opts.limit, deps: opts.deps, signal: opts.signal, knownHostsOnly: opts.knownHostsOnly });
  if ("error" in listed) return { ok: false, reason: listed.error };
  if (!listed.videos.length) return { ok: false, reason: `no videos listed at ${url}` };
  let done = 0;
  const videos = await mapLimit(listed.videos, CORPUS_CONCURRENCY, async (v, i): Promise<CorpusVideo> => {
    const r = await fetchVideoRun(v.url, root, { ...opts });
    // The video's own title: a flat listing may carry a machine-translated one.
    opts.onVideo?.(++done, listed.videos.length, r.ok ? r.meta.title : v.title);
    // `id` is the run's key — the directory CORPUS.md points at, and check resolves V# through.
    const base = {
      label: `V${i + 1}`,
      id: r.ok ? r.id : (v.key ?? v.id),
      title: r.ok ? r.meta.title : v.title,
      ...(v.duration !== undefined ? { duration: v.duration } : {}),
    };
    return r.ok
      ? { ...base, ...(r.meta.duration !== undefined ? { duration: r.meta.duration } : {}), via: r.meta.via, dir: r.dir, reused: r.reused }
      : { ...base, reason: r.reason };
  });
  const corpus: VideoCorpus = { source: url, ...(listed.title ? { title: listed.title } : {}), createdAt: new Date().toISOString(), videos };
  let path: string;
  try {
    ensureDir(root);
    writeArtifact(join(root, "corpus.json"), `${JSON.stringify(corpus, null, 2)}\n`);
    path = writeArtifact(join(root, "CORPUS.md"), corpusMarkdown(corpus, root));
  } catch (e) {
    return { ok: false, reason: `cannot write the corpus in ${root}: ${(e as Error).message}` };
  }
  return { ok: true, dir: root, corpus: path, videos, ...(listed.title ? { title: listed.title } : {}) };
}
