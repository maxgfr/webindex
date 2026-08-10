// The command-line harness every skill on this engine re-implements.
//
// A skill's cli.ts is 800–1200 lines, and the top 150 of them are the same
// everywhere: two flag tables, a parser that rejects what is not in them, an
// exit-code convention, and the introspection a docs↔CLI drift gate reads. The
// parts that differ — which flags exist, what each command does — stay with the
// skill. This module is what is left when those are taken away.
//
// It lives in the LIBRARY (src/index.ts), not in src/cli.ts. The separation
// tsup.config.ts documents is load-bearing: the CLI entry is deliberately
// unreachable from the library so it cannot be inlined into a consumer that
// can't invoke it. A harness USED BY command lines is not itself one, so
// nothing here reads process.argv at module scope, calls process.exit(), or
// writes to a stream. It parses and it answers; the caller decides what that
// costs.
//
// The parser is deliberately NOT a general-purpose one. It knows about `--flag`,
// `--flag=value`, `--flag value`, `--` and bare positionals, and it knows
// nothing about short clusters (-abc), optional values or repeated flags —
// because no skill in this family uses them, and every feature added here is a
// feature eight CLIs then have to document.

import { basename } from "node:path";
import { brand } from "./brand.js";
import { escapeRegExp } from "./text.js";

// ── Exit codes ──────────────────────────────────────────────────────────────
// Three, and the distinction between the last two is the one that matters: a
// caller scripting this engine needs to tell "your question had no answer" from
// "you asked wrongly". Collapsing them onto 1 — which is what an unguarded
// `process.exit(1)` does — makes a typo indistinguishable from an empty result.

/** The command did what it was asked. */
export const EXIT_OK = 0;
/** The command ran and the answer is a failure: nothing found, a gate refused. */
export const EXIT_FAILURE = 1;
/** The invocation itself was wrong: unknown command, unknown flag, missing value. */
export const EXIT_USAGE = 2;

/**
 * The invocation was malformed. Carries EXIT_USAGE so a caller can map every
 * parse failure to the right code without matching on the message.
 *
 * Thrown, not printed: the parser has no business owning stderr, and a test
 * that asserts on a message should not have to capture a stream to read it.
 */
export class UsageError extends Error {
  readonly exitCode = EXIT_USAGE;
}

// ── The spec a CLI declares ─────────────────────────────────────────────────

export interface CliSpec {
  /** Every command word the CLI answers to. */
  commands: Iterable<string>;
  /** Flags that take a value: `--out <dir>` or `--out=<dir>`. */
  valueFlags: Iterable<string>;
  /** Flags that are present or absent: `--json`. Never take a value. */
  boolFlags: Iterable<string>;
}

/** A parsed invocation of one command. */
export interface CommandArgs {
  command: string;
  /** Bare words, in order, with flags and their values removed. */
  positional: string[];
  values: Record<string, string>;
  bools: ReadonlySet<string>;
}

/**
 * What an argv turned out to be. `--help` and `--version` are outcomes rather
 * than commands because every CLI answers them the same way and none of them
 * wants a case in its command switch for it.
 */
export type ParsedArgs = { kind: "help" } | { kind: "version" } | ({ kind: "command" } & CommandArgs);

/**
 * Parse an argv against a spec.
 *
 * Rejects, rather than ignoring: an unknown flag is a typo, and a CLI that
 * silently drops `--limt 5` runs the whole command with the wrong budget and
 * reports success. That silence is what this replaces — webindex's own CLI read
 * flags with `argv.indexOf("--" + name)` and accepted anything.
 *
 * Throws UsageError on: an unknown command, an unknown flag, a value flag with
 * no value, and a boolean flag given one.
 */
export function parseArgs(argv: readonly string[], spec: CliSpec): ParsedArgs {
  const commands = new Set(spec.commands);
  const valueFlags = new Set(spec.valueFlags);
  const boolFlags = new Set(spec.boolFlags);

  // No arguments at all is a request for help, not an error. Someone typing the
  // bare command name is asking what it does.
  if (argv.length === 0) return { kind: "help" };
  if (isHelpWord(argv[0])) return { kind: "help" };
  if (isVersionWord(argv[0])) return { kind: "version" };

  const command = argv[0] as string;
  if (!commands.has(command)) {
    // Deliberately not a list of every command. A CLI in this family has
    // twenty, and a wall of them buries the one word that matters; --help is
    // where the list belongs and is one keystroke away.
    throw new UsageError(`unknown command "${command}" — run --help for the supported commands`);
  }

  const values: Record<string, string> = {};
  const bools = new Set<string>();
  const positional: string[] = [];

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] as string;

    // Everything after a bare `--` is positional, whatever it looks like. This
    // is how a query that genuinely starts with dashes gets through.
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }

    if (!arg.startsWith("--") && arg !== "-h" && arg !== "-v") {
      positional.push(arg);
      continue;
    }

    const eq = arg.indexOf("=");
    const key = eq !== -1 ? arg.slice(2, eq) : arg.slice(2);

    // A DECLARED flag beats the built-in shorthand. `--version` is the version
    // word in argv[0] and a value flag everywhere else in a CLI that has a
    // `package <name> --version <semver>` command — collapsing the two would
    // make that command print the engine version and exit. One rule covers
    // both: if the spec claims the name, the spec wins.
    //
    // Position matters too. argv[0] is the COMMAND slot, where no flag can be
    // declared, so the shorthands are unconditional there (handled above);
    // here they only apply to names nobody claimed. `webindex search --help`
    // is what a reader types once they are already mid-command, and it works.
    if (!boolFlags.has(key) && !valueFlags.has(key)) {
      if (isHelpWord(arg)) return { kind: "help" };
      if (isVersionWord(arg)) return { kind: "version" };
    }

    if (boolFlags.has(key)) {
      if (eq !== -1) throw new UsageError(`--${key} is a boolean flag and takes no value`);
      bools.add(key);
      continue;
    }
    if (!valueFlags.has(key)) {
      throw new UsageError(`unknown flag "--${key}" — run --help for the supported options`);
    }
    if (eq !== -1) {
      values[key] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    // A following `--something` is the NEXT flag, not this one's value. It is
    // the common shape of a forgotten argument, and consuming it would hide the
    // mistake behind a plausible-looking value.
    if (next === undefined || next.startsWith("--")) {
      throw new UsageError(`missing value for --${key}`);
    }
    values[key] = next;
    i++;
  }

  return { kind: "command", command, positional, values, bools };
}

function isHelpWord(a: string | undefined): boolean {
  return a === "--help" || a === "-h" || a === "help";
}

function isVersionWord(a: string | undefined): boolean {
  return a === "--version" || a === "-v" || a === "version";
}

// ── Reading what was parsed ─────────────────────────────────────────────────
// Free functions rather than methods, so CommandArgs stays a plain object a
// test can write as a literal.

/** A value flag, or undefined. */
export function argValue(p: CommandArgs, name: string): string | undefined {
  return p.values[name];
}

/** Whether a boolean flag was given. */
export function argBool(p: CommandArgs, name: string): boolean {
  return p.bools.has(name);
}

/**
 * A value flag as an integer, or undefined when absent.
 *
 * Throws UsageError on a value that is not one, rather than returning NaN. A
 * NaN budget propagates into a comparison that is false whichever way it is
 * written, so `--limit abc` would silently mean "no limit" — the opposite of
 * what was asked.
 */
export function argInt(p: CommandArgs, name: string): number | undefined {
  const raw = p.values[name];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new UsageError(`--${name} expects a whole number, got "${raw}"`);
  }
  return n;
}

/** A comma-separated value flag as a trimmed, empty-free list. Absent → []. */
export function argList(p: CommandArgs, name: string): string[] {
  const raw = p.values[name];
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * A value flag constrained to a set. Absent → undefined; present and outside
 * the set → UsageError naming what was expected.
 */
export function argOneOf<T extends string>(p: CommandArgs, name: string, allowed: readonly T[]): T | undefined {
  const raw = p.values[name];
  if (raw === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new UsageError(`invalid --${name} "${raw}" — expected one of: ${allowed.join(", ")}`);
  }
  return raw as T;
}

/**
 * The positional words as one string.
 *
 * `search rate limiting --limit 5` is ONE query of two words, not two queries
 * and a stray number. The parser already dropped the flag and its value, so
 * joining what is left is the whole of it — which is why this is three lines
 * here and was a 25-line hand-rolled scanner in src/cli.ts.
 */
export function positionalText(p: CommandArgs): string {
  return p.positional.join(" ");
}

/** JSON as a CLI writes it: two-space indent, one trailing newline. */
export function jsonLine(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// ── The docs ↔ CLI drift gate ───────────────────────────────────────────────
// A skill's SKILL.md tells its agent that `--help` is the full surface. That is
// a promise about two artifacts staying in step, and it is exactly the kind of
// promise that rots: one repo in this family had the gate, two had lost it, and
// the three copies of the matchers were "kept in sync" by comment.
//
// They live here so the artifact-layer gate (over a built bundle) and the
// source-layer twin (over src/) read one implementation.

/**
 * A fresh global regex matching a documented `--flag`.
 *
 * The lookbehind skips a `--` glued to a word tail (`foo--bar`, `---`) so a
 * bold, parenthesised or em-dashed flag is still seen.
 *
 * Returns a NEW regex per call on purpose: a global regex carries `lastIndex`
 * between uses, so a shared one silently skips matches in the second caller.
 */
export function docFlagRegex(): RegExp {
  return /(?<![a-z0-9-])--([a-z][a-z0-9-]*)/g;
}

/** Every distinct `--flag` a document mentions, in first-seen order. */
export function documentedFlags(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(docFlagRegex())) seen.add(m[1] as string);
  return [...seen];
}

/**
 * Whether a help text mentions `--flag` as a whole token.
 *
 * The lookahead is what stops `--run` from being "covered" by `--run-root`, and
 * `--shard` by `--shards`. Without it the gate passes on precisely the pairs it
 * exists to catch.
 */
export function helpCoversFlag(help: string, flag: string): boolean {
  return new RegExp(`--${escapeRegExp(flag)}(?![a-z0-9-])`).test(help);
}

/** The flags a CLI accepts that its help text never names. */
export function missingFromHelp(help: string, flags: Iterable<string>): string[] {
  return [...flags].filter((f) => !helpCoversFlag(help, f));
}

/**
 * The pipe-separated value list documented for `--<flag>` on one line, or null
 * when the line carries no such enumeration.
 *
 * The list must FOLLOW the flag with only non-letters in between, so a markdown
 * table's pipes elsewhere on the line cannot false-positive. Backticks are
 * stripped first so `` `a`|`b` `` still matches, and an escaped `\|` — which is
 * how a literal pipe must be written inside a table cell — is unescaped first,
 * because an enumeration in a table cell is still an enumeration.
 */
export function pipedEnum(line: string, flag: string): string[] | null {
  const cleaned = line.replace(/`/g, "").replace(/\\\|/g, "|");
  const m = cleaned.match(new RegExp(`--${escapeRegExp(flag)}[^a-z|]*((?:[a-z][a-z0-9-]*\\s*\\|\\s*)+[a-z][a-z0-9-]*)`));
  return m ? (m[1] as string).split("|").map((s) => s.trim()) : null;
}

// ── The entry guard ─────────────────────────────────────────────────────────

/**
 * Whether this process was started AS the CLI, rather than imported.
 *
 * Importing a bundle must not run it: the skill-bundle gate imports each built
 * artifact to read its flag tables, and a `main()` that fired on import would
 * turn a verification step into a run.
 *
 * Matches the basename against the configured brand, so a consumer's
 * `scripts/ultrasearch.mjs`, a Homebrew `bin/ultrasearch` symlink and a global
 * npm shim all count, while `node -e 'import(...)'` does not. brand() is read at
 * CALL time — the lazy rule in brand.ts applies here like everywhere else.
 */
export function isInvokedDirectly(argv1: string | undefined = process.argv[1], cli: string = brand().cli): boolean {
  if (!argv1) return false;
  return basename(argv1).replace(/\.(mjs|cjs|js)$/, "") === cli;
}
