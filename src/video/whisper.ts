import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env, envInt } from "../brand.js";
import type { VideoSegment } from "./vtt.js";
import { runYtdlp, withTempDir, type VideoRunner } from "./ytdlp.js";

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

/**
 * Transcribe one video with whisper. `info` is the probe's `-J` JSON, so the
 * audio download does not extract the page again. The caller has already
 * checked that uvx and ffmpeg exist.
 */
export async function whisperTranscribe(info: string, language: string | undefined, run: VideoRunner): Promise<WhisperAttempt> {
  if (whisperBudgetLeft() <= 0) return { declined: "budget" };
  spent++;
  const timeoutMs = envInt("WHISPER_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 1000);
  return withTempDir("whisper", async (dir) => {
    const infoPath = join(dir, "info.json");
    writeFileSync(infoPath, info);
    const dl = await runYtdlp(["--load-info-json", infoPath, "-f", "bestaudio/best", "--no-warnings", "-o", join(dir, "audio.%(ext)s")], run, timeoutMs);
    const audio = readdirSync(dir).find((f) => f.startsWith("audio.") && !f.endsWith(".part"));
    if (!audio) return { failed: `whisper: the audio download failed${dl.stderr ? ` (${dl.stderr.trim().split("\n").pop()})` : ""}` };

    const wav = join(dir, "speech.wav");
    const ff = await run("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", join(dir, audio), "-ar", "16000", "-ac", "1", wav], {
      timeoutMs,
    });
    if (ff.missing) return { failed: "whisper needs ffmpeg", unavailable: true };
    if (!ff.ok || !existsSync(wav)) return { failed: "whisper: ffmpeg could not convert the audio" };

    // PyAV 18 dropped the `metadata_errors` argument faster-whisper still
    // passes when it decodes audio, and uvx resolves the newest one: every
    // transcription then died on a TypeError. Pinned until faster-whisper follows.
    const args = ["--with", PYAV_PIN, "whisper-ctranslate2", wav, "--model", whisperModel(), "--output_format", "json", "--output_dir", dir];
    if (language) args.push("--language", language);
    const w = await run("uvx", args, { timeoutMs, cwd: dir });
    if (w.missing) return { failed: "whisper needs uvx", unavailable: true };
    const out = join(dir, "speech.json");
    if (!w.ok || !existsSync(out)) {
      const why = w.status === 124 ? `timed out after ${Math.round(timeoutMs / 60_000)} min` : (w.stderr.trim().split("\n").pop() ?? "failed");
      return { failed: `whisper: ${why}` };
    }
    return { segments: whisperSegments(readFileSync(out, "utf8")) };
  });
}
