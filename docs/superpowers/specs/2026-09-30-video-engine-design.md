# Video engine — design

Issue: #7. Status: draft for review.

## Goal

Turn a YouTube URL into citable, timestamped text inside webindex, so every
skill that vendors the engine (ultrasearch, ultradoc, ultraprospect, and the
coming ultrawatch) and the MCP server get video for free. Four uses: summarise
a video, extract what is on screen, answer questions about a video already
read, and work across several videos.

Transcription stays on the machine: subtitles through yt-dlp, and a local
faster-whisper as the last rung. No API, no key.

## Shape

A new `src/video/` directory, modelled on `src/pdf/`, behind a `src/video.ts`
public surface re-exported from `src/index.ts`.

| Module | Role |
|---|---|
| `video/url.ts` | `youtubeVideoId(url)` (ported from siphon), `youtubeListKind(url)` → `playlist` / `channel` / undefined |
| `video/ytdlp.ts` | `yt-dlp` presence and version age; metadata (`-J --skip-download`); one subtitle track to a temp dir (`--load-info-json`, so the page is not extracted twice); audio for whisper; flat playlist listing |
| `video/vtt.ts` | WebVTT → `{start, end, text}` segments: strips `<c>` and `<00:00:01.234>` tags, drops the rolling repetition of auto-captions, merges cues into sentence-sized segments |
| `video/whisper.ts` | audio → 16 kHz mono WAV (ffmpeg) → `uvx whisper-ctranslate2 --output_format json` → segments. Model from `WEBINDEX_WHISPER_MODEL` (default `small`), a per-process budget `WEBINDEX_WHISPER_MAX` (default 3) and a timeout `WEBINDEX_WHISPER_TIMEOUT_MS`, as `pdf/ocr.ts` does for OCR |
| `video/ladder.ts` | `manual-subs → auto-subs → whisper`, with a `dead` map for missing tools, an order overridable by `WEBINDEX_VIDEO_ENGINES` (reusing `enginesFromEnv`), and a quality gate. Returns `{ text, segments, chapters, meta, via, reason }`, never throws |
| `video/markdown.ts` | metadata header, one `## <chapter>` per chapter, paragraphs stamped `[mm:ss]` (`[h:mm:ss]` past an hour) |
| `video/run.ts` (PR 2) | write and reuse `<dir>/<videoId>/{TRANSCRIPT.md, segments.json, meta.json}`; passage search |
| `video/frames.ts`, `video/dhash.ts`, `video/align.ts` (PR 3) | scene-change frames, dedupe, alignment |
| `video/list.ts` (PR 4) | playlist / channel → per-video runs → `CORPUS.md` |

### Language choice

The `-J` metadata lists every track, so exactly one is downloaded:

1. manual subtitles in the requested language (`--lang`), else the video's own
   language (`language` field), else English, else the first manual track;
2. auto-captions in the video's own language (`<lang>-orig` or `<lang>`), never
   one of YouTube's machine translations;
3. whisper, with the video's language when known, auto-detect otherwise.

### Quality gate

A rung is accepted when its transcript is non-empty and, for a video longer
than a minute, holds at least 5 words per minute. A music video with sparse
lyrics can therefore fall through to whisper, and when nothing passes the
reason says so ("transcript too sparse: 12 words over 4 min — music or a silent
video?"). The whole-video threshold stays deliberately low: it judges
emptiness, not eloquence.

### Errors are reasons

Every failure comes back as `reason`, never a crash:

- yt-dlp missing: "install yt-dlp";
- HTTP 403, "Sign in to confirm", PO-token errors: suggest updating yt-dlp
  (doctor shows how old it is) or `WEBINDEX_YTDLP_ARGS="--cookies-from-browser firefox"`;
- private, members-only, age-restricted, removed: said as such;
- no subtitles and no `uvx`: "no subtitles, and whisper needs uvx and ffmpeg".

`WEBINDEX_YTDLP_ARGS` is the one escape hatch for extra yt-dlp flags (cookies,
proxy), split on whitespace and appended to every call.

## Integration

- **`fetchAndExtract`** short-circuits to the ladder before Firecrawl and the
  HTTP GET when `youtubeVideoId(url)` matches. `webindex fetch <youtube-url>`,
  `webindex_fetch` over MCP and every vendoring skill read videos with no change
  on their side. `ExtractResult` gains `documentType: "video"` and the extractor
  ids `manual-subs | auto-subs | whisper`. With `authorizeUrl` set (MCP
  `--public-only`), the URL is checked before yt-dlp runs.
- **`doctor`** gains a `video rungs` block: yt-dlp (with its release age,
  flagged past 60 days), ffmpeg, uvx, and the whisper model.
- **CLI (PR 2–4)**: one `video` command with actions, as `skill` has —
  `webindex video fetch|search|frames|list`. A new `--out <dir>` value flag;
  the default root is `<tmp>/<brand>/video` (`WEBINDEX_VIDEO_DIR` overrides),
  so an ultrawatch run lands in `<tmp>/ultrawatch/video/<videoId>/`.
- **MCP (PR 4)**: `webindex_video_fetch`, `webindex_video_search`,
  `webindex_video_frames`, `webindex_video_list` — the `webindex_` prefix every
  existing tool carries.
- **README / HELP**: the drift tests require every new variable, command and
  MCP tool to be documented, and the export and command counts to be updated.

## Delivery

| PR | Contents | Uses covered |
|---|---|---|
| 1 | url, ytdlp, vtt, whisper, ladder, markdown; `fetch` wiring; doctor | summarise, questions (from `fetch` output) |
| 2 | `video fetch` / `video search`, run directory as cache | questions without refetching |
| 3 | frames (scene threshold 0.3, one per chapter start, dHash dedupe, `--effort low|med|high` = 20/50/100), `FRAMES.md` alignment on [t−5 s, t+10 s] | visual |
| 4 | `video list` + `CORPUS.md` (V1…Vn), MCP tools, `references/video.md` | several videos |

Each PR lands as `feat(video): …` (a minor release).

## Tests

Vitest with the command runner injected, no network: VTT fixtures captured from
real videos (rolling auto-captions, manual, multilingual), the ladder's rung
order and gate, URL shapes, a frozen `showinfo` log for frame timestamps, dHash
on synthetic images, alignment, and the MCP tools through `webindexAdapter`.

## Deviations from the plan

- MCP tools are `webindex_video_*`, not `video_*`, to match the existing tools.
- `--out` does not exist yet in the CLI; PR 2 adds it.
- The default run root follows the OS temp dir (`/var/folders/…` on macOS), as
  the fetch cache does, rather than a literal `/tmp`.
- Subtitles are fetched by a second yt-dlp call fed with `--load-info-json`,
  not by webindex's own HTTP client: the caption URLs increasingly need the
  tokens yt-dlp knows how to obtain.
