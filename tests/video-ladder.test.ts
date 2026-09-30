import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShResult } from "../src/exec.js";
import {
  assessTranscript,
  classifyYtdlpError,
  enabledTranscribers,
  resetVideoLadderCache,
  transcribeVideo,
  videoMetaFromInfo,
  ytdlpVersionAge,
  type VideoMeta,
  type VideoRunner,
} from "../src/video.js";
import { pickAutoTrack, pickManualTrack } from "../src/video/ladder.js";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", "video", name), "utf8");
const INFO = JSON.parse(fixture("ted-info.json")) as Record<string, unknown>;
const URL = "https://www.youtube.com/watch?v=iG9CE55wbtY";

const ok = (stdout = ""): ShResult => ({ ok: true, status: 0, stdout, stderr: "" });
const fail = (stderr: string, status = 1): ShResult => ({ ok: false, status, stdout: "", stderr });
const missing: ShResult = { ok: false, status: 127, stdout: "", stderr: "spawn ENOENT", missing: true };

// Wherever `-o <template>` points, a runner can drop the file yt-dlp would have written.
const outDir = (args: string[]) => {
  const o = args[args.indexOf("-o") + 1]!;
  return o.slice(0, o.lastIndexOf("/"));
};

interface Script {
  info?: Record<string, unknown>;
  probe?: ShResult;
  /** Track name → VTT text, for --write-subs / --write-auto-subs. */
  manual?: Record<string, string>;
  auto?: Record<string, string>;
  whisper?: { start: number; end: number; text: string }[];
}

function runner(script: Script, calls: string[][] = []): VideoRunner {
  return async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "yt-dlp" && args.includes("-J")) return script.probe ?? ok(JSON.stringify(script.info ?? INFO));
    if (cmd === "yt-dlp" && (args.includes("--write-subs") || args.includes("--write-auto-subs"))) {
      const lang = args[args.indexOf("--sub-langs") + 1]!;
      const vtt = (args.includes("--write-subs") ? script.manual : script.auto)?.[lang];
      if (vtt) writeFileSync(join(outDir(args), `sub.${lang}.vtt`), vtt);
      return ok();
    }
    if (cmd === "yt-dlp" && args.includes("bestaudio/best")) {
      writeFileSync(join(outDir(args), "audio.webm"), "audio");
      return ok();
    }
    if (cmd === "ffmpeg") {
      writeFileSync(args[args.length - 1]!, "wav");
      return ok();
    }
    if (cmd === "uvx") {
      const dir = args[args.indexOf("--output_dir") + 1]!;
      if (script.whisper) writeFileSync(join(dir, "speech.json"), JSON.stringify({ segments: script.whisper }));
      return script.whisper ? ok() : fail("model failed");
    }
    return fail(`unexpected ${cmd}`);
  };
}

const haveAll = () => true;
const haveNone = () => false;

// Talk enough to pass the gate on a 20-minute video: 5 words a minute is 100 words.
const talk = (n: number) => Array.from({ length: n }, (_, i) => ({ start: i * 10, end: i * 10 + 9, text: `sentence number ${i} says several words here.` }));

beforeEach(() => resetVideoLadderCache());
afterEach(() => {
  delete process.env.WEBINDEX_TEST_VIDEO_ENGINES;
  delete process.env.WEBINDEX_TEST_WHISPER_MAX;
  delete process.env.WEBINDEX_TEST_YTDLP_ARGS;
});

describe("videoMetaFromInfo", () => {
  it("projects yt-dlp's -J onto VideoMeta", () => {
    const meta = videoMetaFromInfo(INFO)!;
    expect(meta).toMatchObject({
      id: "iG9CE55wbtY",
      channel: "TED",
      uploadDate: "2007-01-07",
      duration: 1203,
      language: "en",
      webpageUrl: URL,
      subtitles: ["en", "fr", "de"],
    });
    expect(meta.autoCaptions).toContain("en-orig");
    expect(meta.chapters[0]).toEqual({ start: 0, end: 42, title: "Introduction" });
  });

  it("drops the live-chat pseudo track and refuses an entry with no id", () => {
    expect(videoMetaFromInfo({ id: "abc", subtitles: { live_chat: [], en: [] } })!.subtitles).toEqual(["en"]);
    expect(videoMetaFromInfo({ title: "x" })).toBeUndefined();
  });
});

describe("track choice", () => {
  const meta = (over: Partial<VideoMeta>): VideoMeta => ({ id: "x", title: "t", chapters: [], subtitles: [], autoCaptions: [], webpageUrl: "u", ...over });

  it("prefers the requested language, then the video's, then English, then the first", () => {
    expect(pickManualTrack(meta({ subtitles: ["de", "fr", "en"], language: "de" }), "fr")).toBe("fr");
    expect(pickManualTrack(meta({ subtitles: ["de", "fr", "en"], language: "de" }))).toBe("de");
    expect(pickManualTrack(meta({ subtitles: ["de", "en-GB"] }))).toBe("en-GB");
    expect(pickManualTrack(meta({ subtitles: ["ja", "ko"] }))).toBe("ja");
    expect(pickManualTrack(meta({ subtitles: [] }))).toBeUndefined();
  });

  it("takes the original auto-captions, never a machine translation", () => {
    expect(pickAutoTrack(meta({ language: "en", autoCaptions: ["fr", "en", "en-orig"] }))).toBe("en-orig");
    expect(pickAutoTrack(meta({ language: "en", autoCaptions: ["fr", "en"] }))).toBe("en");
    expect(pickAutoTrack(meta({ language: "en", autoCaptions: ["fr", "de"] }))).toBeUndefined();
    expect(pickAutoTrack(meta({ autoCaptions: ["fr", "ja-orig", "en"] }))).toBe("ja-orig");
    expect(pickAutoTrack(meta({ autoCaptions: ["fr", "en"] }))).toBeUndefined();
  });
});

describe("assessTranscript", () => {
  it("refuses an empty transcript and a sparse one, not a short clip", () => {
    expect(assessTranscript([], 100)).toEqual({ ok: false, reason: "empty transcript" });
    const sparse = assessTranscript([{ start: 0, end: 1, text: "la la la" }], 240);
    expect(sparse).toEqual({ ok: false, reason: "transcript too sparse: 3 words over 4 min — music or a silent video?" });
    expect(assessTranscript([{ start: 0, end: 1, text: "hi" }], 19)).toEqual({ ok: true });
    expect(assessTranscript(talk(20), 1203)).toEqual({ ok: true });
  });
});

describe("transcribeVideo", () => {
  it("takes the manual track when there is one, and never asks for more", async () => {
    const calls: string[][] = [];
    const t = await transcribeVideo(URL, { deps: { run: runner({ manual: { en: fixture("ted-manual.en.vtt") } }, calls), have: haveAll } });
    // The fixture is two minutes of a twenty-minute talk: judged on its own length.
    expect(t.reason).toBeUndefined();
    expect(t.via).toBe("manual-subs");
    expect(t.text).toContain("Good morning. How are you?");
    expect(t.segments[0]!.start).toBeCloseTo(27.103);
    expect(t.chapters).toHaveLength(10);
    expect(t.meta?.title).toMatch(/Do schools kill creativity/);
    expect(calls.map((c) => c.find((a) => a.startsWith("--write")) ?? c[1])).toEqual(["-J", "--write-subs"]);
    // The subtitle call reuses the probe instead of extracting the page again.
    expect(calls[1]).toContain("--load-info-json");
  });

  it("falls through to the original auto-captions", async () => {
    const info = { ...INFO, duration: 120, subtitles: {} };
    const calls: string[][] = [];
    const t = await transcribeVideo(URL, { deps: { run: runner({ info, auto: { "en-orig": fixture("ted-auto.en-orig.vtt") } }, calls), have: haveAll } });
    expect(t.via).toBe("auto-subs");
    expect(t.text.match(/good morning/g)).toHaveLength(1);
    expect(calls[1]).toContain("en-orig");
  });

  it("lets a sparse track fall through to whisper", async () => {
    const info = { ...INFO, subtitles: { en: [] }, automatic_captions: {} };
    const t = await transcribeVideo(URL, {
      deps: { run: runner({ info, manual: { en: "WEBVTT\n\n00:01.000 --> 00:02.000\n♪ la la ♪\n" }, whisper: talk(130) }), have: haveAll },
    });
    expect(t.via).toBe("whisper");
    expect(t.segments.length).toBeGreaterThan(10);
  });

  it("passes the video's language to whisper", async () => {
    const calls: string[][] = [];
    const info = { ...INFO, subtitles: {}, automatic_captions: {} };
    await transcribeVideo(URL, { deps: { run: runner({ info, whisper: talk(130) }, calls), have: haveAll } });
    const uvx = calls.find((c) => c[0] === "uvx")!;
    expect(uvx.slice(uvx.indexOf("--language"), uvx.indexOf("--language") + 2)).toEqual(["--language", "en"]);
    expect(uvx.slice(1, 4)).toEqual(["--with", "av<18", "whisper-ctranslate2"]);
    expect(uvx).toContain("--model");
    expect(uvx[uvx.indexOf("--model") + 1]).toBe("small");
  });

  it("says so plainly when there are no subtitles and no whisper", async () => {
    const info = { ...INFO, subtitles: {}, automatic_captions: {} };
    const t = await transcribeVideo(URL, { deps: { run: runner({ info }), have: haveNone } });
    expect(t).toMatchObject({ text: "", segments: [], reason: "no subtitles, and whisper needs uvx and ffmpeg" });
    expect(t.meta?.id).toBe("iG9CE55wbtY");
  });

  it("remembers a missing whisper for the rest of the process", async () => {
    const info = { ...INFO, subtitles: {}, automatic_captions: {} };
    const have: string[] = [];
    const probeHave = (c: string) => {
      have.push(c);
      return false;
    };
    await transcribeVideo(URL, { deps: { run: runner({ info }), have: probeHave } });
    const before = have.length;
    const t = await transcribeVideo(URL, { deps: { run: runner({ info }), have: probeHave } });
    expect(have.length).toBe(before);
    expect(t.reason).toContain("whisper needs uvx and ffmpeg");
  });

  it("spends the whisper budget and then says so", async () => {
    process.env.WEBINDEX_TEST_WHISPER_MAX = "1";
    const info = { ...INFO, subtitles: {}, automatic_captions: {} };
    const deps = { run: runner({ info, whisper: talk(130) }), have: haveAll };
    expect((await transcribeVideo(URL, { deps })).via).toBe("whisper");
    const second = await transcribeVideo(URL, { deps });
    expect(second.via).toBeUndefined();
    expect(second.reason).toContain("whisper budget is spent (raise WEBINDEX_TEST_WHISPER_MAX)");
  });

  it("reports the gate's verdict when every rung ran and failed it", async () => {
    const info = { ...INFO, subtitles: { en: [] }, automatic_captions: {} };
    const t = await transcribeVideo(URL, {
      engines: ["manual-subs"],
      deps: { run: runner({ info, manual: { en: "WEBVTT\n\n00:01.000 --> 00:02.000\nla la\n" } }), have: haveAll },
    });
    expect(t.reason).toBe("transcript too sparse: 2 words over 20 min — music or a silent video?");
  });

  it("honours an explicit rung order, and WEBINDEX_VIDEO_ENGINES", async () => {
    const calls: string[][] = [];
    const t = await transcribeVideo(URL, {
      engines: ["auto-subs"],
      deps: { run: runner({ manual: { en: fixture("ted-manual.en.vtt") }, auto: { "en-orig": fixture("ted-auto.en-orig.vtt") } }, calls), have: haveAll },
    });
    expect(t.via).toBe("auto-subs");
    expect(calls.some((c) => c.includes("--write-subs"))).toBe(false);

    process.env.WEBINDEX_TEST_VIDEO_ENGINES = "whisper,manual-subs";
    expect(enabledTranscribers()).toEqual(["whisper", "manual-subs"]);
    process.env.WEBINDEX_TEST_VIDEO_ENGINES = "none";
    const off = await transcribeVideo(URL, { deps: { run: runner({}), have: haveAll } });
    expect(off.reason).toContain("switched off (WEBINDEX_TEST_VIDEO_ENGINES)");
  });

  it("turns yt-dlp's failures into reasons", async () => {
    const t = await transcribeVideo(URL, { deps: { run: runner({ probe: missing }), have: haveAll } });
    expect(t.reason).toMatch(/^install yt-dlp/);
    const bot = await transcribeVideo(URL, {
      deps: { run: runner({ probe: fail("ERROR: [youtube] iG9CE55wbtY: Sign in to confirm you're not a bot. Use --cookies-from-browser") }), have: haveAll },
    });
    expect(bot.reason).toContain('WEBINDEX_TEST_YTDLP_ARGS="--cookies-from-browser firefox"');
    expect(bot.meta).toBeUndefined();
  });

  it("passes WEBINDEX_YTDLP_ARGS on every yt-dlp call, and the URL only after --", async () => {
    process.env.WEBINDEX_TEST_YTDLP_ARGS = " --cookies-from-browser   firefox ";
    const calls: string[][] = [];
    await transcribeVideo("https://youtu.be/iG9CE55wbtY?si=x", {
      deps: { run: runner({ manual: { en: fixture("ted-manual.en.vtt") } }, calls), have: haveAll },
    });
    const ytdlp = calls.filter((c) => c[0] === "yt-dlp");
    expect(ytdlp).toHaveLength(2);
    // The probe gets the canonical watch URL rebuilt from the id, never the caller's string.
    expect(ytdlp[0]!.slice(-4)).toEqual(["--cookies-from-browser", "firefox", "--", URL]);
    expect(ytdlp[1]!.slice(-2)).toEqual(["--cookies-from-browser", "firefox"]);
  });

  it("refuses anything that is not a YouTube video before running a command", async () => {
    const calls: string[][] = [];
    for (const bad of ["--config-locations=/tmp/x", "https://example.com/watch?v=iG9CE55wbtY", "https://www.youtube.com/@TED"]) {
      const t = await transcribeVideo(bad, { deps: { run: runner({}, calls), have: haveAll } });
      expect(t.reason).toBe(`not a YouTube video URL: ${bad}`);
    }
    expect(calls).toEqual([]);
  });

  it("does not try to transcribe a live or upcoming stream", async () => {
    for (const [status, words] of [
      ["is_live", "live stream in progress"],
      ["is_upcoming", "live stream not started yet"],
    ]) {
      const calls: string[][] = [];
      const t = await transcribeVideo(URL, { deps: { run: runner({ info: { ...INFO, live_status: status, subtitles: {} } }, calls), have: haveAll } });
      expect(t.reason).toBe(`${words} — read it once it has ended`);
      expect(t.meta?.live).toBe(status === "is_live" ? "live" : "upcoming");
      expect(calls).toHaveLength(1);
    }
  });

  it("stops when its caller aborts, and kills the command it was running", async () => {
    const ctl = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const run: VideoRunner = async (cmd, args, opts) => {
      seen.push(opts?.signal);
      if (args.includes("-J")) {
        ctl.abort();
        return fail("aborted", 130);
      }
      return fail(`unexpected ${cmd}`);
    };
    const t = await transcribeVideo(URL, { signal: ctl.signal, deps: { run, have: haveAll } });
    expect(t.reason).toBe("cancelled");
    expect(seen).toEqual([ctl.signal]);
  });

  it("records the track it read", async () => {
    const t = await transcribeVideo(URL, { lang: "fr", deps: { run: runner({ manual: { fr: fixture("ted-manual.fr.vtt") } }), have: haveAll } });
    expect(t).toMatchObject({ via: "manual-subs", track: "fr" });
  });
});

describe("whisper", () => {
  const info = { ...INFO, language: "en-US", subtitles: {}, automatic_captions: {} };

  it("tells whisper the bare language code, and nothing it would refuse", async () => {
    const calls: string[][] = [];
    await transcribeVideo(URL, { deps: { run: runner({ info, whisper: talk(130) }, calls), have: haveAll } });
    const uvx = calls.find((c) => c[0] === "uvx")!;
    expect(uvx[uvx.indexOf("--language") + 1]).toBe("en");
    resetVideoLadderCache();
    const none: string[][] = [];
    await transcribeVideo(URL, { deps: { run: runner({ info: { ...info, language: "x-klingon" }, whisper: talk(130) }, none), have: haveAll } });
    expect(none.find((c) => c[0] === "uvx")).not.toContain("--language");
  });

  it("refunds the budget when no transcription was attempted", async () => {
    process.env.WEBINDEX_TEST_WHISPER_MAX = "1";
    const noAudio: VideoRunner = async (cmd, args, opts) =>
      cmd === "yt-dlp" && args.includes("bestaudio/best") ? fail("ERROR: HTTP Error 403: Forbidden") : runner({ info, whisper: talk(130) })(cmd, args, opts);
    const first = await transcribeVideo(URL, { deps: { run: noAudio, have: haveAll } });
    expect(first.reason).toContain("the audio download failed");
    const second = await transcribeVideo(URL, { deps: { run: runner({ info, whisper: talk(130) }), have: haveAll } });
    expect(second.via).toBe("whisper");
  });

  it("gives the three steps one deadline between them", async () => {
    process.env.WEBINDEX_TEST_WHISPER_TIMEOUT_MS = "60000";
    // Each step "takes" 25 s of a fake clock.
    let clock = 1_000_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const budgets: number[] = [];
    const inner = runner({ info, whisper: talk(130) });
    const run: VideoRunner = async (cmd, args, opts) => {
      if (cmd !== "yt-dlp" || args.includes("bestaudio/best")) {
        budgets.push(opts?.timeoutMs ?? 0);
        clock += 25_000;
      }
      return inner(cmd, args, opts);
    };
    try {
      await transcribeVideo(URL, { deps: { run, have: haveAll } });
    } finally {
      now.mockRestore();
      delete process.env.WEBINDEX_TEST_WHISPER_TIMEOUT_MS;
    }
    expect(budgets).toEqual([60_000, 35_000, 10_000]);
  });
});

describe("classifyYtdlpError", () => {
  it.each([
    ["ERROR: [youtube] x: Private video. Sign in if you've been granted access", "private video"],
    ["ERROR: [youtube] x: Join this channel to get access to members-only content", "members-only video"],
    ["ERROR: [youtube] x: Sign in to confirm your age. This video may be inappropriate for some users.", "age-restricted"],
    ["ERROR: unable to download video data: HTTP Error 403: Forbidden", "YouTube refused yt-dlp"],
    ["WARNING: [youtube] x: PO Token required", "YouTube refused yt-dlp"],
    ["ERROR: [youtube] x: This video has been removed by the uploader", "video removed"],
    ["ERROR: [youtube] x: Video unavailable", "video unavailable"],
    ["ERROR: something new", "yt-dlp failed: something new"],
  ])("reads %s", (stderr, expected) => {
    expect(classifyYtdlpError(stderr)).toContain(expected);
  });
});

describe("ytdlpVersionAge", () => {
  it("dates a release from its version", async () => {
    const run: VideoRunner = async () => ok("2026.08.19\n");
    expect(await ytdlpVersionAge(run, Date.UTC(2026, 8, 30))).toEqual({ version: "2026.08.19", ageDays: 42 });
    expect(await ytdlpVersionAge(async () => missing)).toBeUndefined();
  });
});
