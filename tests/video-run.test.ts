import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  it("takes --out, then WEBINDEX_VIDEO_DIR, then <tmp>/<brand>/video", () => {
    expect(videoRoot("/x/y")).toBe("/x/y");
    process.env.WEBINDEX_TEST_VIDEO_DIR = "/from/env";
    expect(videoRoot()).toBe("/from/env");
    delete process.env.WEBINDEX_TEST_VIDEO_DIR;
    expect(videoRoot()).toBe(join(tmpdir(), "webindex-tests", "video"));
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
    expect(await fetchVideoRun("https://example.com/x", root)).toEqual({ ok: false, reason: "not a YouTube video URL: https://example.com/x" });
  });

  it("collects the files instead of writing them under no-write", async () => {
    setNoWrite(true);
    const r = await fetchVideoRun(ZOO, root);
    expect(r.ok).toBe(true);
    expect(takeArtifacts().map((a) => a.path.slice(root.length + 1))).toEqual([
      "jNQXAC9IVRw/segments.json",
      "jNQXAC9IVRw/meta.json",
      "jNQXAC9IVRw/TRANSCRIPT.md",
    ]);
    expect(() => readFileSync(join(root, "jNQXAC9IVRw", "meta.json"))).toThrow();
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

  it("finds nothing in a directory with no runs", () => {
    expect(searchVideoRuns(join(root, "missing"), "anything")).toEqual([]);
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

  it("sets t= on the watch URL", () => {
    expect(videoUrlAt("https://www.youtube.com/watch?v=abc", 61.9)).toBe("https://www.youtube.com/watch?v=abc&t=61s");
    expect(videoUrlAt("not a url", 3)).toBe("not a url");
  });
});
