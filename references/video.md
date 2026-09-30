# Video

A video URL becomes citable text: a transcript with a `[mm:ss]` stamp on every
paragraph, the frames that show what was on screen, and a corpus when there are
several videos. Everything runs on this machine through
[yt-dlp](https://github.com/yt-dlp/yt-dlp): no API, no key.

## Which sites

Anything yt-dlp reads — YouTube, and [its hundreds of other
sites](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md).

- **`fetch`** (and `webindex_fetch`) sends the common video hosts to the
  transcript ladder by their URL alone: YouTube, Vimeo, Dailymotion, Twitch
  (videos, clips), TED talks, Loom, TikTok, Instagram reels, Facebook videos, X
  posts, Bilibili, Rumble and a few PeerTube instances. Every other URL is read
  as a page, as before. A post on one of those hosts that turns out to hold no
  video (a text-only tweet) is read as the page it is, with a note.
- **`video fetch|frames|list`** take any http(s) URL and let yt-dlp decide.
  Under an MCP policy (`--public-only`, `--extract-root`, `--allow-remote`) the
  video tools read only the known hosts, and lists only YouTube's: yt-dlp
  follows its own redirects, where the public-address check cannot see them.
- **Vimeo** is read through its player (`player.vimeo.com/video/<id>`, with the
  `?h=` of an unlisted link): `vimeo.com`'s own page now asks yt-dlp to log in.
  Some Vimeo videos are served under DRM: their subtitles read, their picture
  and sound (frames, whisper) cannot — the note says so.
- **Subtitles** in WebVTT or SRT (Dailymotion serves only SRT). Auto-captions
  are YouTube's; elsewhere a video without subtitles goes to whisper.
- **Run keys**: a YouTube run is kept under its id, any other under
  `<site>-<id>` (`vimeo-76979871`, `dailymotion-x7tgad0`). A known host's run is
  reused with no yt-dlp call; any other page costs one probe to learn its key.
- **Links** open at the second in each site's own form: YouTube `?t=`, Vimeo
  `#t=`, Dailymotion `?start=`, Twitch `?t=1h2m3s`.

## The transcript ladder

`webindex fetch <video-url>` (and `webindex_fetch`, and every tool that vendors
the engine) reads a video by trying three rungs in order, stopping at the first
whose output passes the quality gate:

| Rung | What it reads | Cost |
|---|---|---|
| `manual-subs` | subtitles the site carries (WebVTT or SRT): the requested language (`--lang`), else the video's own, else English, else the first listed | seconds |
| `auto-subs` | YouTube's speech recognition **in the video's own language** (`<lang>-orig`), never one of its machine translations | seconds |
| `whisper` | a local transcription: yt-dlp fetches the audio, ffmpeg makes it 16 kHz mono, `uvx whisper-ctranslate2` transcribes it | minutes, plus the model the first time (`small` is ~500 MB) |

- **The gate**: a transcript must be non-empty and, past a minute, hold at least
  5 words a minute. It judges emptiness, not eloquence — a music video's three
  captioned lines fall through to whisper instead of passing for its transcript.
- **Rolling auto-captions** repeat each line two or three times on screen; only
  what a cue adds is kept, while a line said twice on purpose survives.
- **A translation is labelled.** The header names the track (`track fr`), and a
  track in another language than the video's says so: quoting a translation as
  the speaker's words is a misquotation.
- **Chapters** become `##` headings, and no paragraph straddles a chapter start.
- **Live streams** are left until they have ended.
- **Whisper is budgeted**: `WEBINDEX_WHISPER_MAX` videos per process (default 3),
  `WEBINDEX_WHISPER_TIMEOUT_MS` for all of one video (default 30 min). A
  cancelled call kills yt-dlp, ffmpeg and whisper where they stand.
- `WEBINDEX_VIDEO_ENGINES` picks and orders the rungs (`auto-subs,whisper`,
  `none`); `doctor` shows what each will do here and how old yt-dlp is.

## Errors are reasons

Nothing throws. Each failure comes back as a note saying which:

| Note | What to do |
|---|---|
| `install yt-dlp` | install it (`brew install yt-dlp`, `pipx install yt-dlp`) |
| `YouTube refused yt-dlp` (403, "Sign in to confirm you're not a bot", PO token) | update yt-dlp (`yt-dlp -U`; `doctor` flags a release older than 60 days), or `WEBINDEX_YTDLP_ARGS="--cookies-from-browser firefox"` |
| `the site asks yt-dlp to log in` | a signed-in session: `WEBINDEX_YTDLP_ARGS="--cookies-from-browser firefox"` |
| `the site serves this video under DRM` | subtitles still read; frames and whisper cannot |
| `no video at this URL (yt-dlp found none)` | the page holds no video yt-dlp can read |
| `a list of videos, not one` | read it with `video list` |
| `private video`, `members-only video`, `video removed`, `video unavailable` | nothing — the video is not readable |
| `age-restricted video` | a signed-in session: `WEBINDEX_YTDLP_ARGS="--cookies-from-browser firefox"` |
| `no subtitles, and whisper needs uvx and ffmpeg` | install [uv](https://docs.astral.sh/uv/) and ffmpeg |
| `transcript too sparse` | music or a silent video; the frames may say more than the words |

`WEBINDEX_YTDLP_ARGS` is appended to every yt-dlp call, split on whitespace.

## Runs: read once, ask many times

`webindex video fetch <url>` keeps the video in `<dir>/<videoId>/`:

- `TRANSCRIPT.md` — what `fetch` prints; read this to summarise;
- `segments.json` — every timed segment, `{start, end, text}` in seconds;
- `meta.json` — title, channel, date, duration, chapters, tracks, the rung, when.

A second `fetch` of the same video runs no yt-dlp at all (`--refresh` to read it
again). `webindex video search <question>` then ranks ~45 s passages of every
kept video with BM25F and prints each with its stamp and a link that opens the
video there — the way to answer a follow-up question without reading the video
again. The directory is `--out`, else `WEBINDEX_VIDEO_DIR`, else
`<tmp>/<brand>/video`.

## Frames: what was on screen

`webindex video frames <url|id|dir> [--effort low|med|high]` downloads the video
at 720p at most (to a temp directory, removed afterwards) and keeps:

1. a frame at every scene change (ffmpeg's scene score above 0.3) and just after
   every chapter start — evenly spaced ones for a video with neither;
2. minus near-duplicates: a 64-bit dHash per frame, ffmpeg doing the shrinking to
   9×8 grey, and a Hamming distance of 6 or less is the same picture;
3. at most 20 / 50 / 100 frames (`--effort`, `med` by default), the most widely
   spaced first.

They land in `<id>/frames/NNNN_mm-ss.jpg`. `FRAMES.md` pairs each frame with what
was said from 5 s before it to 10 s after — a slide appears as the speaker starts
on it — and `frames.json` holds the same as data. Read the images: slides, code
and diagrams are evidence the transcript does not carry.

## Several videos

`webindex video list <playlist|channel> [--limit n]` lists the first `n` videos
(a channel's `/videos` tab when the URL names none) without reading them, then
reads each as its own run, two at a time, and writes `CORPUS.md` and
`corpus.json` naming them `V1`…`Vn` in listing order. A video that cannot be read
keeps its label with the reason, so the numbering never shifts under an answer.
`video search` on that directory labels its hits `V1`…`Vn`.

## Over MCP

`webindex_video_fetch`, `webindex_video_search`, `webindex_video_frames` and
`webindex_video_list` do the same. The three that keep a run on disk are the only
tools not annotated read-only, and frames and list — which replace a video's
earlier frames and a directory's earlier corpus — are annotated destructive.
Under `WEBINDEX_NO_WRITE`, fetch returns the transcript without writing it,
and frames and list refuse: their output is files. Under `--public-only`, `--extract-root` or
`--allow-remote`, their `dir` is a directory *name* inside the video root, never
a path, and the video URL passes the public-address check before yt-dlp runs.

## Citing

A claim about a video cites its stamp: `[12:34]`, or `[V2 12:34]` across a
corpus. The stamp is a segment's start; the passage a search returns, and the
frame a stamp sits next to, are the evidence to quote. The `ultrawatch` skill
checks such citations against the run: every stamp must fall inside a segment of
the video it names.
