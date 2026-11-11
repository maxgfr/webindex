import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetNoWrite, setNoWrite, takeArtifacts } from "../src/no-write.js";
import { fetchVideoRun, resetVideoLadderCache, searchVideoRuns, setVideoDeps, videoRoot, type VideoRunner } from "../src/video.js";
import { videoPassages, videoUrlAt } from "../src/video/run.js";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", "video", name), "utf8");
const TED = "https://www.youtube.com/watch?v=iG9CE55wbtY";
const ZOO = "https://youtu.be/jNQXAC9IVRw";
const ZOO_INFO = {
  id: "jNQXAC9IVRw",
  title: "Me at the zoo",
  channel: "jawed",
  duration: 19,
  webpage_url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  subtitles: { en: [] },
  automatic_captions: {},
  chapters: [
    { start_time: 0, end_time: 5, title: "Intro" },
    { start_time: 5, end_time: 17, title: "The cool thing" },
    { start_time: 17, end_time: 19, title: "End" },
  ],
};

// yt-dlp replaced: a probe answers from the fixtures, a subtitle call drops the VTT where -o points.
function runner(calls: string[][]): VideoRunner {
  return async (_cmd, args) => {
    calls.push(args);
    const url = args.find((a) => a.startsWith("http"));
    if (args.includes("-J")) {
      const info = url?.includes("jNQXAC9IVRw") ? ZOO_INFO : JSON.parse(fixture("ted-info.json"));
      return { ok: true, status: 0, stdout: JSON.stringify(info), stderr: "" };
    }
    const info = JSON.parse(readFileSync(args[args.indexOf("--load-info-json") + 1]!, "utf8")) as { id: string };
    const o = args[args.indexOf("-o") + 1]!;
    writeFileSync(join(o.slice(0, o.lastIndexOf("/")), "sub.vtt"), fixture(info.id === "jNQXAC9IVRw" ? "zoo-manual.en.vtt" : "ted-manual.en.vtt"));
    return { ok: true, status: 0, stdout: "", stderr: "" };
  };
}

let root: string;
let calls: string[][];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "video-run-"));
  calls = [];
  setVideoDeps({ run: runner(calls), have: () => true });
});
afterEach(() => {
  setVideoDeps();
  resetVideoLadderCache();
  resetNoWrite();
  delete process.env.WEBINDEX_TEST_VIDEO_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("videoRoot", () => {
  it("takes --out, then WEBINDEX_VIDEO_DIR, then <tmp>/<brand>-<uid>/video", () => {
    expect(videoRoot("/x/y")).toBe("/x/y");
    process.env.WEBINDEX_TEST_VIDEO_DIR = "/from/env";
    expect(videoRoot()).toBe("/from/env");
    delete process.env.WEBINDEX_TEST_VIDEO_DIR;
    // Per user, as the cache is: one shared <tmp>/<brand> served one user's runs to another.
    const uid = process.getuid?.();
    expect(videoRoot()).toBe(join(tmpdir(), uid === undefined ? "webindex-tests" : `webindex-tests-${uid}`, "video"));
  });

  describe("the default directory, under the temp dir", () => {
    // <tmp>/<brand>-<uid>/video is a path any local user can predict and create
    // first, as the fetch cache and the clone cache beside it were: a run
    // planted there was searched and cited as the video's transcript.
    const SETUP_TMPDIR = process.env.TMPDIR;
    const hasUids = typeof process.getuid === "function";
    let tmp: string;
    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), "wi-video-tmp-"));
      process.env.TMPDIR = tmp;
      delete process.env.WEBINDEX_TEST_VIDEO_DIR;
    });
    afterEach(() => {
      if (SETUP_TMPDIR === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = SETUP_TMPDIR;
      rmSync(tmp, { recursive: true, force: true });
    });

    it.runIf(hasUids)("is created private to the caller", () => {
      const umask = process.umask(0o022);
      let dir: string;
      try {
        dir = videoRoot();
      } finally {
        process.umask(umask);
      }
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, "..")).mode & 0o777).toBe(0o700);
    });

    it.runIf(hasUids)("is not used when other users may write it", () => {
      const dir = videoRoot();
      chmodSync(dir, 0o777);
      expect(() => videoRoot()).toThrow(/writable by other users[\s\S]*WEBINDEX_TEST_VIDEO_DIR/);
      // A directory the caller names is theirs to vouch for, as before.
      expect(videoRoot(dir)).toBe(dir);
    });

    it.runIf(hasUids)("creates nothing when nothing may be written", () => {
      setNoWrite(true);
      const dir = videoRoot();
      expect(existsSync(dir)).toBe(false);
    });
  });

  it("reads a blank --out as none, never as the current directory", () => {
    // `--out=` (a shell variable that was empty) resolved "" — the directory the
    // command was run from — and the runs were written there.
    process.env.WEBINDEX_TEST_VIDEO_DIR = "/from/env";
    expect(videoRoot("")).toBe("/from/env");
    expect(videoRoot("  ")).toBe("/from/env");
  });
});

describe("fetchVideoRun", () => {
  it("writes TRANSCRIPT.md, segments.json and meta.json under <root>/<id>", async () => {
    const r = await fetchVideoRun(ZOO, root);
    expect(r).toMatchObject({ ok: true, id: "jNQXAC9IVRw", reused: false, dir: join(root, "jNQXAC9IVRw") });
    if (!r.ok) return;
    expect(readFileSync(r.transcript, "utf8")).toContain("[00:01] All right, so here we are");
    const segments = JSON.parse(readFileSync(join(r.dir, "segments.json"), "utf8"));
    expect(segments[0]).toMatchObject({ start: 1.2, text: "All right, so here we are, in front of the elephants" });
    const meta = JSON.parse(readFileSync(join(r.dir, "meta.json"), "utf8"));
    expect(meta).toMatchObject({ id: "jNQXAC9IVRw", via: "manual-subs", title: "Me at the zoo" });
    expect(Date.parse(meta.fetchedAt)).not.toBeNaN();
  });

  it("reuses a run without calling yt-dlp, unless asked to refresh", async () => {
    await fetchVideoRun(ZOO, root);
    const before = calls.length;
    const again = await fetchVideoRun("https://www.youtube.com/watch?v=jNQXAC9IVRw&t=4", root);
    expect(again).toMatchObject({ ok: true, reused: true, segments: 3 });
    expect(calls.length).toBe(before);
    const fresh = await fetchVideoRun(ZOO, root, { refresh: true });
    expect(fresh).toMatchObject({ ok: true, reused: false });
    expect(calls.length).toBeGreaterThan(before);
  });

  it("writes nothing for a video with no transcript, and refuses a non-video URL", async () => {
    setVideoDeps({ run: async () => ({ ok: false, status: 1, stdout: "", stderr: "ERROR: [youtube] x: Private video" }), have: () => true });
    expect(await fetchVideoRun(ZOO, root)).toEqual({ ok: false, id: "jNQXAC9IVRw", reason: "private video" });
    expect(() => readFileSync(join(root, "jNQXAC9IVRw", "meta.json"))).toThrow();
    expect(await fetchVideoRun("ftp://example.com/x", root)).toEqual({ ok: false, reason: "not a video URL: ftp://example.com/x" });
  });

  it("writes nothing under no-write, and hands the transcript back instead", async () => {
    setNoWrite(true);
    const r = await fetchVideoRun(ZOO, root);
    expect(r.ok && r.markdown).toContain("[00:01] All right, so here we are");
    // Nothing collected either: a long-lived server would keep it forever.
    expect(takeArtifacts()).toEqual([]);
    expect(() => readFileSync(join(root, "jNQXAC9IVRw", "meta.json"))).toThrow();
  });

  it("reads the video again when another language is asked than the run was read in", async () => {
    const first = await fetchVideoRun(ZOO, root);
    expect(first.ok && first.meta.track).toBe("en");
    const before = calls.length;
    expect(await fetchVideoRun(ZOO, root, { lang: "en-GB" })).toMatchObject({ ok: true, reused: true });
    expect(calls.length).toBe(before);
    await fetchVideoRun(ZOO, root, { lang: "fr" });
    expect(calls.length).toBeGreaterThan(before);
  });

  it("never reuses a run cut short before its meta.json", async () => {
    await fetchVideoRun(ZOO, root);
    rmSync(join(root, "jNQXAC9IVRw", "meta.json"));
    expect(await fetchVideoRun(ZOO, root)).toMatchObject({ ok: true, reused: false });
  });
});

describe("searchVideoRuns", () => {
  it("finds the passage that answers, with a stamp and a link that opens there", async () => {
    await fetchVideoRun(TED, root);
    await fetchVideoRun(ZOO, root);
    const hits = searchVideoRuns(root, "elephants trunks");
    expect(hits[0]).toMatchObject({ label: "jNQXAC9IVRw", videoId: "jNQXAC9IVRw", stamp: "00:01", chapter: "Intro" });
    expect(hits[0]!.url).toBe("https://www.youtube.com/watch?v=jNQXAC9IVRw&t=1s");
    const ted = searchVideoRuns(root, "education dinner party");
    expect(ted[0]).toMatchObject({ videoId: "iG9CE55wbtY", title: expect.stringMatching(/creativity/) });
    expect(ted[0]!.text).toContain("dinner part");
    expect(ted.every((h) => h.score > 0)).toBe(true);
  });

  it("searches one run when given its directory, honours --limit and labels", async () => {
    await fetchVideoRun(TED, root);
    await fetchVideoRun(ZOO, root);
    expect(searchVideoRuns(join(root, "iG9CE55wbtY"), "elephants")).toEqual([]);
    expect(searchVideoRuns(root, "education", { limit: 1 })).toHaveLength(1);
    const labelled = searchVideoRuns(root, "elephants", { labels: new Map([["jNQXAC9IVRw", "V2"]]) });
    expect(labelled[0]!.label).toBe("V2");
  });

  it("orders passages that score the same by video id in code-unit order, whatever the locale", async () => {
    // localeCompare reads the ICU locale from LANG: "a" sorts before "B" in
    // English, and two machines printed one search in two orders. A YouTube
    // id mixes cases, so the tie is ordinary.
    await fetchVideoRun(ZOO, root);
    for (const key of ["akey0000000", "Bkey0000000"]) {
      cpSync(join(root, "jNQXAC9IVRw"), join(root, key), { recursive: true });
      const meta = JSON.parse(readFileSync(join(root, key, "meta.json"), "utf8"));
      writeFileSync(join(root, key, "meta.json"), JSON.stringify({ ...meta, id: key, key }));
    }
    rmSync(join(root, "jNQXAC9IVRw"), { recursive: true });
    const hits = searchVideoRuns(root, "elephants trunks");
    expect(hits[0]!.score).toBe(hits[1]!.score);
    expect(hits.slice(0, 2).map((h) => h.videoId)).toEqual(["Bkey0000000", "akey0000000"]);
  });

  it("labels passages with the right chapter however meta.json orders them", async () => {
    // chapterAt took the list as sorted; frames.ts's own copy sorts it. Out of
    // order, a passage got the chapter of an earlier one.
    await fetchVideoRun(ZOO, root);
    const metaPath = join(root, "jNQXAC9IVRw", "meta.json");
    const sorted = searchVideoRuns(root, "elephants trunks cool");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    const [a, b, c] = meta.chapters;
    writeFileSync(metaPath, JSON.stringify({ ...meta, chapters: [b, a, c] }));
    expect(searchVideoRuns(root, "elephants trunks cool").map((h) => [h.start, h.chapter])).toEqual(sorted.map((h) => [h.start, h.chapter]));
    expect(sorted.map((h) => h.chapter)).toContain("The cool thing");
  });

  it("finds nothing in a directory with no runs", () => {
    expect(searchVideoRuns(join(root, "missing"), "anything")).toEqual([]);
  });
});

describe("other sites", () => {
  const VIMEO = {
    id: "76979871",
    extractor_key: "Vimeo",
    title: "The New Vimeo Player",
    duration: 62,
    webpage_url: "https://player.vimeo.com/video/76979871",
    subtitles: { en: [] },
    automatic_captions: {},
  };
  const WEB = { ...VIMEO, id: "talk", extractor_key: "Generic", title: "A talk", webpage_url: "https://example.com/talk" };
  const other =
    (info: Record<string, unknown>, calls: string[][]): VideoRunner =>
    async (_cmd, args) => {
      calls.push(args);
      if (args.includes("-J")) return { ok: true, status: 0, stdout: JSON.stringify(info), stderr: "" };
      const o = args[args.indexOf("-o") + 1]!;
      writeFileSync(join(o.slice(0, o.lastIndexOf("/")), "sub.en.srt"), "1\n00:00:05,000 --> 00:00:09,000\nThe best player in the galaxy.\n");
      return { ok: true, status: 0, stdout: "", stderr: "" };
    };

  it("writes a run under the URL's own key, even when yt-dlp names the video differently", async () => {
    const calls: string[][] = [];
    // yt-dlp calls a Twitch VOD "v123"; the URL's key is twitch-123.
    setVideoDeps({
      run: other({ ...VIMEO, id: "v123", extractor_key: "TwitchVod", webpage_url: "https://www.twitch.tv/videos/123" }, calls),
      have: () => true,
    });
    expect(await fetchVideoRun("https://www.twitch.tv/videos/123", root)).toMatchObject({ ok: true, id: "twitch-123" });
    const n = calls.length;
    expect(await fetchVideoRun("https://www.twitch.tv/videos/123", root)).toMatchObject({ ok: true, reused: true });
    expect(calls.length).toBe(n);
  });

  it("keeps a Vimeo video under vimeo-<id>, reads its SRT track, and reuses it with no yt-dlp", async () => {
    const calls: string[][] = [];
    setVideoDeps({ run: other(VIMEO, calls), have: () => true });
    const r = await fetchVideoRun("https://vimeo.com/76979871", root);
    expect(r).toMatchObject({ ok: true, id: "vimeo-76979871", dir: join(root, "vimeo-76979871"), reused: false });
    expect(readFileSync(join(root, "vimeo-76979871", "TRANSCRIPT.md"), "utf8")).toContain("[00:05] The best player in the galaxy.");
    const n = calls.length;
    expect(await fetchVideoRun("https://player.vimeo.com/video/76979871", root)).toMatchObject({ ok: true, reused: true });
    expect(calls.length).toBe(n);
    expect(searchVideoRuns(root, "galaxy player")[0]).toMatchObject({ videoId: "vimeo-76979871", url: "https://player.vimeo.com/video/76979871#t=5s" });
  });

  it("probes an unknown page once, then reuses its run by the key yt-dlp gave", async () => {
    const calls: string[][] = [];
    setVideoDeps({ run: other(WEB, calls), have: () => true });
    const r = await fetchVideoRun("https://example.com/talk", root);
    expect(r.ok && r.id).toMatch(/^web-talk-[0-9a-f]{8}$/);
    expect(r).toMatchObject({ ok: true, reused: false });
    expect(calls.filter((c) => c.includes("-J"))).toHaveLength(1);
    const again = await fetchVideoRun("https://example.com/talk", root);
    expect(again).toMatchObject({ ok: true, reused: true });
    // One probe to learn the key, nothing else.
    expect(calls.filter((c) => c.includes("-J"))).toHaveLength(2);
    expect(calls.filter((c) => !c.includes("-J"))).toHaveLength(1);
  });
});

describe("search stamps", () => {
  it("points at the segment that answers, not at the start of its passage", async () => {
    const dir = join(root, "focus");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        id: "focus",
        title: "t",
        chapters: [],
        subtitles: [],
        autoCaptions: [],
        webpageUrl: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
        via: "manual-subs",
      }),
    );
    writeFileSync(
      join(dir, "segments.json"),
      JSON.stringify([
        { start: 0, end: 15, text: "An introduction about nothing in particular." },
        { start: 15, end: 30, text: "More of the introduction, still nothing." },
        { start: 30, end: 44, text: "The SE3 is the best value for money." },
      ]),
    );
    const [hit] = searchVideoRuns(dir, "best value money");
    expect(hit).toMatchObject({ start: 30, stamp: "00:30", url: "https://www.youtube.com/watch?v=aaaaaaaaaaa&t=30s" });
    expect(hit!.text).toContain("An introduction");
  });
});

describe("passages", () => {
  it("groups segments into ~45 s passages", () => {
    const segs = Array.from({ length: 10 }, (_, i) => ({ start: i * 10, end: i * 10 + 10, text: `s${i}` }));
    expect(videoPassages(segs).map((p) => [p.start, p.end])).toEqual([
      [0, 50],
      [50, 100],
    ]);
  });

  it("starts a new passage at a chapter start", () => {
    const segs = Array.from({ length: 4 }, (_, i) => ({ start: i * 10, end: i * 10 + 10, text: `s${i}` }));
    expect(videoPassages(segs, [0, 20]).map((p) => p.text)).toEqual(["s0 s1", "s2 s3"]);
  });

  it("sets t= on the watch URL", () => {
    expect(videoUrlAt("https://www.youtube.com/watch?v=abc", 61.9)).toBe("https://www.youtube.com/watch?v=abc&t=61s");
    expect(videoUrlAt("not a url", 3)).toBe("not a url");
  });
});
