import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { envName } from "../src/brand.js";
import { webindexAdapter } from "../src/cli.js";
import { ToolError } from "../src/mcp/server.js";
import { corpusMarkdown, fetchVideoCorpus, listVideos, resetVideoLadderCache, searchVideoRuns, setVideoDeps, type VideoRunner } from "../src/video.js";

// The four video tools driven through the adapter, as an MCP client would,
// with yt-dlp and ffmpeg replaced by a runner: no network, no tool installed.

const infoFor = (id: string, title: string) => ({
  id,
  title,
  channel: "chan",
  duration: 60,
  webpage_url: `https://www.youtube.com/watch?v=${id}`,
  subtitles: { en: [] },
  automatic_captions: {},
});
const VIDEOS: Record<string, { title: string; vtt: string }> = {
  aaaaaaaaaaa: {
    title: "Elephants at the zoo",
    vtt: "WEBVTT\n\n00:01.000 --> 00:05.000\nThe elephants at the zoo have really long trunks, and that is the cool thing about them.\n",
  },
  bbbbbbbbbbb: {
    title: "Giraffes explained",
    vtt: "WEBVTT\n\n00:02.000 --> 00:06.000\nGiraffes have long necks to reach the leaves at the top of the acacia trees.\n",
  },
};
const LISTING = {
  _type: "playlist",
  title: "Animals",
  entries: [
    { _type: "url", ie_key: "Youtube", id: "aaaaaaaaaaa", title: "Elephants at the zoo", duration: 60 },
    { _type: "url", ie_key: "Youtube", id: "bbbbbbbbbbb", title: "Giraffes explained", duration: 60 },
    { _type: "url", ie_key: "Youtube", id: "ccccccccccc", title: "A private one", duration: 60 },
    { _type: "playlist", id: "UCnotavideo", title: "a tab" },
  ],
};

let calls: string[][];
const runner: VideoRunner = async (cmd, args) => {
  calls.push([cmd, ...args]);
  const ok = { ok: true, status: 0, stdout: "", stderr: "" };
  const url = args[args.length - 1] ?? "";
  if (args.includes("--flat-playlist")) return { ...ok, stdout: JSON.stringify(LISTING) };
  if (args.includes("-J")) {
    const id = /v=([\w-]{11})/.exec(url)?.[1] ?? "";
    const v = VIDEOS[id];
    return v ? { ...ok, stdout: JSON.stringify(infoFor(id, v.title)) } : { ok: false, status: 1, stdout: "", stderr: "ERROR: [youtube] x: Private video" };
  }
  if (args.includes("--write-subs")) {
    const info = JSON.parse(readFileSync(args[args.indexOf("--load-info-json") + 1]!, "utf8")) as { id: string };
    writeFileSync(join(dirname(args[args.indexOf("-o") + 1]!), "sub.en.vtt"), VIDEOS[info.id]!.vtt);
    return ok;
  }
  return { ok: false, status: 1, stdout: "", stderr: `unexpected ${cmd}` };
};

let root: string;
beforeEach(() => {
  calls = [];
  root = mkdtempSync(join(tmpdir(), "mcp-video-"));
  process.env[envName("VIDEO_DIR")] = root;
  setVideoDeps({ run: runner, have: (c) => c !== "ffmpeg" });
});
afterEach(() => {
  setVideoDeps();
  resetVideoLadderCache();
  delete process.env[envName("VIDEO_DIR")];
  rmSync(root, { recursive: true, force: true });
});

describe("listVideos", () => {
  it("lists the videos of a playlist, and skips what is not one", async () => {
    const r = await listVideos("https://www.youtube.com/playlist?list=PLx", { limit: 5 });
    expect(r).toEqual({
      title: "Animals",
      videos: [
        { id: "aaaaaaaaaaa", title: "Elephants at the zoo", duration: 60, url: "https://www.youtube.com/watch?v=aaaaaaaaaaa" },
        { id: "bbbbbbbbbbb", title: "Giraffes explained", duration: 60, url: "https://www.youtube.com/watch?v=bbbbbbbbbbb" },
        { id: "ccccccccccc", title: "A private one", duration: 60, url: "https://www.youtube.com/watch?v=ccccccccccc" },
      ],
    });
    const call = calls[0]!;
    expect(call.slice(call.indexOf("--playlist-end"), call.indexOf("--playlist-end") + 2)).toEqual(["--playlist-end", "5"]);
    expect(call.slice(-2)).toEqual(["--", "https://www.youtube.com/playlist?list=PLx"]);
  });

  it("lists a channel's videos tab, and refuses a single video", async () => {
    await listVideos("https://www.youtube.com/@Fireship");
    expect(calls[0]!.at(-1)).toBe("https://www.youtube.com/@Fireship/videos");
    await listVideos("https://www.youtube.com/@Fireship/shorts");
    expect(calls[1]!.at(-1)).toBe("https://www.youtube.com/@Fireship/shorts");
    expect(await listVideos("https://youtu.be/aaaaaaaaaaa")).toEqual({ error: "not a YouTube playlist or channel URL: https://youtu.be/aaaaaaaaaaa" });
  });
});

describe("fetchVideoCorpus", () => {
  it("keeps each video as a run and names them V1…Vn, a failure keeping its label", async () => {
    const r = await fetchVideoCorpus("https://www.youtube.com/playlist?list=PLx", root, { limit: 3 });
    if (!r.ok) throw new Error(r.reason);
    expect(r.videos.map((v) => [v.label, v.id, v.via ?? v.reason])).toEqual([
      ["V1", "aaaaaaaaaaa", "manual-subs"],
      ["V2", "bbbbbbbbbbb", "manual-subs"],
      ["V3", "ccccccccccc", "private video"],
    ]);
    const md = readFileSync(r.corpus, "utf8");
    expect(md).toContain("| V1 | aaaaaaaaaaa | Elephants at the zoo | 01:00 | manual-subs | aaaaaaaaaaa/TRANSCRIPT.md |");
    expect(md).toContain("| V3 | ccccccccccc | A private one | 01:00 | — | not read: private video |");
    expect(md).toContain("- 2 of 3 videos read");
    expect(JSON.parse(readFileSync(join(root, "corpus.json"), "utf8")).videos).toHaveLength(3);
    // Search on the corpus labels each hit with its V#.
    expect(searchVideoRuns(root, "giraffes necks")[0]).toMatchObject({ label: "V2", videoId: "bbbbbbbbbbb" });
  });

  it("escapes a title that would break the table", () => {
    const md = corpusMarkdown({ source: "s", createdAt: "t", videos: [{ label: "V1", id: "x", title: "a | b" }] }, "/r");
    expect(md).toContain("| V1 | x | a \\| b |");
  });
});

describe("the MCP video tools", () => {
  const text = (r: { text?: string }) => r.text ?? "";

  it("webindex_video_fetch returns the transcript and keeps the run", async () => {
    const r = await webindexAdapter().callTool("webindex_video_fetch", { url: "https://youtu.be/aaaaaaaaaaa" });
    expect(text(r)).toContain("# Elephants at the zoo");
    expect(text(r)).toContain("[00:01] The elephants at the zoo");
    expect(text(r)).toContain(`run: ${join(root, "aaaaaaaaaaa")}`);
    expect(existsSync(join(root, "aaaaaaaaaaa", "segments.json"))).toBe(true);
    const n = calls.length;
    const again = await webindexAdapter().callTool("webindex_video_fetch", { url: "https://www.youtube.com/watch?v=aaaaaaaaaaa" });
    expect(text(again)).toContain("(already on disk)");
    expect(calls.length).toBe(n);
  });

  it("webindex_video_search answers from what was kept", async () => {
    await webindexAdapter().callTool("webindex_video_fetch", { url: "https://youtu.be/aaaaaaaaaaa" });
    const r = JSON.parse(text(await webindexAdapter().callTool("webindex_video_search", { query: "long trunks" })));
    expect(r.hits[0]).toMatchObject({ videoId: "aaaaaaaaaaa", stamp: "00:01", url: "https://www.youtube.com/watch?v=aaaaaaaaaaa&t=1s" });
    await expect(webindexAdapter().callTool("webindex_video_search", { query: "quantum chromodynamics" })).rejects.toThrow(ToolError);
  });

  it("webindex_video_list reads a playlist into a corpus", async () => {
    const r = JSON.parse(text(await webindexAdapter().callTool("webindex_video_list", { url: "https://www.youtube.com/playlist?list=PLx", limit: 2 })));
    expect(r.videos.map((v: { label: string }) => v.label)).toEqual(["V1", "V2"]);
    expect(r.corpus).toBe(join(root, "CORPUS.md"));
  });

  it("webindex_video_frames says what it lacks", async () => {
    await expect(webindexAdapter().callTool("webindex_video_frames", { url: "https://youtu.be/aaaaaaaaaaa" })).rejects.toThrow("frames need ffmpeg");
    await expect(webindexAdapter().callTool("webindex_video_frames", { url: "https://youtu.be/aaaaaaaaaaa", effort: "max" })).rejects.toThrow("`effort`");
  });

  it("refuses a URL that is not what the tool reads", async () => {
    await expect(webindexAdapter().callTool("webindex_video_fetch", { url: "https://example.com/x" })).rejects.toThrow("`url` must be a YouTube video URL.");
    await expect(webindexAdapter().callTool("webindex_video_list", { url: "https://youtu.be/aaaaaaaaaaa" })).rejects.toThrow("playlist or channel");
    expect(calls).toEqual([]);
  });

  it("confines `dir` to a name inside the video root under a policy", async () => {
    const guarded = webindexAdapter({ noLocalFiles: true });
    for (const dir of ["/etc", "../escape", "a/b", ".."]) {
      await expect(guarded.callTool("webindex_video_fetch", { url: "https://youtu.be/aaaaaaaaaaa", dir })).rejects.toThrow("must be the name of a directory");
    }
    const r = await guarded.callTool("webindex_video_fetch", { url: "https://youtu.be/aaaaaaaaaaa", dir: "animals" });
    expect(text(r)).toContain(`run: ${join(root, "animals", "aaaaaaaaaaa")}`);
    // With no policy, a local caller names any directory.
    const free = mkdtempSync(join(tmpdir(), "mcp-video-free-"));
    try {
      const r2 = await webindexAdapter().callTool("webindex_video_fetch", { url: "https://youtu.be/bbbbbbbbbbb", dir: free });
      expect(text(r2)).toContain(`run: ${join(free, "bbbbbbbbbbb")}`);
    } finally {
      rmSync(free, { recursive: true, force: true });
    }
  });
});
