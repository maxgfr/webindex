import { describe, expect, it } from "vitest";
import { configure } from "../src/brand.js";
import {
  argBool,
  argInt,
  argList,
  argOneOf,
  argValue,
  type CliSpec,
  type CommandArgs,
  docFlagRegex,
  documentedFlags,
  EXIT_USAGE,
  helpCoversFlag,
  isInvokedDirectly,
  jsonLine,
  missingFromHelp,
  parseArgs,
  pipedEnum,
  positionalText,
  UsageError,
} from "../src/cli-kit.js";

const SPEC: CliSpec = {
  commands: ["search", "fetch", "rank"],
  valueFlags: ["limit", "lang", "run", "run-root", "backends"],
  boolFlags: ["json", "eco"],
};

/** The command variant, or a failure that says what came back instead. */
function cmd(argv: string[], spec: CliSpec = SPEC): CommandArgs {
  const p = parseArgs(argv, spec);
  if (p.kind !== "command") throw new Error(`expected a command, got "${p.kind}"`);
  return p;
}

describe("parseArgs", () => {
  it("treats a bare invocation as a request for help", () => {
    expect(parseArgs([], SPEC)).toEqual({ kind: "help" });
  });

  it("answers help and version however they are spelled", () => {
    for (const a of ["--help", "-h", "help"]) expect(parseArgs([a], SPEC).kind).toBe("help");
    for (const a of ["--version", "-v", "version"]) expect(parseArgs([a], SPEC).kind).toBe("version");
  });

  it("answers --help mid-command, which is when a reader actually types it", () => {
    expect(parseArgs(["search", "--help"], SPEC).kind).toBe("help");
    expect(parseArgs(["search", "-h"], SPEC).kind).toBe("help");
  });

  it("lets a declared flag beat the built-in shorthand", () => {
    // `webindex package <name> --version <semver>` must resolve that version,
    // not print the engine's and exit. The spec claiming the name is the rule.
    const withVersionFlag: CliSpec = { commands: ["package"], valueFlags: ["version"], boolFlags: [] };
    const p = parseArgs(["package", "hono", "--version", "4.0.0"], withVersionFlag);
    expect(p).toMatchObject({ kind: "command", values: { version: "4.0.0" } });
    // Undeclared, it goes back to being the shorthand.
    expect(parseArgs(["search", "--version"], SPEC).kind).toBe("version");
    // argv[0] is the command slot, where no flag can be declared — so there the
    // shorthand is unconditional.
    expect(parseArgs(["--version"], withVersionFlag).kind).toBe("version");
  });

  it("splits values, bools and positionals", () => {
    const p = cmd(["search", "rate", "limiting", "--limit", "5", "--json"]);
    expect(p.command).toBe("search");
    expect(p.positional).toEqual(["rate", "limiting"]);
    expect(p.values).toEqual({ limit: "5" });
    expect([...p.bools]).toEqual(["json"]);
  });

  it("accepts --flag=value", () => {
    expect(cmd(["search", "--limit=5"]).values).toEqual({ limit: "5" });
  });

  it("keeps an empty --flag= as an empty value, not a missing one", () => {
    expect(cmd(["search", "--lang="]).values).toEqual({ lang: "" });
  });

  it("passes everything after a bare -- through as positional", () => {
    const p = cmd(["search", "--", "--not-a-flag", "-x"]);
    expect(p.positional).toEqual(["--not-a-flag", "-x"]);
  });

  it("takes a negative number as a value", () => {
    expect(cmd(["search", "--limit", "-5"]).values).toEqual({ limit: "-5" });
  });
});

describe("what parseArgs refuses", () => {
  const rejects = (argv: string[], match: RegExp) => {
    expect(() => parseArgs(argv, SPEC)).toThrow(UsageError);
    expect(() => parseArgs(argv, SPEC)).toThrow(match);
  };

  it("rejects an unknown command and points at help", () => {
    // Not a list of every command: a CLI here has twenty, and a wall of them
    // buries the one word that matters.
    rejects(["serch"], /unknown command "serch"/);
    rejects(["serch"], /--help/);
  });

  it("rejects an unknown flag — the typo this whole module exists for", () => {
    // `--limt 5` silently ran the whole command with the wrong budget before.
    rejects(["search", "--limt", "5"], /unknown flag "--limt"/);
  });

  it("rejects a value flag with nothing after it", () => {
    rejects(["search", "--limit"], /missing value for --limit/);
  });

  it("treats a following flag as the next flag, not a value", () => {
    rejects(["search", "--limit", "--json"], /missing value for --limit/);
  });

  it("rejects a value handed to a boolean flag", () => {
    rejects(["search", "--json=yes"], /--json is a boolean flag and takes no value/);
  });

  it("carries the usage exit code, so a caller need not match on the message", () => {
    try {
      parseArgs(["nope"], SPEC);
      expect.unreachable();
    } catch (e) {
      expect((e as UsageError).exitCode).toBe(EXIT_USAGE);
    }
  });
});

describe("reading what was parsed", () => {
  it("reads values and bools", () => {
    const p = cmd(["search", "--lang", "fr-FR", "--json"]);
    expect(argValue(p, "lang")).toBe("fr-FR");
    expect(argValue(p, "run")).toBeUndefined();
    expect(argBool(p, "json")).toBe(true);
    expect(argBool(p, "eco")).toBe(false);
  });

  it("parses an integer, and refuses one that is not", () => {
    expect(argInt(cmd(["search", "--limit", "5"]), "limit")).toBe(5);
    expect(argInt(cmd(["search"]), "limit")).toBeUndefined();
    // NaN would compare false whichever way the guard is written, so `--limit
    // abc` would silently mean "no limit" — the opposite of what was asked.
    expect(() => argInt(cmd(["search", "--limit", "abc"]), "limit")).toThrow(/whole number/);
    expect(() => argInt(cmd(["search", "--limit", "2.5"]), "limit")).toThrow(/whole number/);
  });

  it("splits a list, trimming and dropping empties", () => {
    expect(argList(cmd(["search", "--backends", " a , b ,, c "]), "backends")).toEqual(["a", "b", "c"]);
    expect(argList(cmd(["search"]), "backends")).toEqual([]);
  });

  it("constrains a value to a set", () => {
    const allowed = ["fr", "en"] as const;
    expect(argOneOf(cmd(["search", "--lang", "fr"]), "lang", allowed)).toBe("fr");
    expect(argOneOf(cmd(["search"]), "lang", allowed)).toBeUndefined();
    expect(() => argOneOf(cmd(["search", "--lang", "de"]), "lang", allowed)).toThrow(/expected one of: fr, en/);
  });

  it("joins positionals into one query", () => {
    // `search rate limiting --limit 5` is ONE query of two words.
    expect(positionalText(cmd(["search", "rate", "limiting", "--limit", "5"]))).toBe("rate limiting");
  });
});

describe("jsonLine", () => {
  it("indents by two and ends with exactly one newline", () => {
    expect(jsonLine({ a: 1 })).toBe('{\n  "a": 1\n}\n');
  });
});

describe("the docs↔CLI drift matchers", () => {
  it("sees a flag through bold, parentheses and em dashes", () => {
    expect(documentedFlags("**--json** (--eco) — --limit")).toEqual(["json", "eco", "limit"]);
  });

  it("does not see a -- glued to a word tail", () => {
    expect(documentedFlags("foo--bar and --- and a---b")).toEqual([]);
  });

  it("returns a fresh regex each call, since a global one carries lastIndex", () => {
    const text = "--json --eco";
    expect([...text.matchAll(docFlagRegex())]).toHaveLength(2);
    expect([...text.matchAll(docFlagRegex())]).toHaveLength(2);
  });

  it("will not let --run-root cover --run", () => {
    // The pair the gate exists to catch: without the lookahead it passes.
    expect(helpCoversFlag("usage: x --run-root <dir>", "run")).toBe(false);
    expect(helpCoversFlag("usage: x --run <dir> --run-root <dir>", "run")).toBe(true);
  });

  it("reports the flags a help text never names", () => {
    expect(missingFromHelp("usage: x --json", ["json", "eco", "limit"])).toEqual(["eco", "limit"]);
  });

  it("reads a piped value enumeration that follows its flag", () => {
    expect(pipedEnum("--engine ddg|ddglite|mojeek", "engine")).toEqual(["ddg", "ddglite", "mojeek"]);
    expect(pipedEnum("`--engine` `ddg`|`mojeek`", "engine")).toEqual(["ddg", "mojeek"]);
    // Inside a table cell a literal pipe must be written `\|`, and an
    // enumeration in a cell is still an enumeration.
    expect(pipedEnum("| `--engine` ddg \\| mojeek |", "engine")).toEqual(["ddg", "mojeek"]);
  });

  it("is not fooled by a pipe that does not directly follow the flag", () => {
    // The list has to FOLLOW the flag with only non-letters between, so a cell
    // boundary or prose in between means there is no enumeration here — which
    // is what stops every other pipe in a markdown table from matching.
    expect(pipedEnum("| --engine | pins the rung | see below |", "engine")).toBeNull();
    expect(pipedEnum("--engine pins the rung: ddg|mojeek", "engine")).toBeNull();
    expect(pipedEnum("nothing here", "engine")).toBeNull();
  });
});

describe("isInvokedDirectly", () => {
  it("matches the configured brand's command, however it is installed", () => {
    configure({ name: "reader", envPrefix: "READER", cli: "reader" });
    expect(isInvokedDirectly("/opt/homebrew/bin/reader")).toBe(true);
    expect(isInvokedDirectly("/repo/scripts/reader.mjs")).toBe(true);
    expect(isInvokedDirectly("/repo/scripts/reader.cjs")).toBe(true);
  });

  it("is false when the bundle is merely imported", () => {
    // The skill-bundle gate imports each artifact to read its flag tables; a
    // main() that fired on import would turn verification into a run.
    configure({ name: "reader", envPrefix: "READER", cli: "reader" });
    expect(isInvokedDirectly(undefined)).toBe(false);
    expect(isInvokedDirectly("/repo/scripts/other.mjs")).toBe(false);
    expect(isInvokedDirectly("/repo/node_modules/.bin/vitest")).toBe(false);
  });

  it("reads the brand at call time, not at import", () => {
    // The lazy rule: a consumer configures after this module is already loaded.
    configure({ name: "a", envPrefix: "A", cli: "alpha" });
    expect(isInvokedDirectly("/bin/alpha")).toBe(true);
    configure({ name: "b", envPrefix: "B", cli: "beta" });
    expect(isInvokedDirectly("/bin/alpha")).toBe(false);
    expect(isInvokedDirectly("/bin/beta")).toBe(true);
  });
});
