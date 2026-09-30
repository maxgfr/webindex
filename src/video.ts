// Video transcripts — YouTube, and any site yt-dlp reads — public surface.
//
// The implementation lives in ./video/: `url.ts` (which URLs are videos,
// playlists or channels, on YouTube and the other hosts it knows), `ytdlp.ts` (metadata, subtitle tracks and yt-dlp's
// errors), `vtt.ts` (WebVTT → segments, rolling auto-captions undone),
// `whisper.ts` (local transcription, budgeted), `ladder.ts` (manual subtitles →
// auto-captions → whisper, behind a quality gate) and `markdown.ts` (a
// citable, timestamped rendering).
//
// Callers want `transcribeVideo`, then `transcriptMarkdown`.

export { isVideoList, knownVideo, videoRunKey, videoSource, videoUrlAt, youtubeListKind, youtubeVideoId, type VideoSource } from "./video/url.js";
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
  corpusLabels,
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
export { corpusMarkdown, fetchVideoCorpus, listVideos, type CorpusResult, type CorpusVideo, type ListedVideo, type VideoCorpus } from "./video/list.js";
