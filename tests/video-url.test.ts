import { describe, expect, it } from "vitest";
import { isVideoList, knownVideo, videoRunKey, videoSource, videoUrlAt, youtubeListKind, youtubeVideoId } from "../src/video.js";

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
    ["https://www.twitch.tv/videos/2000000000", { site: "twitch", url: "https://www.twitch.tv/videos/2000000000" }],
    [
      "https://www.ted.com/talks/ken_robinson_do_schools_kill_creativity",
      { site: "ted", url: "https://www.ted.com/talks/ken_robinson_do_schools_kill_creativity" },
    ],
    ["https://x.com/someone/status/1234567890", { site: "x", url: "https://x.com/someone/status/1234567890" }],
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

  it("keys a run by the YouTube id, else by site and id", () => {
    expect(videoRunKey("youtube", "jNQXAC9IVRw")).toBe("jNQXAC9IVRw");
    expect(videoRunKey("vimeo", "76979871")).toBe("vimeo-76979871");
    expect(videoRunKey("web", "../../etc")).toBe("web-.._.._etc");
  });
});

describe("videoUrlAt and isVideoList", () => {
  it("opens each site at the second, in its own form", () => {
    expect(videoUrlAt("https://www.youtube.com/watch?v=jNQXAC9IVRw", 61.9)).toBe("https://www.youtube.com/watch?v=jNQXAC9IVRw&t=61s");
    expect(videoUrlAt("https://player.vimeo.com/video/76979871", 5)).toBe("https://player.vimeo.com/video/76979871#t=5s");
    expect(videoUrlAt("https://www.dailymotion.com/video/x7tgad0", 30)).toBe("https://www.dailymotion.com/video/x7tgad0?start=30");
    expect(videoUrlAt("https://www.twitch.tv/videos/1", 3723)).toBe("https://www.twitch.tv/videos/1?t=1h2m3s");
    expect(videoUrlAt("https://example.com/v", 30)).toBe("https://example.com/v");
    expect(videoUrlAt("not a url", 3)).toBe("not a url");
  });

  it("recognises lists on any site, and never a single video", () => {
    expect(isVideoList("https://www.youtube.com/playlist?list=PLx")).toBe(true);
    expect(isVideoList("https://vimeo.com/showcase/5541599")).toBe(true);
    expect(isVideoList("https://www.dailymotion.com/playlist/x6hynp")).toBe(true);
    expect(isVideoList("https://vimeo.com/76979871")).toBe(false);
    expect(isVideoList("https://example.com/about")).toBe(false);
  });
});
