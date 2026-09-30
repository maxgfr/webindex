// Which URLs are videos, playlists or channels.
//
// YouTube is read from the URL alone, before anything runs: `fetchAndExtract`
// asks this on every URL it is given, so it has to be cheap, and a false
// positive would hand an ordinary page to yt-dlp. Hosts are matched exactly
// (a subdomain of youtube.com, never a look-alike such as notyoutube.com), and
// an id has to be the eleven characters YouTube issues.
//
// Every other site yt-dlp reads goes through the same engine. The common video
// hosts are recognised here too — so a Vimeo or Dailymotion link given to
// `fetch` is read as a video rather than as its (usually bot-walled) page —
// and the explicit video commands accept any http(s) URL, leaving it to
// yt-dlp to say whether there is a video there.

import { fnv1a64 } from "../url.js";

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

const onHost = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

function isYoutubeHost(host: string): boolean {
  const h = host.toLowerCase();
  return YOUTUBE_HOSTS.some((d) => onHost(h, d));
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

/** A video URL resolved to what yt-dlp is handed, and — when the URL alone says — the run it is kept under. */
export interface VideoSource {
  /** `youtube`, `vimeo`, `dailymotion`… — the host's short name; `web` for a site this module does not know. */
  site: string;
  /** The URL yt-dlp reads: a canonical form rebuilt from the id where there is one, else the URL as given. */
  url: string;
  /** The run directory's name (`dQw4w9WgXcQ`, `vimeo-76979871`), when the URL alone determines it. */
  key?: string;
}

// The common video hosts, each with the pattern of a single video's page and,
// where the id can be read from it, the canonical URL to hand yt-dlp.
interface HostRule {
  site: string;
  domains: string[];
  video: RegExp;
  canonical?: (m: RegExpExecArray, u: URL) => { id: string; url: string };
}

const HOSTS: HostRule[] = [
  {
    site: "vimeo",
    domains: ["vimeo.com"],
    // vimeo.com/<id>, vimeo.com/<id>/<hash> (unlisted), vimeo.com/channels/<c>/<id>,
    // vimeo.com/groups/<g>/videos/<id>, player.vimeo.com/video/<id>.
    video: /^\/(?:video\/|channels\/[^/]+\/|groups\/[^/]+\/videos\/)?(\d{5,})(?:\/([0-9a-f]{6,}))?\/?$/,
    // The player URL, because vimeo.com's own page now answers yt-dlp with a
    // login wall while the player serves a public video — and its subtitles.
    canonical: (m, u) => {
      const hash = m[2] ?? u.searchParams.get("h") ?? undefined;
      return { id: m[1]!, url: `https://player.vimeo.com/video/${m[1]}${hash ? `?h=${hash}` : ""}` };
    },
  },
  {
    site: "dailymotion",
    domains: ["dailymotion.com"],
    video: /^\/(?:embed\/)?video\/([a-z0-9]{5,})(?:_[^/]*)?\/?$/i,
    canonical: (m) => ({ id: m[1]!, url: `https://www.dailymotion.com/video/${m[1]}` }),
  },
  {
    site: "dailymotion",
    domains: ["dai.ly"],
    video: /^\/([a-z0-9]{5,})\/?$/i,
    canonical: (m) => ({ id: m[1]!, url: `https://www.dailymotion.com/video/${m[1]}` }),
  },
  // Where the URL names the video, its key does too: a video read once is
  // reused with no yt-dlp call at all, as on YouTube.
  {
    site: "twitch",
    domains: ["twitch.tv"],
    video: /^\/videos\/(\d+)\/?$/,
    canonical: (m) => ({ id: m[1]!, url: `https://www.twitch.tv/videos/${m[1]}` }),
  },
  { site: "twitch", domains: ["twitch.tv"], video: /^\/[^/]+\/clip\/[^/]+\/?$/ },
  {
    site: "ted",
    domains: ["ted.com"],
    video: /^\/talks\/([\w-]+)\/?$/,
    canonical: (m) => ({ id: m[1]!, url: `https://www.ted.com/talks/${m[1]}` }),
  },
  {
    site: "loom",
    domains: ["loom.com"],
    video: /^\/(?:share|embed)\/([0-9a-f]{16,})\/?$/,
    canonical: (m) => ({ id: m[1]!, url: `https://www.loom.com/share/${m[1]}` }),
  },
  {
    site: "tiktok",
    domains: ["tiktok.com"],
    video: /^\/(@[^/]+)\/video\/(\d+)\/?$/,
    canonical: (m) => ({ id: m[2]!, url: `https://www.tiktok.com/${m[1]}/video/${m[2]}` }),
  },
  { site: "instagram", domains: ["instagram.com"], video: /^\/(?:reel|reels|tv)\/[\w-]+\/?$/ },
  { site: "facebook", domains: ["facebook.com"], video: /^\/(?:[^/]+\/videos\/[^/]+|reel\/\d+)\/?$/ },
  { site: "facebook", domains: ["fb.watch"], video: /^\/[\w-]{6,}\/?$/ },
  {
    site: "x",
    domains: ["x.com", "twitter.com"],
    video: /^\/([^/]+)\/status\/(\d+)(?:\/video\/\d)?\/?$/,
    canonical: (m) => ({ id: m[2]!, url: `https://x.com/${m[1]}/status/${m[2]}` }),
  },
  { site: "bilibili", domains: ["bilibili.com"], video: /^\/video\/(?:BV\w+|av\d+)\/?$/i },
  { site: "rumble", domains: ["rumble.com"], video: /^\/v[\w-]+\.html$/ },
  { site: "peertube", domains: ["framatube.org", "tilvids.com"], video: /^\/(?:w|videos\/watch)\/[\w-]+\/?$/ },
];

const safeKey = (site: string, id: string) => `${site}-${id}`.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
const shortHash = (text: string) => fnv1a64(text).toString(16).padStart(16, "0").slice(0, 8);

/**
 * A single video on a host this module knows — YouTube or one of the common
 * video sites — resolved to the URL yt-dlp reads and, where the URL gives the
 * id, its run key. Undefined for anything else, a playlist or a channel
 * included.
 */
export function knownVideo(url: string): VideoSource | undefined {
  const id = youtubeVideoId(url);
  if (id) return { site: "youtube", url: `https://www.youtube.com/watch?v=${id}`, key: id };
  const u = parse(url);
  if (!u) return undefined;
  const host = u.hostname.toLowerCase();
  for (const rule of HOSTS) {
    if (!rule.domains.some((d) => onHost(host, d))) continue;
    const m = rule.video.exec(u.pathname);
    if (!m) continue;
    if (!rule.canonical) return { site: rule.site, url: u.toString() };
    const c = rule.canonical(m, u);
    return { site: rule.site, url: c.url, key: safeKey(rule.site, c.id) };
  }
  return undefined;
}

/**
 * The URL an explicit video command may hand yt-dlp: a known video host's,
 * canonicalised; with `anySite`, any other http(s) URL too, as given (yt-dlp
 * then says whether there is a video there). Undefined for anything that is
 * not http(s) — no string starting with `-` can get through.
 */
export function videoSource(url: string, opts: { anySite?: boolean } = {}): VideoSource | undefined {
  const known = knownVideo(url);
  if (known) return known;
  if (!opts.anySite) return undefined;
  const u = parse(url);
  return u ? { site: "web", url: u.toString() } : undefined;
}

/**
 * The run key of a video yt-dlp has read: its YouTube id as is, else
 * `<site>-<id>`. yt-dlp's catch-all extractor names a page by its last path
 * segment — `a.com/talks/intro` and `b.org/course/intro` are both `intro` — so
 * a `web` key, and any id that had to be made filesystem-safe, also carries a
 * hash of the page it came from: two pages never share a run.
 */
export function videoRunKey(site: string, id: string, pageUrl?: string): string {
  if (site === "youtube" && VIDEO_ID.test(id)) return id;
  const key = safeKey(site, id);
  const altered = key !== `${site}-${id}`;
  return site === "web" || altered ? `${key.slice(0, 110)}-${shortHash(pageUrl ?? id)}` : key;
}

/**
 * The watch URL opened at `seconds`, in the form each site understands:
 * YouTube `?t=`, Vimeo `#t=`, Dailymotion `?start=`, Twitch `?t=0h1m2s`. A site
 * with no known form gets its URL unchanged.
 */
export function videoUrlAt(webpageUrl: string, seconds: number): string {
  const t = Math.max(0, Math.floor(seconds));
  const u = parse(webpageUrl);
  if (!u) return webpageUrl;
  const host = u.hostname.toLowerCase();
  if (isYoutubeHost(host) || host === "youtu.be") u.searchParams.set("t", `${t}s`);
  else if (onHost(host, "vimeo.com")) u.hash = `t=${t}s`;
  else if (onHost(host, "dailymotion.com")) u.searchParams.set("start", String(t));
  else if (onHost(host, "twitch.tv")) u.searchParams.set("t", `${Math.floor(t / 3600)}h${Math.floor((t % 3600) / 60)}m${t % 60}s`);
  else return webpageUrl;
  return u.toString();
}
