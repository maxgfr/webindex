import { describe, expect, it } from "vitest";
import { youtubeListKind, youtubeVideoId } from "../src/video.js";

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
