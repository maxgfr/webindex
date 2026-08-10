// Pinning a vendored engine, and proving the pin still holds.
//
// A consumer does not install this package — it copies the built artifacts into
// its own tree and lets its bundler inline them, so the bytes on disk ARE the
// dependency. Two things can go wrong with that, and they need different
// answers:
//
//   TAMPERED — the vendored bytes no longer match the tag they claim. Caught by
//   re-hashing against the recorded sha256.
//
//   STALE — the bytes match their tag, but the tag is older than the source in
//   this repo was written against. A hash check passes cleanly here, and
//   because the bundle is INLINED at build time the repo then ships the old
//   behaviour with every test green, measuring the wrong code. Caught by
//   comparing the pinned tag against `minRef`.
//
// The second one is the reason this is a gate rather than a convenience: one
// skill sat nine releases behind its declared minimum, and nothing said so.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, writeFileAtomic } from "../no-write.js";
import { readJsonSafe } from "../run.js";
import { compareTags, type EnginePin, type SkillConfig } from "./config.js";

export interface PinFile {
  tag: string;
  engineVersion: string;
  sha256: Record<string, string>;
  syncedAt: string;
}

export const sha256 = (buf: Buffer | string): string => createHash("sha256").update(buf).digest("hex");

export interface PinStatus {
  engine: string;
  ok: boolean;
  /** The tag recorded in the pin file, when there is one. */
  tag?: string;
  engineVersion?: string;
  problems: string[];
}

/**
 * Verify every vendored engine against its pin, offline.
 *
 * Offline is the point: this runs in CI on every commit, and a gate that needs
 * the network is a gate that goes red when GitHub does.
 */
export function checkPins(root: string, config: SkillConfig): PinStatus[] {
  return Object.entries(config.engines).map(([name, pin]) => {
    const problems: string[] = [];
    const metaPath = join(root, config.vendorDir, pin.meta);
    const meta = readJsonSafe<PinFile>(metaPath);
    if (!meta?.tag || !meta.sha256) {
      return {
        engine: name,
        ok: false,
        problems: [`no readable pin at ${config.vendorDir}/${pin.meta} — run \`skill vendor --engine ${name} --ref <tag>\` first.`],
      };
    }

    for (const f of pin.files ?? []) {
      const local = join(root, config.vendorDir, f.local);
      let actual: string;
      try {
        actual = sha256(readFileSync(local));
      } catch {
        problems.push(`${config.vendorDir}/${f.local} is missing — the pin records it but it is not on disk.`);
        continue;
      }
      const expected = meta.sha256[f.local];
      if (!expected) problems.push(`${config.vendorDir}/${f.local} is not recorded in ${pin.meta} — re-pin.`);
      else if (actual !== expected) problems.push(`DRIFT in ${config.vendorDir}/${f.local} — the bytes differ from the ${meta.tag} pin.`);
    }

    // Only worth reporting once the bytes are trustworthy: a tampered vendor
    // that is ALSO stale should say "tampered", which is the actionable half.
    if (!problems.length && compareTags(meta.tag, pin.minRef) < 0) {
      problems.push(
        `STALE ${name} pin — vendored ${meta.tag}, but this repo's source needs at least ${pin.minRef}. ` +
          `Run \`skill vendor --engine ${name} --ref ${pin.minRef}\` (or newer).`,
      );
    }

    return { engine: name, ok: problems.length === 0, tag: meta.tag, engineVersion: meta.engineVersion, problems };
  });
}

export interface VendorResult {
  written: string[];
  errors: string[];
  tag?: string;
  engineVersion?: string;
}

/**
 * Fetch an engine's artifacts at a tag and record the pin.
 *
 * The bytes are written UNMODIFIED — byte-identical to upstream — because the
 * hash check is only meaningful if what is on disk is what was published.
 *
 * A tag whose bundle disagrees about its own version is refused. That
 * disagreement means the release was built from different source than the tag
 * claims, and vendoring it would record a lie that every later check would
 * happily confirm.
 */
export async function vendorEngine(
  root: string,
  config: SkillConfig,
  name: string,
  ref: string,
  fetchFile: (url: string) => Promise<Buffer | undefined>,
): Promise<VendorResult> {
  const pin: EnginePin | undefined = config.engines[name];
  if (!pin) return { written: [], errors: [`unknown engine "${name}" — expected one of: ${Object.keys(config.engines).join(", ")}.`] };

  const vendorDir = join(root, config.vendorDir);
  ensureDir(vendorDir);

  const sums: Record<string, string> = {};
  const written: string[] = [];
  for (const f of pin.files ?? []) {
    const url = `https://raw.githubusercontent.com/${pin.repo}/${ref}/${f.remote}`;
    const buf = await fetchFile(url);
    if (!buf) return { written, errors: [`could not fetch ${url}`] };
    const local = join(vendorDir, f.local);
    // The BUFFER, not a decoded string: the hash below has to be over the bytes
    // that were published, and a round trip through a string encoding is
    // exactly how a pin comes to record something upstream never shipped.
    writeFileAtomic(local, buf);
    sums[f.local] = sha256(buf);
    written.push(local);
  }

  const first = (pin.files ?? [])[0];
  const bundle = first ? readFileSync(join(vendorDir, first.local), "utf8") : "";
  const engineVersion = /ENGINE_VERSION = "([^"]+)"/.exec(bundle)?.[1];
  if (!engineVersion || `v${engineVersion}` !== ref) {
    return {
      written,
      errors: [
        `the ${name} bundle reports ENGINE_VERSION=${engineVersion ?? "?"} but the pinned ref is ${ref} — refusing to record a pin that disagrees with its bytes.`,
      ],
    };
  }

  const meta: PinFile = { tag: ref, engineVersion, sha256: sums, syncedAt: new Date().toISOString() };
  const metaPath = join(vendorDir, pin.meta);
  writeFileAtomic(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  written.push(metaPath);
  return { written, errors: [], tag: ref, engineVersion };
}
