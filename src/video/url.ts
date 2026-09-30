// Which URLs are YouTube videos, playlists or channels.
//
// Decided from the URL alone, before anything runs: `fetchAndExtract` asks this
// on every URL it is given, so it has to be cheap, and a false positive would
// hand an ordinary page to yt-dlp. Hosts are matched exactly (a subdomain of
// youtube.com, never a look-alike such as notyoutube.com), and an id has to be
// the eleven characters YouTube issues.

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

// youtube.com and its subdomains (www, m, music), and the privacy-enhanced
// embed host. youtu.be is handled apart: its id is the path itself.
const YOUTUBE_HOSTS = ["youtube.com", "youtube-nocookie.com"];

function parse(url: string): URL | undefined {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u : undefined;
  } catch {
    return undefined;
  }
}

function isYoutubeHost(host: string): boolean {
  const h = host.toLowerCase();
  return YOUTUBE_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
}

/**
 * The video id a YouTube URL points at, or undefined when it names no single
 * video. Reads `watch?v=`, `youtu.be/<id>`, and the `/shorts/`, `/embed/`,
 * `/live/` and `/v/` paths, on youtube.com, its subdomains (www, m, music) and
 * youtube-nocookie.com.
 */
export function youtubeVideoId(url: string): string | undefined {
  const u = parse(url);
  if (!u) return undefined;
  const host = u.hostname.toLowerCase();
  let id: string | undefined;
  if (host === "youtu.be" || host === "www.youtu.be") id = u.pathname.split("/")[1];
  else if (isYoutubeHost(host)) {
    if (u.pathname === "/watch") id = u.searchParams.get("v") ?? undefined;
    else id = /^\/(?:shorts|embed|live|v)\/([^/]+)/.exec(u.pathname)?.[1];
  }
  return id && VIDEO_ID.test(id) ? id : undefined;
}

/**
 * Whether a YouTube URL names a list of videos: a `playlist` (any URL carrying
 * `list=`) or a `channel` (`/@handle`, `/channel/`, `/c/`, `/user/`).
 * Undefined for anything else, a single video included.
 */
export function youtubeListKind(url: string): "playlist" | "channel" | undefined {
  const u = parse(url);
  if (!u || !isYoutubeHost(u.hostname)) return undefined;
  if (u.searchParams.get("list")) return "playlist";
  if (/^\/(?:@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/.test(u.pathname)) return "channel";
  return undefined;
}
