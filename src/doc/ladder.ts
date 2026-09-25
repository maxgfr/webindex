import { envFlag } from "../brand.js";
import { ANYDOC_SPEC } from "../pdf/exec.js";
import { enginesFromEnv } from "../pdf/ladder.js";
import { failureDetail, resetNpxState, runNpx, skipNpxHint } from "../pdf/npx.js";
import { assessExtractedText } from "../pdf/quality.js";
import type { DocFormat } from "./formats.js";
import { readOffice } from "./office.js";

// The office-document extractor ladder: convert a fetched .docx/.pptx/.xlsx/…
// to Markdown, and REFUSE rather than cite what nothing could read.
//
// Same shape as the PDF ladder (../pdf/ladder.ts): try the strongest available
// tool, fall through when it is missing or its output fails the quality gate.
// The reason for refusing is starker here than for PDFs. An office document is
// a ZIP or an OLE stream, so the fallback that used to apply — hand back the
// response body as text — did not degrade the evidence, it fabricated it:
// hundreds of kilobytes of U+FFFD under a citation, with no note saying so.
//
// Rung order, and why:
//   1. anydoc     the strongest converter for these formats, and the only one
//                 for the legacy binary ones (.doc, .xls, .ppt) and RTF. One npx
//                 download (~4 MB) the first time it is ever used, then a local
//                 cache hit. Reads the format from the BYTES, so a mislabelled
//                 file still converts — see ./formats.ts.
//   2. firecrawl  the caller's already-running container, injected as a callback
//                 so this module stays free of the client. Covers hosts without
//                 npm, and platforms npm has no anydoc binary for.
//   3. builtin    the zero-dependency OOXML/OpenDocument reader in ./office.ts.
//                 Always present, no subprocess, no network: what an offline or
//                 NO_NPX run reads .docx, .xlsx, .pptx, .odt, .ods and .odp
//                 with. Last because anydoc's Markdown is richer; its output
//                 passes the same gate as everyone else's.

export type DocExtractorId = "anydoc" | "firecrawl" | "builtin";

export const DOC_EXTRACTORS: DocExtractorId[] = ["anydoc", "firecrawl", "builtin"];

export interface DocExtraction {
  text: string;
  /** Which rung produced `text`. Absent when every rung failed. */
  via?: DocExtractorId;
  /** Why the result is empty, when it is — suitable for a dossier note. */
  reason?: string;
}

export interface DocLadderOptions {
  /**
   * Convert this document through an already-running Firecrawl, or undefined
   * when there is none. Injected by the caller for the same reason the PDF
   * ladder does it: so this module needs no Firecrawl client, and so tests can
   * drive the rung without a container.
   */
  firecrawl?: () => Promise<string | undefined>;
  /** Restrict/reorder the ladder. Defaults to DOC_EXTRACTORS. */
  engines?: DocExtractorId[];
}

// Rungs proven unavailable in this process (npm absent or offline, unsupported
// platform), with what is worth repeating about them. Without this, a
// 40-source run would re-pay the same failed discovery for every single
// document. A converter that REJECTED a document never lands here: anydoc exits
// 1 on any malformed file, and one truncated .docx used to cost every later
// document its converter — see ../pdf/npx.ts.
const dead = new Map<DocExtractorId, { failure?: string }>();

/** Test seam: forget which rungs were found unavailable. */
export function resetDocLadderCache(): void {
  dead.clear();
  resetNpxState();
}

/**
 * The rungs to try, honouring `<PREFIX>_DOC_ENGINE` (a comma list of rungs to
 * run, in order, or `none` to disable the ladder — parsed as `PDF_ENGINE` is)
 * and `<PREFIX>_NO_NPX` (skip the rung that needs an implicit install), where
 * `<PREFIX>` is whatever the consuming skill declared via `configure()`.
 *
 * An explicit `engines` list wins over both, exactly as in the PDF ladder: it is
 * the most specific instruction available, and it is how callers and tests drive
 * the ladder deterministically without fighting the environment.
 */
export function enabledDocExtractors(engines?: DocExtractorId[]): DocExtractorId[] {
  if (engines) return engines;
  const chosen = enginesFromEnv("DOC_ENGINE", DOC_EXTRACTORS);
  if (chosen) return chosen;
  if (envFlag("NO_NPX")) return DOC_EXTRACTORS.filter((e) => e !== "anydoc");
  return DOC_EXTRACTORS;
}

/** What anydoc made of the document: its Markdown, or why there is none. */
async function viaAnydoc(bytes: Buffer, format?: string): Promise<{ text?: string; failure?: string; unavailable?: boolean }> {
  // `-` reads the document from stdin. No user input reaches argv — the
  // document travels on stdin, and `format` comes from the table in
  // ./formats.ts, never from a URL.
  const args = ["-"];
  if (format) args.push("--format", format);
  const r = await runNpx(ANYDOC_SPEC, args, bytes);
  if (r.ok) return { text: r.stdout };
  // npx missing is the ordinary state of a machine without npm, not news.
  if (r.unavailable === "not installed") return { unavailable: true };
  if (r.unavailable) return { unavailable: true, failure: `anydoc ${r.unavailable}; ${skipNpxHint()}` };
  return { failure: failureDetail("anydoc", r) };
}

/** What the built-in reader made of the document. Never unavailable: it needs nothing. */
function viaBuiltin(bytes: Buffer, fmt: DocFormat): { text?: string; failure?: string } {
  // A CSV is plain text, not a package; its fallback is the caller's to apply.
  if (fmt.format === "csv") return {};
  const r = readOffice(bytes);
  return r.text === undefined ? { failure: `builtin: ${r.failure}` } : { text: r.text };
}

/**
 * Convert an office document to Markdown, trying each enabled rung in order and
 * returning the first result that the quality gate accepts.
 *
 * Never throws. When every rung fails, returns empty text plus the reason — the
 * gate's verdict, or what the converter itself said, or why it could not run —
 * so the caller can say why the source is unusable instead of silently citing
 * nothing, or, worse, citing the raw bytes.
 */
export async function extractDocument(bytes: Buffer, fmt: DocFormat, opts: DocLadderOptions = {}): Promise<DocExtraction> {
  let lastReason: string | undefined;
  const failures: string[] = [];

  for (const id of enabledDocExtractors(opts.engines)) {
    const known = dead.get(id);
    if (known) {
      if (known.failure) failures.push(known.failure);
      continue;
    }

    let got: { text?: string; failure?: string; unavailable?: boolean };
    try {
      if (id === "anydoc") got = await viaAnydoc(bytes, fmt.format);
      else if (id === "builtin") got = viaBuiltin(bytes, fmt);
      // Never remembered as unavailable: Firecrawl's own client memoises its
      // probe, and it can legitimately fail on one URL and work on the next.
      else got = { text: opts.firecrawl ? await opts.firecrawl() : undefined };
    } catch {
      got = {}; // a rung must never take the run down
    }

    if (got.text === undefined) {
      if (got.unavailable) dead.set(id, { failure: got.failure });
      if (got.failure) failures.push(got.failure);
      continue;
    }

    const verdict = assessExtractedText(got.text, "the converter produced no text");
    if (verdict.ok) return { text: got.text.trim(), via: id };
    lastReason = verdict.reason;
  }

  const reason = [lastReason, ...failures].filter(Boolean).join("; ");
  return { text: "", reason: reason || "no document converter available" };
}
