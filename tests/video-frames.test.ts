import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetNoWrite, setNoWrite } from "../src/no-write.js";
import { extractFrames, fetchVideoRun, resetVideoLadderCache, setVideoDeps, type VideoRunner } from "../src/video.js";
import { alignFrames, framesMarkdown, transcriptAround } from "../src/video/align.js";
import { DHASH_FRAME_BYTES, dhash, dhashStream, hamming } from "../src/video/dhash.js";
import { capFrames, parseShowinfo, VIDEO_FORMAT } from "../src/video/frames.js";

// Logged by ffmpeg 9 over a real video (select + showinfo), trimmed to three frames.
const SHOWINFO = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'video.mp4':
  Duration: 00:05:12.40, start: 0.000000, bitrate: 412 kb/s
[Parsed_showinfo_1 @ 0x8a1c240c0] config in time_base: 1/15360, frame_rate: 30/1
[Parsed_showinfo_1 @ 0x8a1c240c0] n:   0 pts: 202752 pts_time:13.2     duration:    512 duration_time:0.0333333 fmt:yuv420p cl:left sar:1/1 s:1280x720 i:P iskey:0 type:P checksum:6B9C2A1E plane_checksum:[B1F5D3B6 5C7F3D9E 5F83E0A4]
[Parsed_showinfo_1 @ 0x8a1c240c0] n:   1 pts: 1566720 pts_time:102     duration:    512 duration_time:0.0333333 fmt:yuv420p
[Parsed_showinfo_1 @ 0x8a1c240c0] n:   2 pts: 3843072 pts_time:250.2   duration:    512 duration_time:0.0333333 fmt:yuv420p
frame=    3 fps=0.0 q=3.0 Lsize=N/A time=00:04:10.20 bitrate=N/A speed= 812x
`;

describe("parseShowinfo", () => {
  it("reads each frame's pts_time, in output order", () => {
    expect(parseShowinfo(SHOWINFO)).toEqual([13.2, 102, 250.2]);
    expect(parseShowinfo("no frames at all")).toEqual([]);
  });
});

// A 9×8 grey image from a row function.
const image = (px: (x: number, y: number) => number) => {
  const b = new Uint8Array(DHASH_FRAME_BYTES);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 9; x++) b[y * 9 + x] = px(x, y);
  return b;
};

describe("dhash", () => {
  const ramp = image((x) => 255 - x * 25); // every pixel brighter than its right neighbour
  const flat = image(() => 128);
  it("sets one bit per pixel brighter than its right neighbour", () => {
    expect(dhash(ramp)).toBe((1n << 64n) - 1n);
    expect(dhash(flat)).toBe(0n);
  });

  it("tells near-duplicates from different pictures", () => {
    const noisy = image((x, y) => 255 - x * 25 + (x === 3 && y === 2 ? 40 : 0));
    expect(hamming(dhash(ramp), dhash(noisy))).toBeLessThanOrEqual(6);
    const other = image((x, y) => ((x + y) % 2 ? 200 : 20));
    expect(hamming(dhash(ramp), dhash(other))).toBeGreaterThan(6);
  });

  it("hashes a raw stream frame by frame, and refuses a short frame", () => {
    const stream = new Uint8Array([...ramp, ...flat, 1, 2, 3]);
    expect(dhashStream(stream)).toEqual([dhash(ramp), dhash(flat)]);
    expect(() => dhash(new Uint8Array(10))).toThrow();
  });
});

describe("capFrames", () => {
  const f = (time: number, kind: "scene" | "chapter" = "scene") => ({ time, kind });
  it("keeps the most widely spaced frames", () => {
    const kept = capFrames([f(0), f(10), f(11), f(20), f(21), f(30)], 4);
    expect(kept.map((k) => k.time)).toEqual([0, 10, 20, 30]);
  });

  it("drops a chapter frame only when nothing else is left", () => {
    expect(capFrames([f(0), f(1, "chapter"), f(50)], 2).map((k) => k.time)).toEqual([1, 50]);
    expect(capFrames([f(0, "chapter"), f(1, "chapter"), f(50, "chapter")], 2)).toHaveLength(2);
    expect(capFrames([f(3), f(1)], 10).map((k) => k.time)).toEqual([1, 3]);
  });
});

describe("alignment", () => {
  const segments = [
    { start: 0, end: 4, text: "intro" },
    { start: 8, end: 14, text: "first slide" },
    { start: 20, end: 30, text: "second slide" },
    { start: 40, end: 45, text: "later" },
  ];
  it("pairs a frame with what was said from 5 s before to 10 s after", () => {
    expect(transcriptAround(segments, 12)).toBe("[00:08] first slide\n[00:20] second slide");
    expect(transcriptAround(segments, 100)).toBe("");
  });

  it("quotes a passage once, and points back to it from the next frames", () => {
    const meta = { id: "x", title: "T", chapters: [], subtitles: [], autoCaptions: [], webpageUrl: "u" };
    const frames = alignFrames(
      [
        { file: "frames/0001_00-21.jpg", time: 21, kind: "scene" },
        { file: "frames/0002_00-25.jpg", time: 25, kind: "scene" },
        { file: "frames/0003_01-40.jpg", time: 100, kind: "scene" },
      ],
      segments,
      [],
    );
    const md = framesMarkdown(meta, frames, "note");
    expect(md.match(/> \[00:20\] second slide/g)).toHaveLength(1);
    expect(md).toContain("_(said over the passage quoted above, from [00:20])_");
    expect(md).toContain("_(nothing said around this frame)_");
  });

  it("names each frame's chapter and stamp", () => {
    const [a] = alignFrames([{ file: "frames/0001_00-21.jpg", time: 21, kind: "scene" }], segments, [
      { start: 0, end: 20, title: "Intro" },
      { start: 20, end: 45, title: "Slides" },
    ]);
    expect(a).toEqual({ file: "frames/0001_00-21.jpg", time: 21, stamp: "00:21", kind: "scene", chapter: "Slides", text: "[00:20] second slide" });
  });
});

describe("extractFrames", () => {
  const info = {
    id: "jNQXAC9IVRw",
    title: "Me at the zoo",
    duration: 300,
    webpage_url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    subtitles: { en: [] },
    automatic_captions: {},
    chapters: [
      { start_time: 0, end_time: 100, title: "Intro" },
      { start_time: 100, end_time: 300, title: "Elephants" },
    ],
  };
  const vtt =
    "WEBVTT\n\n00:12.000 --> 00:15.000\nhere we are in front of the elephants, and the elephants are big and grey and loud today\n\n00:01:40.000 --> 00:01:45.000\nthey have really long trunks, really really long trunks, which is the cool thing about them\n\n00:04:05.000 --> 00:04:12.000\nand that is all there is to say about the elephants at the zoo this afternoon\n";
  // The pictures each candidate "shows", in time order: the chapter frame at
  // 101 s repeats the scene at 102 s, which must be dropped as a near-duplicate.
  const ramp = image((x) => 255 - x * 25);
  const checker = image((x, y) => ((x + y) % 2 ? 200 : 20));
  const bars = image((x) => (x < 4 ? 250 : 10));

  let root: string;
  let calls: string[][];
  const runner = (opts: { noVideo?: boolean } = {}): VideoRunner => {
    return async (cmd, args) => {
      calls.push([cmd, ...args]);
      const ok = { ok: true, status: 0, stdout: "", stderr: "" };
      if (cmd === "yt-dlp" && args.includes("-J")) return { ...ok, stdout: JSON.stringify(info) };
      if (cmd === "yt-dlp" && args.includes("--write-subs")) {
        const o = args[args.indexOf("-o") + 1]!;
        writeFileSync(join(dirname(o), "sub.en.vtt"), vtt);
        return ok;
      }
      if (cmd === "yt-dlp") {
        if (!opts.noVideo) writeFileSync(join(dirname(args[args.indexOf("-o") + 1]!), "video.mp4"), "mp4");
        return opts.noVideo ? { ok: false, status: 1, stdout: "", stderr: "ERROR: HTTP Error 403: Forbidden" } : ok;
      }
      const out = args[args.length - 1]!;
      if (args.includes("rawvideo")) {
        // candidates in time order: 0:13 scene, 1:41 chapter, 1:42 scene, 4:10 scene
        writeFileSync(out, Buffer.concat([ramp, checker, checker, bars].map((b) => Buffer.from(b))));
        return ok;
      }
      if (args.includes("-frames:v")) {
        writeFileSync(out, "jpg-chapter");
        return ok;
      }
      if (args.some((a) => a.startsWith("select="))) {
        const dir = dirname(out);
        for (const n of ["0001", "0002", "0003"]) writeFileSync(join(dir, `${n}.jpg`), `jpg-${n}`);
        return { ...ok, stderr: SHOWINFO };
      }
      return { ok: false, status: 1, stdout: "", stderr: `unexpected ${cmd}` };
    };
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "video-frames-"));
    calls = [];
    setVideoDeps({ run: runner(), have: () => true });
  });
  afterEach(() => {
    setVideoDeps();
    resetVideoLadderCache();
    resetNoWrite();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps scene and chapter frames, drops near-duplicates, and aligns them with the transcript", async () => {
    const run = await fetchVideoRun("https://youtu.be/jNQXAC9IVRw", root);
    if (!run.ok) throw new Error(run.reason);
    const r = await extractFrames(run.dir, { effort: "low" });
    if (!r.ok) throw new Error(r.reason);
    // 3 scenes + 2 chapter starts, and only 4 hashes for 5 candidates: dedupe is skipped rather than misapplied.
    expect(r.candidates).toBe(5);
    expect(readdirSync(join(run.dir, "frames"))).toEqual(r.frames.map((f) => f.file.slice("frames/".length)));
    const md = readFileSync(r.markdown, "utf8");
    expect(md).toContain("# Me at the zoo — frames");
    expect(md).toContain("![00:13](frames/");
    expect(md).toContain("> [00:12] here we are in front of the elephants");
    expect(JSON.parse(readFileSync(join(run.dir, "frames.json"), "utf8"))).toEqual(r.frames);
    // The video was downloaded after --, at 720p at most, and is gone with its temp dir.
    const dl = calls.find((c) => c[0] === "yt-dlp" && c.includes(VIDEO_FORMAT))!;
    expect(dl.slice(-2)).toEqual(["--", "https://www.youtube.com/watch?v=jNQXAC9IVRw"]);
    expect(existsSync(dirname(dl[dl.indexOf("-o") + 1]!))).toBe(false);
  });

  it("drops a near-duplicate when every candidate was hashed", async () => {
    const run = await fetchVideoRun("https://youtu.be/jNQXAC9IVRw", root);
    if (!run.ok) throw new Error(run.reason);
    // One chapter only, so there are exactly four candidates for the four hashes.
    writeFileSync(join(run.dir, "meta.json"), JSON.stringify({ ...run.meta, chapters: [{ start: 100, end: 300, title: "Elephants" }] }));
    const r = await extractFrames(run.dir);
    if (!r.ok) throw new Error(r.reason);
    expect(r.candidates).toBe(4);
    expect(r.duplicates).toBe(1);
    expect(r.frames.map((f) => [f.stamp, f.kind])).toEqual([
      ["00:13", "scene"],
      ["01:41", "chapter"],
      ["04:10", "scene"],
    ]);
    expect(r.frames[1]!.file).toBe("frames/0002_01-41.jpg");
    expect(r.frames[1]!.chapter).toBe("Elephants");
  });

  it("tries the video download a second time after a stray 403", async () => {
    const run = await fetchVideoRun("https://youtu.be/jNQXAC9IVRw", root);
    if (!run.ok) throw new Error(run.reason);
    let downloads = 0;
    const flaky = runner();
    setVideoDeps({
      run: async (cmd, args, opts) => {
        if (cmd === "yt-dlp" && args.includes(VIDEO_FORMAT) && downloads++ === 0) {
          return { ok: false, status: 1, stdout: "", stderr: "ERROR: unable to download video data: HTTP Error 403: Forbidden" };
        }
        return flaky(cmd, args, opts);
      },
      have: () => true,
    });
    expect((await extractFrames(run.dir)).ok).toBe(true);
    expect(downloads).toBe(2);
  });

  it("never takes a download's leftover fragments for the video", async () => {
    const run = await fetchVideoRun("https://youtu.be/jNQXAC9IVRw", root);
    if (!run.ok) throw new Error(run.reason);
    const base = runner();
    const fragments =
      (status: number): VideoRunner =>
      async (cmd, args, opts) => {
        if (cmd === "yt-dlp" && args.includes(VIDEO_FORMAT)) {
          const dir = dirname(args[args.indexOf("-o") + 1]!);
          writeFileSync(join(dir, "video.f136.mp4.part-Frag7"), "half");
          writeFileSync(join(dir, "video.f136.mp4"), "video only, never merged");
          return { ok: status === 0, status, stdout: "", stderr: status === 124 ? "timed out after 1000ms" : "" };
        }
        return base(cmd, args, opts);
      };
    setVideoDeps({ run: fragments(124), have: () => true });
    expect(await extractFrames(run.dir)).toEqual({ ok: false, reason: "the video download failed: timed out" });
    setVideoDeps({ run: fragments(0), have: () => true });
    expect(await extractFrames(run.dir)).toMatchObject({ ok: false, reason: expect.stringContaining("yt-dlp wrote no file") });
  });

  it("downloads from the caller's URL, and never with the catch-all extractor under a policy", async () => {
    const run = await fetchVideoRun("https://youtu.be/jNQXAC9IVRw", root);
    if (!run.ok) throw new Error(run.reason);
    // A meta.json on disk naming some other page is not what gets downloaded.
    writeFileSync(join(run.dir, "meta.json"), JSON.stringify({ ...run.meta, webpageUrl: "https://attacker.example/x" }));
    calls.length = 0;
    await extractFrames(run.dir, { url: "https://youtu.be/jNQXAC9IVRw", knownHostsOnly: true });
    const dl = calls.find((c) => c[0] === "yt-dlp" && c.includes(VIDEO_FORMAT))!;
    expect(dl.slice(-2)).toEqual(["--", "https://www.youtube.com/watch?v=jNQXAC9IVRw"]);
    expect(dl.slice(1, 3)).toEqual(["--use-extractors", "default,-generic"]);
    // With no URL and a policy, an unknown page named on disk is refused outright.
    expect(await extractFrames(run.dir, { knownHostsOnly: true })).toMatchObject({ ok: false, reason: expect.stringContaining("names no page") });
  });

  it("caps the frames by effort", async () => {
    const run = await fetchVideoRun("https://youtu.be/jNQXAC9IVRw", root);
    if (!run.ok) throw new Error(run.reason);
    const r = await extractFrames(run.dir, { effort: "low" });
    expect(r.ok && r.frames.length).toBeLessThanOrEqual(20);
  });

  it("says why when it cannot", async () => {
    expect(await extractFrames(join(root, "nothing-here"))).toMatchObject({ ok: false, reason: expect.stringContaining("no video run") });
    const run = await fetchVideoRun("https://youtu.be/jNQXAC9IVRw", root);
    if (!run.ok) throw new Error(run.reason);
    setVideoDeps({ run: runner(), have: (c) => c !== "ffmpeg" });
    expect(await extractFrames(run.dir)).toEqual({ ok: false, reason: "frames need ffmpeg" });
    setVideoDeps({ run: runner({ noVideo: true }), have: () => true });
    expect(await extractFrames(run.dir)).toMatchObject({ ok: false, reason: expect.stringContaining("the video download failed: YouTube refused yt-dlp") });
    setNoWrite(true);
    expect(await extractFrames(run.dir)).toMatchObject({ ok: false, reason: expect.stringContaining("NO_WRITE") });
  });
});
