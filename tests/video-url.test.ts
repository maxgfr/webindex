import { describe, expect, it } from "vitest";
import { knownVideo, videoRunKey, videoSource, videoUrlAt, youtubeListKind, youtubeVideoId } from "../src/video.js";

describe("youtubeVideoId", () => {
  it.each([
    ["https://www.youtube.com/watch?v=jNQXAC9IVRw", "jNQXAC9IVRw"],
    ["https://youtube.com/watch?v=jNQXAC9IVRw&t=42s", "jNQXAC9IVRw"],
    ["https://m.youtube.com/watch?feature=share&v=jNQXAC9IVRw", "jNQXAC9IVRw"],
    ["https://music.youtube.com/watch?v=jNQXAC9IVRw&list=RDAMVM", "jNQXAC9IVRw"],
    ["https://youtu.be/jNQXAC9IVRw", "jNQXAC9IVRw"],
    ["https://youtu.be/jNQXAC9IVRw?si=abc&t=3", "jNQXAC9IVRw"],
    ["https://www.youtube.com/shorts/jNQXAC9IVRw", "jNQXAC9IVRw"],
    ["https://www.youtube.com/embed/jNQXAC9IVRw?start=4", "jNQXAC9IVRw"],
    ["https://www.youtube-nocookie.com/embed/jNQXAC9IVRw", "jNQXAC9IVRw"],
    ["https://www.youtube.com/live/jNQXAC9IVRw", "jNQXAC9IVRw"],
    ["https://www.youtube.com/v/jNQXAC9IVRw", "jNQXAC9IVRw"],
    ["http://www.youtube.com/watch?v=jNQXAC9IVRw", "jNQXAC9IVRw"],
  ])("reads %s", (url, id) => {
    expect(youtubeVideoId(url)).toBe(id);
  });

  it.each([
    "https://www.youtube.com/",
    "https://www.youtube.com/watch?v=tooshort",
    "https://www.youtube.com/watch?v=jNQXAC9IVRw!",
    "https://www.youtube.com/playlist?list=PL123",
    "https://www.youtube.com/@TED",
    "https://example.com/watch?v=jNQXAC9IVRw",
    "https://notyoutube.com/watch?v=jNQXAC9IVRw",
    "https://youtu.be/",
    "ftp://youtu.be/jNQXAC9IVRw",
    "not a url",
    "",
  ])("refuses %s", (url) => {
    expect(youtubeVideoId(url)).toBeUndefined();
  });
});

describe("youtubeListKind", () => {
  it.each([
    ["https://www.youtube.com/playlist?list=PLOGi5-fAu8bFmzTdLqqHIdPNM3qG6HzWu", "playlist"],
    ["https://www.youtube.com/watch?v=jNQXAC9IVRw&list=PL123", "playlist"],
    ["https://www.youtube.com/@TED", "channel"],
    ["https://www.youtube.com/@TED/videos", "channel"],
    ["https://www.youtube.com/channel/UCAuUUnT6oDeKwE6v1NGQxug", "channel"],
    ["https://www.youtube.com/c/TED", "channel"],
    ["https://www.youtube.com/user/TEDtalksDirector", "channel"],
  ])("reads %s as a %s", (url, kind) => {
    expect(youtubeListKind(url)).toBe(kind);
  });

  it.each(["https://www.youtube.com/watch?v=jNQXAC9IVRw", "https://youtu.be/jNQXAC9IVRw", "https://example.com/@TED", "https://www.youtube.com/"])(
    "has no list in %s",
    (url) => {
      expect(youtubeListKind(url)).toBeUndefined();
    },
  );
});

describe("knownVideo", () => {
  it.each([
    ["https://youtu.be/jNQXAC9IVRw", { site: "youtube", url: "https://www.youtube.com/watch?v=jNQXAC9IVRw", key: "jNQXAC9IVRw" }],
    ["https://vimeo.com/76979871", { site: "vimeo", url: "https://player.vimeo.com/video/76979871", key: "vimeo-76979871" }],
    ["https://vimeo.com/76979871/abcdef1234", { site: "vimeo", url: "https://player.vimeo.com/video/76979871?h=abcdef1234", key: "vimeo-76979871" }],
    [
      "https://player.vimeo.com/video/76979871?h=abcdef1234",
      { site: "vimeo", url: "https://player.vimeo.com/video/76979871?h=abcdef1234", key: "vimeo-76979871" },
    ],
    ["https://vimeo.com/channels/staffpicks/76979871", { site: "vimeo", url: "https://player.vimeo.com/video/76979871", key: "vimeo-76979871" }],
    ["https://www.dailymotion.com/video/x7tgad0", { site: "dailymotion", url: "https://www.dailymotion.com/video/x7tgad0", key: "dailymotion-x7tgad0" }],
    ["https://dai.ly/x7tgad0", { site: "dailymotion", url: "https://www.dailymotion.com/video/x7tgad0", key: "dailymotion-x7tgad0" }],
    ["https://www.twitch.tv/videos/2000000000", { site: "twitch", url: "https://www.twitch.tv/videos/2000000000", key: "twitch-2000000000" }],
    ["https://www.twitch.tv/someone/clip/SomeClipSlug", { site: "twitch", url: "https://www.twitch.tv/someone/clip/SomeClipSlug" }],
    ["https://www.tiktok.com/@someone/video/7123456789", { site: "tiktok", url: "https://www.tiktok.com/@someone/video/7123456789", key: "tiktok-7123456789" }],
    [
      "https://www.ted.com/talks/ken_robinson_do_schools_kill_creativity",
      { site: "ted", url: "https://www.ted.com/talks/ken_robinson_do_schools_kill_creativity", key: "ted-ken_robinson_do_schools_kill_creativity" },
    ],
    ["https://twitter.com/someone/status/1234567890", { site: "x", url: "https://x.com/someone/status/1234567890", key: "x-1234567890" }],
  ])("reads %s", (url, want) => {
    expect(knownVideo(url)).toEqual(want);
  });

  it.each([
    "https://vimeo.com/showcase/5541599",
    "https://vimeo.com/about",
    "https://www.dailymotion.com/playlist/x6hynp",
    "https://www.facebook.com/somepage",
    "https://www.twitch.tv/somechannel",
    "https://notvimeo.com/76979871",
    "https://example.com/video/123",
    "https://www.youtube.com/@TED",
  ])("does not take %s for a single video", (url) => {
    expect(knownVideo(url)).toBeUndefined();
  });
});

describe("videoSource", () => {
  it("takes any http(s) page when asked, and nothing else ever", () => {
    expect(videoSource("https://example.com/talk")).toBeUndefined();
    expect(videoSource("https://example.com/talk", { anySite: true })).toEqual({ site: "web", url: "https://example.com/talk" });
    for (const bad of ["--exec=rm", "file:///etc/passwd", "javascript:alert(1)", "ftp://x.y/z"])
      expect(videoSource(bad, { anySite: true }), bad).toBeUndefined();
  });

  it("keys a run by the YouTube id, else by site and id — and two pages never share one", () => {
    expect(videoRunKey("youtube", "jNQXAC9IVRw")).toBe("jNQXAC9IVRw");
    expect(videoRunKey("vimeo", "76979871")).toBe("vimeo-76979871");
    // yt-dlp's catch-all names both of these "intro".
    const a = videoRunKey("web", "intro", "https://a.com/talks/intro/");
    const b = videoRunKey("web", "intro", "https://b.org/course/intro");
    expect(a).toMatch(/^web-intro-[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
    // An id that had to be made filesystem-safe keeps what it lost, as a hash.
    expect(videoRunKey("vimeo", "../../etc")).toMatch(/^vimeo-.._.._etc-[0-9a-f]{8}$/);
    expect(videoRunKey("vimeo", "a b")).not.toBe(videoRunKey("vimeo", "a/b"));
  });
});

describe("videoUrlAt", () => {
  it("opens each site at the second, in its own form", () => {
    expect(videoUrlAt("https://www.youtube.com/watch?v=jNQXAC9IVRw", 61.9)).toBe("https://www.youtube.com/watch?v=jNQXAC9IVRw&t=61s");
    expect(videoUrlAt("https://player.vimeo.com/video/76979871", 5)).toBe("https://player.vimeo.com/video/76979871#t=5s");
    expect(videoUrlAt("https://www.dailymotion.com/video/x7tgad0", 30)).toBe("https://www.dailymotion.com/video/x7tgad0?start=30");
    expect(videoUrlAt("https://www.twitch.tv/videos/1", 3723)).toBe("https://www.twitch.tv/videos/1?t=1h2m3s");
    expect(videoUrlAt("https://example.com/v", 30)).toBe("https://example.com/v");
    expect(videoUrlAt("not a url", 3)).toBe("not a url");
  });
});
