import type { VideoTranscript } from "./ladder.js";
import type { VideoSegment } from "./vtt.js";

// A transcript as Markdown a reader can cite: who said it and where it came
// from at the top, one `##` heading per chapter, and every paragraph stamped
// with the second it starts at — the stamp is the citation.

/** Seconds as `mm:ss`, or `h:mm:ss` past an hour. */
export function formatStamp(seconds: number): string {
  const t = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

const VIA_LABEL: Record<string, string> = {
  "manual-subs": "manual subtitles",
  "auto-subs": "YouTube auto-captions",
  whisper: "local whisper transcription",
};

const paragraph = (s: VideoSegment) => `[${formatStamp(s.start)}] ${s.text}`;
const baseLang = (tag: string) =>
  tag
    .toLowerCase()
    .replace(/-orig$/, "")
    .split(/[-_]/)[0];

/** How the transcript was made, and — for a subtitle track in another language than the video's — that it is a translation. */
function source(t: VideoTranscript): string | undefined {
  if (!t.via) return undefined;
  const how = `${VIA_LABEL[t.via] ?? t.via} (${t.via}${t.track ? `, track ${t.track}` : ""})`;
  const spoken = t.meta?.language;
  if (t.track && spoken && baseLang(t.track) !== baseLang(spoken)) return `${how} — a translation: the video speaks ${spoken}`;
  return how;
}

/** The transcript as Markdown: header, chapters, stamped paragraphs. Empty when there is no transcript. */
export function transcriptMarkdown(t: VideoTranscript): string {
  if (!t.segments.length) return "";
  const meta = t.meta;
  const head: string[] = [`# ${meta?.title ?? "Video transcript"}`, ""];
  if (meta) {
    const facts = [
      meta.channel && `- Channel: ${meta.channel}`,
      meta.uploadDate && `- Published: ${meta.uploadDate}`,
      meta.duration !== undefined && `- Duration: ${formatStamp(meta.duration)}`,
      `- URL: ${meta.webpageUrl}`,
      t.via && `- Transcript: ${source(t)}`,
    ].filter(Boolean) as string[];
    head.push(...facts, "");
  }

  const body: string[] = [];
  const chapters = [...t.chapters].sort((a, b) => a.start - b.start);
  let c = -1;
  for (const seg of t.segments) {
    // Every chapter that has started by this segment gets its heading, an
    // empty one (a silent intro) included, so the outline stays whole.
    while (c + 1 < chapters.length && chapters[c + 1]!.start <= seg.start + 0.5) {
      c++;
      body.push(`## ${chapters[c]!.title}`, "");
    }
    body.push(paragraph(seg), "");
  }
  return [...head, ...body].join("\n").trimEnd() + "\n";
}
