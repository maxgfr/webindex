import { defineConfig } from "tsup";

// Bundles the TypeScript source into ONE dependency-free ESM file
// (scripts/engine.mjs) plus a flattened declaration file
// (scripts/engine.d.mts).
//
// These two files are the entire published surface. Consumers do not
// `npm install` webindex — they VENDOR the pair into src/vendor/, pinned by tag
// and sha256 (see each skill's scripts/sync-engine.mjs), and their own tsup run
// inlines it. That is why the output must stay a single self-contained file
// with no runtime dependencies: it has to survive being copied into a repo that
// never resolves it through a package manager.
//
// The committed bundle is verified reproducible in CI via `pnpm run check:build`.
export default defineConfig({
  // TWO entries, and the separation is load-bearing. `engine` is what the three
  // skills vendor and inline; `webindex` is the command. A CLI reachable from
  // src/index.ts would be inlined into three skills that cannot invoke it, and
  // its module-scope configure() would race theirs.
  entry: { engine: "src/index.ts", webindex: "src/cli.ts" },
  outDir: "scripts",
  format: ["esm"],
  outExtension: () => ({ js: ".mjs", dts: ".d.mts" }),
  // Only the library ships declarations; nobody imports the CLI as a module.
  banner: { js: "" },
  target: "node18",
  platform: "node",
  bundle: true,
  // Declarations for the LIBRARY entry only.
  //
  // `dts: true` generates them per entry, and with two entries sharing code
  // tsup's dts bundler hoists the common types into a chunk that engine.d.mts
  // then imports. Consumers vendor exactly two files, so that chunk never
  // arrives: every MCP type silently resolves to nothing and their `McpAdapter`
  // callbacks degrade to implicit any. That is how v1.7.0 shipped declarations
  // 129 lines shorter than v1.6.0's and broke all three skills' typecheck.
  //
  // Nobody imports the CLI as a module anyway — it is a program.
  dts: { entry: { engine: "src/index.ts" } },
  clean: false,
  minify: false,
  splitting: false,
  sourcemap: false,
});
