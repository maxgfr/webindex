import { describe, expect, it } from "vitest";
import { formatStamp, transcriptMarkdown, type VideoTranscript } from "../src/video.js";

describe("formatStamp", () => {
  it.each([
    [0, "00:00"],
    [5.9, "00:05"],
    [65, "01:05"],
    [3599, "59:59"],
    [3600, "1:00:00"],
    [3723.5, "1:02:03"],
    [-3, "00:00"],
    [Number.NaN, "00:00"],
  ])("%s s → %s", (s, out) => {
    expect(formatStamp(s)).toBe(out);
  });
});

const transcript = (over: Partial<VideoTranscript> = {}): VideoTranscript => ({
  text: "",
  segments: [
    { start: 1.2, end: 3, text: "All right, so here we are." },
    { start: 5.3, end: 12, text: "The cool thing about these guys." },
    { start: 17, end: 19, text: "That's all." },
  ],
  chapters: [
    { start: 0, end: 5, title: "Intro" },
    { start: 5, end: 17, title: "The cool thing" },
    { start: 17, end: 19, title: "End" },
  ],
  meta: {
    id: "jNQXAC9IVRw",
    title: "Me at the zoo",
    channel: "jawed",
    uploadDate: "2005-04-24",
    duration: 19,
    chapters: [],
    subtitles: ["en"],
    autoCaptions: [],
    webpageUrl: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  },
  via: "manual-subs",
  ...over,
});

describe("transcriptMarkdown", () => {
  it("writes the header, one heading per chapter and stamped paragraphs", () => {
    expect(transcriptMarkdown(transcript())).toBe(
      [
        "# Me at the zoo",
        "",
        "- Channel: jawed",
        "- Published: 2005-04-24",
        "- Duration: 00:19",
        "- URL: https://www.youtube.com/watch?v=jNQXAC9IVRw",
        "- Transcript: manual subtitles (manual-subs)",
        "",
        "## Intro",
        "",
        "[00:01] All right, so here we are.",
        "",
        "## The cool thing",
        "",
        "[00:05] The cool thing about these guys.",
        "",
        "## End",
        "",
        "[00:17] That's all.",
        "",
      ].join("\n"),
    );
  });

  it("writes no heading without chapters, and skips a chapter with nothing in it", () => {
    const md = transcriptMarkdown(transcript({ chapters: [] }));
    expect(md).not.toContain("##");
    const skipped = transcriptMarkdown(
      transcript({
        chapters: [
          { start: 0, end: 1, title: "Cold open" },
          { start: 1, end: 5, title: "Intro" },
          { start: 5, end: 19, title: "Rest" },
        ],
      }),
    );
    expect(skipped).not.toContain("Cold open");
    expect(skipped).toContain("## Intro\n\n[00:01]");
  });

  it("is empty when there is no transcript", () => {
    expect(transcriptMarkdown(transcript({ segments: [] }))).toBe("");
  });
});
