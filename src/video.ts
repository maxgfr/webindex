// YouTube video transcripts — public surface.
//
// The implementation lives in ./video/: `url.ts` (which URLs are videos,
// playlists or channels), `ytdlp.ts` (metadata, subtitle tracks and yt-dlp's
// errors), `vtt.ts` (WebVTT → segments, rolling auto-captions undone),
// `whisper.ts` (local transcription, budgeted), `ladder.ts` (manual subtitles →
// auto-captions → whisper, behind a quality gate) and `markdown.ts` (a
// citable, timestamped rendering).
//
// Callers want `transcribeVideo`, then `transcriptMarkdown`.

export { youtubeListKind, youtubeVideoId } from "./video/url.js";
export {
  classifyYtdlpError,
  downloadSubtitle,
  probeVideo,
  videoMetaFromInfo,
  ytdlpVersionAge,
  type VideoChapter,
  type VideoMeta,
  type VideoProbe,
  type VideoRunner,
} from "./video/ytdlp.js";
export { mergeSegments, parseVtt, type VideoSegment } from "./video/vtt.js";
export { whisperBudgetLeft, whisperModel } from "./video/whisper.js";
export {
  assessTranscript,
  enabledTranscribers,
  resetVideoLadderCache,
  setVideoDeps,
  transcribeVideo,
  VIDEO_TRANSCRIBERS,
  type VideoDeps,
  type VideoLadderOptions,
  type VideoTranscriberId,
  type VideoTranscript,
} from "./video/ladder.js";
export { formatStamp, transcriptMarkdown } from "./video/markdown.js";
export {
  fetchVideoRun,
  listVideoRuns,
  readVideoRun,
  searchVideoRuns,
  videoRoot,
  type VideoHit,
  type VideoRunMeta,
  type VideoRunResult,
} from "./video/run.js";
export { extractFrames, FRAME_EFFORT, type FrameEffort, type FramesResult } from "./video/frames.js";
export type { FrameKind, VideoFrame } from "./video/align.js";
