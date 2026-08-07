declare const ENGINE_VERSION = "0.0.0";

interface Brand {
    /** Human-readable engine consumer, used in notes and diagnostics. */
    name: string;
    /** Uppercase prefix for environment variables, without the trailing underscore. */
    envPrefix: string;
    /** The command users type, used when a note tells them what to run. */
    cli: string;
    /** Root for on-disk caches. Defaults to `<tmpdir>/<name>` when unset. */
    cacheDir?: string;
}
/**
 * Declare the consuming skill's identity. Call once, as early as possible in
 * the CLI entry point and in the MCP server bootstrap — both are process
 * entry points, and a run that starts through either must see the same brand.
 */
declare function configure(next: Brand): void;
/** The active brand. Consumers read `.cli` to name commands inside notes. */
declare function brand(): Readonly<Brand>;
/** Restore the default identity. Test-only; production code configures once. */
declare function resetBrand(): void;
/** Full variable name for a suffix, e.g. `env` name for "SEARXNG". */
declare function envName(suffix: string): string;
/**
 * Read `${envPrefix}_${suffix}`, trimmed. Returns undefined for unset OR
 * empty-after-trim, so `FOO=` and `FOO="  "` behave like unset rather than
 * like the empty string — an exported-but-blank variable is a user mistake,
 * not a request for empty configuration.
 */
declare function env(suffix: string): string | undefined;
/**
 * Presence-as-truth, matching the `if (process.env.X_NO_NPX)` shape the
 * extracted code already used. Any non-empty value except the explicit
 * negatives turns the flag on, so `NO_NPX=1`, `NO_NPX=true` and `NO_NPX=yes`
 * all work — but `NO_NPX=0` and `NO_NPX=false` read as off, because a user who
 * writes that plainly means off and the old presence-only test got it wrong.
 */
declare function envFlag(suffix: string): boolean;
/**
 * Read a numeric tunable, clamped into [min, max]. A missing, non-numeric or
 * negative-where-forbidden value falls back to `def` silently — these are
 * performance knobs, and a typo in one must never abort a run.
 *
 * Replaces three separate copies of this helper that had drifted apart (one
 * clamped, one did not, one rejected zero).
 */
declare function envInt(suffix: string, def: number, min?: number, max?: number): number;

declare function pdfToText(buf: Buffer): string;

interface PdfVerdict {
    ok: boolean;
    /** Short, human-readable cause when `ok` is false. */
    reason?: string;
}
/**
 * Judge extracted PDF text. Returns `{ ok: true }` when the text is safe to
 * cite, else a short reason the caller can put in a dossier note.
 */
declare function assessPdfText(text: string): PdfVerdict;
/**
 * Judge extracted text. Returns `{ ok: true }` when the text is safe to cite,
 * else a short reason the caller can put in a dossier note. `emptyReason` names
 * what an empty extraction means for the format at hand — a PDF with no text
 * layer was probably scanned, an empty .docx conversion means something else.
 *
 * Deliberately independent of length: the failure this guards against produces
 * HUNDREDS of kilobytes, which is exactly what a length-gated check misses.
 */
declare function assessExtractedText(text: string, emptyReason: string): PdfVerdict;

/** Test seam: forget the per-process OCR budget. */
declare function resetOcrBudget(): void;
/** Documents this process may still OCR. */
declare function ocrBudgetLeft(): number;
/**
 * Is OCR possible on this machine?
 *
 * Both binaries must resolve: `copyable-pdf` itself, and the `tesseract` it
 * shells out to. Checking tesseract separately is what keeps us out of the
 * install prompt described above — and it makes `doctor` able to say WHICH part
 * is missing, which "OCR unavailable" alone could not.
 */
declare function ocrTools(): Promise<{
    copyablePdf: boolean;
    tesseract: boolean;
}>;
/**
 * OCR a scanned PDF to text, or return undefined when it cannot be done.
 *
 * Undefined (rather than an empty string) means "this rung is unavailable or
 * failed" — the ladder's signal to try the next one and, for a non-firecrawl
 * rung, to stop asking for the rest of the process.
 */
declare function ocrPdf(bytes: Buffer): Promise<string | undefined>;

type PdfExtractorId = "pdf-inspector" | "anydoc" | "firecrawl" | "pdftotext" | "native" | "ocr";
declare const PDF_EXTRACTORS: PdfExtractorId[];
interface PdfExtraction {
    text: string;
    /** Which rung produced `text`. Absent when every rung failed. */
    via?: PdfExtractorId;
    /** Why the result is empty, when it is — suitable for a dossier note. */
    reason?: string;
}
interface PdfLadderOptions {
    /**
     * Fetch this PDF's text through an already-running Firecrawl, or undefined
     * when there is none. Injected by the caller so this module stays free of the
     * Firecrawl client (and so tests can drive the rung without a container).
     */
    firecrawl?: () => Promise<string | undefined>;
    /** Restrict/reorder the ladder. Defaults to PDF_EXTRACTORS. */
    engines?: PdfExtractorId[];
}
/** Test seam: forget which rungs were found unavailable, and refill the OCR budget. */
declare function resetPdfLadderCache(): void;
/**
 * The rungs to try, honouring `<PREFIX>_PDF_ENGINE` (force exactly one) and
 * `<PREFIX>_NO_NPX` (skip the rung that needs an implicit install), where
 * `<PREFIX>` is whatever the consuming skill declared via `configure()`.
 *
 * An explicit `engines` list wins over both: it is the most specific instruction
 * available, and it is how callers and tests drive the ladder deterministically
 * without fighting whatever the environment happens to say.
 */
declare function enabledExtractors(engines?: PdfExtractorId[]): PdfExtractorId[];
/**
 * Extract text from PDF bytes, trying each enabled rung in order and returning
 * the first result that `assessPdfText` accepts.
 *
 * Never throws. When every rung fails, returns empty text plus the LAST
 * rejection reason, so the caller can say why the source is unusable instead of
 * silently citing nothing.
 */
declare function extractPdf(bytes: Buffer, opts?: PdfLadderOptions): Promise<PdfExtraction>;

interface DocFormat {
    /** Passed as `--format` only when byte detection cannot work. */
    format?: string;
    /**
     * Is this format readable as plain text when no converter is available?
     *
     * False for every binary format: refusing is the whole point, because the
     * alternative is citing a decoded ZIP. True for CSV, which was already served
     * as usable text before this ladder existed — refusing it would be a
     * regression, not a fix.
     */
    textFallback: boolean;
}
/** Every extension this module routes, for docs and tests. */
declare const DOC_EXTENSIONS: readonly string[];
/**
 * Is this URL an office document, judged before the fetch?
 *
 * Extension-only, and deliberately so. The PDF sniffer also has to recognise
 * extension-less routes because `arxiv.org/pdf/<id>` is the single most common
 * PDF a run fetches; office documents have no such convention — a route that
 * serves one without saying so in the path is caught after the fetch, by
 * `docFormatForContentType`.
 *
 * Returns the table entry (never a URL-derived string) or undefined.
 */
declare function docFormatForUrl(url: string): DocFormat | undefined;
/** Is this response an office document, judged from its content-type? */
declare function docFormatForContentType(contentType: string): DocFormat | undefined;

type DocExtractorId = "anydoc" | "firecrawl";
declare const DOC_EXTRACTORS: DocExtractorId[];
interface DocExtraction {
    text: string;
    /** Which rung produced `text`. Absent when every rung failed. */
    via?: DocExtractorId;
    /** Why the result is empty, when it is — suitable for a dossier note. */
    reason?: string;
}
interface DocLadderOptions {
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
/** Test seam: forget which rungs were found unavailable. */
declare function resetDocLadderCache(): void;
/**
 * The rungs to try, honouring `<PREFIX>_DOC_ENGINE` (force exactly one, or
 * `none` to disable the ladder) and `<PREFIX>_NO_NPX` (skip the rung that
 * needs an implicit install), where `<PREFIX>` is whatever the consuming skill
 * declared via `configure()`.
 *
 * An explicit `engines` list wins over both, exactly as in the PDF ladder: it is
 * the most specific instruction available, and it is how callers and tests drive
 * the ladder deterministically without fighting the environment.
 */
declare function enabledDocExtractors(engines?: DocExtractorId[]): DocExtractorId[];
/**
 * Convert an office document to Markdown, trying each enabled rung in order and
 * returning the first result that the quality gate accepts.
 *
 * Never throws. When every rung fails, returns empty text plus the reason, so
 * the caller can say why the source is unusable instead of silently citing
 * nothing — or, worse, citing the raw bytes.
 */
declare function extractDocument(bytes: Buffer, fmt: DocFormat, opts?: DocLadderOptions): Promise<DocExtraction>;

declare const PDF_INSPECTOR_SPEC = "@firecrawl/pdf-inspector@1";
declare const ANYDOC_SPEC = "@firecrawl/anydoc@0.1";
interface RunResult {
    ok: boolean;
    stdout: string;
    /** Short cause when `ok` is false: "not installed", "timed out", "exit 2"… */
    error?: string;
}
/**
 * Spawn `cmd args…`, write `input` to its stdin, resolve with its stdout.
 * Never throws and never leaves a child behind: a missing binary, a non-zero
 * exit and a timeout all come back as `{ ok: false, error }`.
 */
declare function runWithInput(cmd: string, args: string[], input: Buffer, timeoutMs: number): Promise<RunResult>;

export { ANYDOC_SPEC, type Brand, DOC_EXTENSIONS, DOC_EXTRACTORS, type DocExtraction, type DocExtractorId, type DocFormat, type DocLadderOptions, ENGINE_VERSION, PDF_EXTRACTORS, PDF_INSPECTOR_SPEC, type PdfExtraction, type PdfExtractorId, type PdfLadderOptions, type PdfVerdict, assessExtractedText, assessPdfText, brand, configure, docFormatForContentType, docFormatForUrl, enabledDocExtractors, enabledExtractors, env, envFlag, envInt, envName, extractDocument, extractPdf, ocrBudgetLeft, ocrPdf, ocrTools, pdfToText, resetBrand, resetDocLadderCache, resetOcrBudget, resetPdfLadderCache, runWithInput };
