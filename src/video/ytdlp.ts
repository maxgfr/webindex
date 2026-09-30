import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brand, env, envName } from "../brand.js";
import { shAsync, type ShResult } from "../exec.js";
import { videoRunKey } from "./url.js";

// Everything that talks to yt-dlp.
//
// yt-dlp is the only piece of this engine that knows how to get past YouTube:
// the player responses, the signature puzzles, the tokens caption URLs
// increasingly need. So it is used for all of it — metadata, subtitles, audio,
// playlist listings — and webindex's own HTTP client never touches a video.
//
// Every command goes through a runner that tests replace, and every call carries
// `<PREFIX>_YTDLP_ARGS`: the one escape hatch for cookies or a proxy
// (`--cookies-from-browser firefox`), split on whitespace. A URL always comes
// after `--`, so no string handed to this module is ever read as an option.

/** Runs a command. The default is shAsync; tests inject their own. */
export type VideoRunner = (cmd: string, args: string[], opts?: { timeoutMs?: number; cwd?: string; signal?: AbortSignal }) => Promise<ShResult>;

export const defaultVideoRunner: VideoRunner = (cmd, args, opts) => shAsync(cmd, args, opts);

const PROBE_TIMEOUT_MS = 120_000;
const SUBTITLE_TIMEOUT_MS = 120_000;

/** `<PREFIX>_YTDLP_ARGS`, split on whitespace. */
export function ytdlpExtraArgs(): string[] {
  return (env("YTDLP_ARGS") ?? "").split(/\s+/).filter(Boolean);
}

/** Run yt-dlp: its options, the escape-hatch arguments, then `--` and the URL when there is one. */
export function runYtdlp(
  args: string[],
  opts: { run?: VideoRunner; timeoutMs?: number; url?: string; signal?: AbortSignal; knownOnly?: boolean } = {},
): Promise<ShResult> {
  // `knownOnly`: yt-dlp's own extractors and never its catch-all "generic"
  // one, which fetches whatever URL a page (a tweet's player card, a redirect)
  // names — private addresses included, out of any public-address check.
  const strict = opts.knownOnly ? ["--use-extractors", "default,-generic"] : [];
  const argv = [...strict, ...args, ...ytdlpExtraArgs(), ...(opts.url ? ["--", opts.url] : [])];
  return (opts.run ?? defaultVideoRunner)("yt-dlp", argv, { timeoutMs: opts.timeoutMs ?? PROBE_TIMEOUT_MS, signal: opts.signal });
}

export interface VideoChapter {
  start: number;
  end: number;
  title: string;
}

/** What yt-dlp's `-J` says about one video, reduced to what a transcript needs. */
export interface VideoMeta {
  /** The site's own id for the video. */
  id: string;
  /** `youtube`, `vimeo`, `dailymotion`… — from yt-dlp's extractor. Absent in runs written before other sites were read: YouTube. */
  site?: string;
  /** The run directory's name: the YouTube id itself, else `<site>-<id>`. */
  key?: string;
  title: string;
  channel?: string;
  /** YYYY-MM-DD. */
  uploadDate?: string;
  /** Seconds. */
  duration?: number;
  /** The video's own language, when YouTube knows it (`en`, `fr`…). */
  language?: string;
  chapters: VideoChapter[];
  /** Languages with manual subtitles. */
  subtitles: string[];
  /** Languages with auto-captions — the original (`<lang>-orig`) and YouTube's machine translations. */
  autoCaptions: string[];
  webpageUrl: string;
  /** A stream that is on air now, or scheduled: there is nothing whole to transcribe yet. */
  live?: "live" | "upcoming";
}

/** The metadata, and the raw `-J` JSON later calls are fed with `--load-info-json`. */
export type VideoProbe = { meta: VideoMeta; info: string } | { error: string; missing?: boolean };

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
// Only an http(s) URL is ever handed back to yt-dlp (frames, whisper): a site's
// own metadata must not be able to smuggle in anything else.
const httpUrl = (v: string | undefined) => (v && /^https?:\/\//i.test(v) ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * The short site name of a yt-dlp extractor — the prefix knownVideo uses, so a
 * run's key is the same whether it came from the URL or from the probe:
 * "YoutubeTab" → youtube, "TwitchVod" → twitch, "Twitter" → x, "TedTalk" →
 * ted, "Generic" → web.
 */
export function siteOf(extractor: string): string {
  const e = extractor
    .toLowerCase()
    .split(":")[0]!
    .replace(/[^a-z0-9]/g, "");
  const known: [string, string][] = [
    ["youtube", "youtube"],
    ["vimeo", "vimeo"],
    ["dailymotion", "dailymotion"],
    ["twitch", "twitch"],
    ["twitter", "x"],
    ["ted", "ted"],
    ["loom", "loom"],
    ["tiktok", "tiktok"],
    ["instagram", "instagram"],
    ["facebook", "facebook"],
    ["bilibili", "bilibili"],
    ["rumble", "rumble"],
    ["peertube", "peertube"],
  ];
  if (!e || e === "generic") return "web";
  return known.find(([prefix]) => e.startsWith(prefix))?.[1] ?? e;
}

/** Project yt-dlp's info JSON onto VideoMeta. Undefined when it is not a single video. */
export function videoMetaFromInfo(info: Record<string, unknown>, sourceUrl?: string): VideoMeta | undefined {
  const id = str(info.id);
  if (!id) return undefined;
  const site = siteOf(str(info.extractor_key) ?? str(info.extractor) ?? "youtube");
  const webpageUrl = httpUrl(str(info.webpage_url)) ?? httpUrl(str(info.original_url)) ?? httpUrl(sourceUrl) ?? `https://www.youtube.com/watch?v=${id}`;
  const date = str(info.upload_date);
  const tracks = (v: unknown) => (v && typeof v === "object" ? Object.keys(v as object).filter((k) => k !== "live_chat") : []);
  const duration = num(info.duration);
  const chapters = Array.isArray(info.chapters)
    ? (info.chapters as Record<string, unknown>[])
        // yt-dlp names an untitled chapter "<Untitled Chapter 1>", which a
        // Markdown heading would carry as a stray HTML tag.
        .map((c) => ({
          start: num(c.start_time) ?? 0,
          end: num(c.end_time) ?? duration ?? 0,
          title: (str(c.title) ?? "").replace(/^<Untitled Chapter (\d+)>$/, "Chapter $1"),
        }))
        .filter((c) => c.title)
    : [];
  return {
    id,
    site,
    key: videoRunKey(site, id, webpageUrl),
    title: str(info.title) ?? id,
    channel: str(info.channel) ?? str(info.uploader),
    uploadDate: date && /^\d{8}$/.test(date) ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}` : undefined,
    duration,
    language: str(info.language),
    chapters,
    subtitles: tracks(info.subtitles),
    autoCaptions: tracks(info.automatic_captions),
    webpageUrl,
    ...(info.live_status === "is_live" || info.is_live === true ? { live: "live" as const } : {}),
    ...(info.live_status === "is_upcoming" ? { live: "upcoming" as const } : {}),
  };
}

/** Read one video's metadata. Never throws: a failure is a reason. */
export async function probeVideo(url: string, run: VideoRunner = defaultVideoRunner, signal?: AbortSignal, knownOnly = false): Promise<VideoProbe> {
  const r = await runYtdlp(["-J", "--skip-download", "--no-playlist", "--no-warnings"], { run, url, signal, knownOnly });
  if (signal?.aborted) return { error: "cancelled" };
  if (r.missing) return { error: "install yt-dlp (https://github.com/yt-dlp/yt-dlp) to read videos", missing: true };
  if (!r.ok) return { error: classifyYtdlpError(r.stderr) };
  try {
    const parsed = JSON.parse(r.stdout) as Record<string, unknown> | null;
    // A page holding several videos (a playlist, an archive item) is a list, not a video.
    if (parsed?._type === "playlist") return { error: "a list of videos, not one — read it with `video list`" };
    const meta = parsed ? videoMetaFromInfo(parsed, url) : undefined;
    return meta ? { meta, info: r.stdout } : { error: "no video at this URL (yt-dlp found none)" };
  } catch {
    return { error: "yt-dlp returned unreadable metadata" };
  }
}

/**
 * yt-dlp's failure, said the way a reader can act on it. The order matters:
 * YouTube's own wording names the most specific cause, and a 403 is the least
 * specific of them.
 */
export function classifyYtdlpError(stderr: string): string {
  const s = stderr || "";
  const unblock = `update yt-dlp (\`${brand().cli} doctor\` shows how old it is) or set ${envName("YTDLP_ARGS")}="--cookies-from-browser firefox"`;
  if (/private video/i.test(s)) return "private video";
  if (/logged-in|log(?:ged)? ?in (?:is )?required|login required|requires? (?:a )?login|--username and --password|account credentials/i.test(s)) {
    return `the site asks yt-dlp to log in — ${envName("YTDLP_ARGS")}="--cookies-from-browser firefox" passes your browser's session`;
  }
  if (/members[- ]only|join this channel/i.test(s)) return "members-only video";
  if (/confirm your age|age[- ]restricted|inappropriate for some users/i.test(s)) {
    return `age-restricted video — it needs a signed-in session: ${envName("YTDLP_ARGS")}="--cookies-from-browser firefox"`;
  }
  if (/not a bot|sign in to confirm|po[ _-]?token|HTTP Error 403/i.test(s)) return `YouTube refused yt-dlp — ${unblock}`;
  if (/has been removed|account .*terminated|no longer available|copyright claim/i.test(s)) return "video removed";
  if (/unavailable|not available/i.test(s)) return "video unavailable";
  if (/timed out after/i.test(s)) return "yt-dlp timed out";
  if (/DRM protected/i.test(s)) return "the site serves this video under DRM: its picture and sound cannot be downloaded (subtitles still can)";
  if (/unsupported url|no video (?:formats|could be found)|no media found|there's no video/i.test(s)) return "no video at this URL (yt-dlp found none)";
  const line = s
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("ERROR:"));
  return `yt-dlp failed: ${(line ?? s.trim().split("\n")[0] ?? "").replace(/^ERROR:\s*/, "").slice(0, 200) || "no output"}`;
}

/** A temp directory for one yt-dlp call, removed whatever happens inside. */
export async function withTempDir<T>(label: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), `${brand().name}-${label}-`));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * One subtitle track, as WebVTT text. Fed the probe's own JSON through
 * `--load-info-json`, so the page is not extracted a second time.
 */
export async function downloadSubtitle(
  info: string,
  lang: string,
  auto: boolean,
  run: VideoRunner = defaultVideoRunner,
  signal?: AbortSignal,
  knownOnly = false,
): Promise<{ vtt: string } | { error: string }> {
  return withTempDir("subs", async (dir) => {
    const infoPath = join(dir, "info.json");
    writeFileSync(infoPath, info);
    const r = await runYtdlp(
      [
        "--load-info-json",
        infoPath,
        "--skip-download",
        "--no-warnings",
        auto ? "--write-auto-subs" : "--write-subs",
        "--sub-langs",
        lang,
        "--sub-format",
        "vtt/srt",
        "-o",
        join(dir, "sub.%(ext)s"),
      ],
      { run, timeoutMs: SUBTITLE_TIMEOUT_MS, signal, knownOnly },
    );
    // WebVTT where the site has it, SRT otherwise (Dailymotion serves only SRT).
    const file = readdirSync(dir).find((f) => f.endsWith(".vtt")) ?? readdirSync(dir).find((f) => f.endsWith(".srt"));
    if (file) return { vtt: readFileSync(join(dir, file), "utf8") };
    if (signal?.aborted) return { error: "cancelled" };
    return { error: r.ok ? `yt-dlp wrote no ${lang} track` : classifyYtdlpError(r.stderr) };
  });
}

/** yt-dlp's version, and how many days old that release is. Undefined when it is not installed. */
export async function ytdlpVersionAge(run: VideoRunner = defaultVideoRunner, now = Date.now()): Promise<{ version: string; ageDays?: number } | undefined> {
  const r = await run("yt-dlp", ["--version"], { timeoutMs: 20_000 });
  if (!r.ok) return undefined;
  const version = r.stdout.trim().split("\n")[0] ?? "";
  const m = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(version);
  if (!m) return { version };
  const released = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return { version, ageDays: Math.max(0, Math.floor((now - released) / 86_400_000)) };
}

/**
 * Download one media file with yt-dlp into `dir` as `<stem>.<ext>`: the file's
 * name, or why there is none. Tried twice — YouTube answers a media request
 * with a stray 403 often enough that one retry turns most failures into a
 * download — but never after a timeout or a cancellation.
 */
export async function downloadMedia(
  args: string[],
  dir: string,
  stem: string,
  opts: { run?: VideoRunner; url?: string; timeoutMs: number | (() => number); signal?: AbortSignal; knownOnly?: boolean },
): Promise<{ file: string } | { error: string; timedOut?: boolean }> {
  let stderr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const timeoutMs = typeof opts.timeoutMs === "function" ? opts.timeoutMs() : opts.timeoutMs;
    const r = await runYtdlp([...args, "--no-warnings", "-o", join(dir, `${stem}.%(ext)s`)], {
      run: opts.run,
      url: opts.url,
      timeoutMs,
      signal: opts.signal,
      knownOnly: opts.knownOnly,
    });
    // Judged on the exit status first: a download killed half-way leaves
    // fragments behind (`.part`, `.part-Frag7`, `.ytdl`, `.f136.mp4`) that are
    // not the file, and reading one would transcribe half a video.
    if (opts.signal?.aborted) return { error: "cancelled" };
    if (r.status === 124) return { error: "timed out", timedOut: true };
    const file = r.ok ? readdirSync(dir).find((f) => f.startsWith(`${stem}.`) && !/\.part(?:-Frag\d+)?$|\.ytdl$|\.f\d+\.\w+$/.test(f)) : undefined;
    if (file) return { file };
    stderr = r.ok ? "yt-dlp wrote no file" : r.stderr;
  }
  return { error: classifyYtdlpError(stderr) };
}
