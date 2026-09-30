import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brand, env, envName } from "../brand.js";
import { shAsync, type ShResult } from "../exec.js";

// Everything that talks to yt-dlp.
//
// yt-dlp is the only piece of this engine that knows how to get past YouTube:
// the player responses, the signature puzzles, the tokens caption URLs
// increasingly need. So it is used for all of it — metadata, subtitles, audio,
// playlist listings — and webindex's own HTTP client never touches a video.
//
// Every command goes through a runner that tests replace, and every call ends
// with `<PREFIX>_YTDLP_ARGS`: the one escape hatch for cookies or a proxy
// (`--cookies-from-browser firefox`), split on whitespace.

/** Runs a command. The default is shAsync; tests inject their own. */
export type VideoRunner = (cmd: string, args: string[], opts?: { timeoutMs?: number; cwd?: string }) => Promise<ShResult>;

export const defaultVideoRunner: VideoRunner = (cmd, args, opts) => shAsync(cmd, args, opts);

const PROBE_TIMEOUT_MS = 120_000;
const SUBTITLE_TIMEOUT_MS = 120_000;

/** `<PREFIX>_YTDLP_ARGS`, split on whitespace. */
export function ytdlpExtraArgs(): string[] {
  return (env("YTDLP_ARGS") ?? "").split(/\s+/).filter(Boolean);
}

/** Run yt-dlp with the escape-hatch arguments appended. */
export function runYtdlp(args: string[], run: VideoRunner = defaultVideoRunner, timeoutMs = PROBE_TIMEOUT_MS): Promise<ShResult> {
  return run("yt-dlp", [...args, ...ytdlpExtraArgs()], { timeoutMs });
}

export interface VideoChapter {
  start: number;
  end: number;
  title: string;
}

/** What yt-dlp's `-J` says about one video, reduced to what a transcript needs. */
export interface VideoMeta {
  id: string;
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
}

/** The metadata, and the raw `-J` JSON later calls are fed with `--load-info-json`. */
export type VideoProbe = { meta: VideoMeta; info: string } | { error: string; missing?: boolean };

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Project yt-dlp's info JSON onto VideoMeta. Undefined when it is not a single video. */
export function videoMetaFromInfo(info: Record<string, unknown>): VideoMeta | undefined {
  const id = str(info.id);
  if (!id) return undefined;
  const date = str(info.upload_date);
  const tracks = (v: unknown) => (v && typeof v === "object" ? Object.keys(v as object).filter((k) => k !== "live_chat") : []);
  const duration = num(info.duration);
  const chapters = Array.isArray(info.chapters)
    ? (info.chapters as Record<string, unknown>[])
        .map((c) => ({ start: num(c.start_time) ?? 0, end: num(c.end_time) ?? duration ?? 0, title: str(c.title) ?? "" }))
        .filter((c) => c.title)
    : [];
  return {
    id,
    title: str(info.title) ?? id,
    channel: str(info.channel) ?? str(info.uploader),
    uploadDate: date && /^\d{8}$/.test(date) ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}` : undefined,
    duration,
    language: str(info.language),
    chapters,
    subtitles: tracks(info.subtitles),
    autoCaptions: tracks(info.automatic_captions),
    webpageUrl: str(info.webpage_url) ?? `https://www.youtube.com/watch?v=${id}`,
  };
}

/** Read one video's metadata. Never throws: a failure is a reason. */
export async function probeVideo(url: string, run: VideoRunner = defaultVideoRunner): Promise<VideoProbe> {
  const r = await runYtdlp(["-J", "--skip-download", "--no-playlist", "--no-warnings", url], run, PROBE_TIMEOUT_MS);
  if (r.missing) return { error: "install yt-dlp (https://github.com/yt-dlp/yt-dlp) to read videos", missing: true };
  if (!r.ok) return { error: classifyYtdlpError(r.stderr) };
  try {
    const meta = videoMetaFromInfo(JSON.parse(r.stdout) as Record<string, unknown>);
    return meta ? { meta, info: r.stdout } : { error: "yt-dlp returned no video for this URL" };
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
  if (/members[- ]only|join this channel/i.test(s)) return "members-only video";
  if (/confirm your age|age[- ]restricted|inappropriate for some users/i.test(s)) {
    return `age-restricted video — it needs a signed-in session: ${envName("YTDLP_ARGS")}="--cookies-from-browser firefox"`;
  }
  if (/not a bot|sign in to confirm|po[ _-]?token|HTTP Error 403/i.test(s)) return `YouTube refused yt-dlp — ${unblock}`;
  if (/has been removed|account .*terminated|no longer available|copyright claim/i.test(s)) return "video removed";
  if (/unavailable|not available/i.test(s)) return "video unavailable";
  if (/timed out after/i.test(s)) return "yt-dlp timed out";
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
        "vtt",
        "-o",
        join(dir, "sub.%(ext)s"),
      ],
      run,
      SUBTITLE_TIMEOUT_MS,
    );
    const file = readdirSync(dir).find((f) => f.endsWith(".vtt"));
    if (file) return { vtt: readFileSync(join(dir, file), "utf8") };
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
