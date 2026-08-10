// The skill toolchain, as a library.
//
// Dev-time, and deliberately not part of the vendored engine's job: these
// functions police a repository, they do not run inside one. The CLI in
// src/cli.ts is what drives them, so a skill's package.json shrinks from five
// scripts to one line and the ~600 lines of packaging code per repo — copied
// eight times and already divergent — stop existing.
//
// Deliberately NOT re-exported from src/index.ts, so it stays out of the
// vendored bundle. The same triage the MCP surface gets: these are dev-time
// gates, and inlining them into eight skills' runtime artifacts would be dead
// weight in every one. A skill that wants a packaging assertion inside its own
// test suite shells out to `webindex skill check --json`, which is what its CI
// runs anyway.

export { compareTags, DEFAULT_FILES, readSkillConfig, SKILL_CONFIG, type ConfigResult, type EnginePin, type SkillConfig } from "./config.js";
export { auditEngineUsage, engineExports, walkSources, type UsageReport } from "./usage.js";
export { checkPins, sha256, vendorEngine, type PinFile, type PinStatus, type VendorResult } from "./vendor.js";
export { auditSkillBundle, DESC_MAX, type BundleCheck, type CliSurface } from "./bundle.js";
export { scaffoldSkill, type ScaffoldResult } from "./scaffold.js";
