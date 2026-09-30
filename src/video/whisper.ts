import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env, envInt, envName } from "../brand.js";
import type { VideoSegment } from "./vtt.js";
import { downloadMedia, withTempDir, type VideoRunner } from "./ytdlp.js";

// The last rung: transcribe the audio on this machine.
//
// yt-dlp fetches the audio, ffmpeg makes it the 16 kHz mono WAV whisper
// expects, and `uvx whisper-ctranslate2` (faster-whisper behind the openai
// whisper command line) writes JSON segments. No API and no key; the price is
// time — minutes for a long video on a laptop — and a model download the
// first time (`small` is about 500 MB).
//
// Hence the same two guards as OCR (see pdf/ocr.ts): a per-process budget,
// `<PREFIX>_WHISPER_MAX` videos (default 3), so one playlist cannot turn into
// an afternoon; and a ceiling on one video, `<PREFIX>_WHISPER_TIMEOUT_MS`
// (default 30 min).

const DEFAULT_MAX = 3;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_MODEL = "small";
const PYAV_PIN = "av<18";
// The best audio, never a DRM-protected format ffmpeg could not decode.
export const AUDIO_FORMAT = "bestaudio[has_drm!=?true]/best[has_drm!=?true]";

let spent = 0;

/** Test seam: refill the per-process whisper budget. */
export function resetWhisperBudget(): void {
  spent = 0;
}

/** Videos this process may still transcribe. */
export function whisperBudgetLeft(): number {
  return Math.max(0, envInt("WHISPER_MAX", DEFAULT_MAX) - spent);
}

/** The whisper model to ask for: `<PREFIX>_WHISPER_MODEL`, else `small`. */
export function whisperModel(): string {
  return env("WHISPER_MODEL") ?? DEFAULT_MODEL;
}

export type WhisperAttempt = { segments: VideoSegment[] } | { declined: "budget" } | { failed: string; unavailable?: boolean };

/** Read whisper's JSON output into segments. */
export function whisperSegments(json: string): VideoSegment[] {
  try {
    const parsed = JSON.parse(json) as { segments?: { start?: unknown; end?: unknown; text?: unknown }[] };
    return (parsed.segments ?? [])
      .map((s) => ({
        start: Number(s.start),
        end: Number(s.end),
        text: String(s.text ?? "")
          .replace(/\s+/g, " ")
          .trim(),
      }))
      .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.text);
  } catch {
    return [];
  }
}

/** The language whisper is told: a bare ISO 639 code, or nothing — whisper refuses `en-US` or `zh-Hans`, and detects by itself. */
export function whisperLanguage(tag: string | undefined): string | undefined {
  const base = tag?.toLowerCase().split(/[-_]/)[0];
  return base && /^[a-z]{2,3}$/.test(base) ? base : undefined;
}

/**
 * Transcribe one video with whisper. `info` is the probe's `-J` JSON, so the
 * audio download does not extract the page again. The caller has already
 * checked that uvx and ffmpeg exist. `<PREFIX>_WHISPER_TIMEOUT_MS` bounds the
 * whole of it — download, conversion and transcription together — and
 * `signal` stops whichever step is running.
 */
export async function whisperTranscribe(info: string, language: string | undefined, run: VideoRunner, signal?: AbortSignal): Promise<WhisperAttempt> {
  if (whisperBudgetLeft() <= 0) return { declined: "budget" };
  // Reserved before the first await, so concurrent videos cannot all pass the
  // check above; refunded below whenever no transcription was attempted.
  spent++;
  const refund = <T>(r: T): T => {
    spent = Math.max(0, spent - 1);
    return r;
  };
  const budgetMs = envInt("WHISPER_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 1000);
  const deadline = Date.now() + budgetMs;
  const left = () => Math.max(1000, deadline - Date.now());
  const timedOut = { failed: `whisper: timed out after ${Math.round(budgetMs / 60_000)} min (${envName("WHISPER_TIMEOUT_MS")})` };
  return withTempDir("whisper", async (dir) => {
    const infoPath = join(dir, "info.json");
    writeFileSync(infoPath, info);
    const dl = await downloadMedia(["--load-info-json", infoPath, "-f", AUDIO_FORMAT], dir, "audio", { run, timeoutMs: left, signal });
    if (signal?.aborted) return refund({ failed: "whisper: cancelled" });
    if ("timedOut" in dl) return timedOut;
    if ("error" in dl) return refund({ failed: `whisper: the audio download failed (${dl.error})` });
    const audio = dl.file;

    const wav = join(dir, "speech.wav");
    const ff = await run("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", join(dir, audio), "-ar", "16000", "-ac", "1", wav], {
      timeoutMs: left(),
      signal,
    });
    if (ff.missing) return refund({ failed: "whisper needs ffmpeg", unavailable: true });
    if (signal?.aborted) return refund({ failed: "whisper: cancelled" });
    if (ff.status === 124) return timedOut;
    if (!ff.ok || !existsSync(wav)) return refund({ failed: "whisper: ffmpeg could not convert the audio" });

    // PyAV 18 dropped the `metadata_errors` argument faster-whisper still
    // passes when it decodes audio, and uvx resolves the newest one: every
    // transcription then died on a TypeError. Pinned until faster-whisper follows.
    const args = ["--with", PYAV_PIN, "whisper-ctranslate2", wav, "--model", whisperModel(), "--output_format", "json", "--output_dir", dir];
    const lang = whisperLanguage(language);
    if (lang) args.push("--language", lang);
    const w = await run("uvx", args, { timeoutMs: left(), cwd: dir, signal });
    if (w.missing) return refund({ failed: "whisper needs uvx", unavailable: true });
    if (signal?.aborted) return { failed: "whisper: cancelled" };
    if (w.status === 124) return timedOut;
    const out = join(dir, "speech.json");
    if (!w.ok || !existsSync(out)) return { failed: `whisper: ${w.stderr.trim().split("\n").pop() || "failed"}` };
    return { segments: whisperSegments(readFileSync(out, "utf8")) };
  });
}
