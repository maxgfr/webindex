# The skill toolchain — `webindex skill`

Packaging gates for a repository built **on** this engine. Dev-time: they read a
repository, they never run inside one — which is why they need no vendoring and
work for a skill that does not vendor this engine at all.

They replace ~600 lines of per-repo scripts (`sync-engine`,
`verify-engine-usage`, `verify-skill-bundle`, `copy-bundle`, `sync-version`,
`drift-rules`) that were copied eight times and had already diverged: one repo
had the docs↔CLI drift gate, two had lost it.

## `skill.json`

One reviewable file, replacing four scattered places — three of which were code,
so changing a pin meant editing a script.

```json
{
  "name": "ultrasearch",
  "engines": {
    "webindex":  { "repo": "maxgfr/webindex",  "minRef": "v1.15.0", "meta": "webindex.meta.json" },
    "codeindex": { "repo": "maxgfr/codeindex", "minRef": "v2.27.1", "meta": "engine.meta.json" }
  },
  "usageFloor": 148,
  "forks": {},
  "allowedForeignFlags": ["profile", "wait", "prefer-offline", "layout", "format"]
}
```

Validated on read, never trusted. A `usageFloor` that is not a number is
**refused** rather than defaulted to zero: defaulting would turn the gate off
silently, which is the exact failure the ratchet exists to prevent.

## The commands

```bash
webindex skill vendor --ref v1.15.0     # fetch + pin, bytes unmodified
webindex skill vendor --check           # offline drift + staleness gate (CI)
webindex skill check                    # no module may DECLARE an engine export
webindex skill bundle                   # `skills add` would install a working skill
webindex skill copy                     # embed the built engine in the package
webindex skill doctor                   # pins, lag, outstanding forks
webindex skill init <name>              # scaffold a new skill repository
```

Your `package.json` becomes one line:

```json
"verify": "webindex skill check && webindex skill bundle && webindex skill vendor --check"
```

## Two ways a vendored engine goes wrong

**TAMPERED** — the bytes no longer match the tag they claim. Caught by
re-hashing against the recorded sha256.

**STALE** — the bytes match their tag, but the tag is older than the source in
this repo was written against. A hash check passes cleanly here, and because the
bundle is *inlined* at build time the repo then ships the old behaviour with
every test green, measuring the wrong code. Caught by comparing against
`minRef` — which you bump in the **same commit** that deletes a local copy in
favour of an engine export.

One skill sat nine releases behind its own declared minimum with nothing saying
so. That is why this is a gate rather than a convenience.

Tag comparison is numeric per component: a string compare puts `v1.10.0` before
`v1.9.0`, and getting it backwards disarms the gate at exactly the release where
it starts to matter.

## `check` is a prohibition, not a tally

> No module under `src/` may **declare** a name the engine already exports.

Re-exporting is fine and expected — that is what a shim does, and it is how
`from "./util.js"` keeps resolving after the implementation moved. Declaring is
the regression: a second implementation now exists in the tree, and an import
resolves to whichever the author reached for. One repo vendored a bundle
exporting the whole MCP transport while running its own 929-line copy beside it,
with every gate green.

A private declaration counts too — a shadow is a shadow whether or not the
module re-exports it.

`forks` is a **ratchet**: entries may leave, never arrive, so the next fork is an
argued decision rather than a quiet copy. An entry that no longer matches
anything also fails, so the list cannot rot.

## `bundle` and the assertion nothing else could make

The installer early-returns on a `SKILL.md` at the repository **root** and
installs that file alone — the sibling `scripts/` and `references/` are dropped.
A skill is only bundled whole when its `SKILL.md` lives in `skills/<name>/`.

No test of the skill's behaviour would ever catch that: the repo works
perfectly, and what users install is a lone markdown file describing an engine
that is not there.

The rest is docs↔CLI drift, read from the **built** artifact rather than
inferred from source. An earlier version recovered the flag surface by
pattern-matching call sites; the moment a CLI changed how it read flags, the
regex matched nothing, the set went empty, and every documented flag reported as
drift at once.
