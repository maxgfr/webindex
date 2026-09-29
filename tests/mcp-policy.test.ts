import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { confinePath, isPublicAddress, publicUrlRefusal, publicUrlsOnly } from "../src/mcp/policy.js";

// The opt-in hardening an operator exposing the server wants: a fetch that
// cannot be pointed at the machine's own network, and a file tool that cannot
// leave one directory. Both are pure enough to test without a server.

describe("isPublicAddress", () => {
  it.each([
    "127.0.0.1",
    "127.255.255.254",
    "0.0.0.0",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // every cloud's metadata endpoint
    "100.100.100.200", // carrier-grade NAT, and Alibaba Cloud's metadata
    "192.0.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fe80::1",
    "fc00::1",
    "fd00:ec2::254", // AWS's IPv6 metadata endpoint
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "::127.0.0.1",
    "64:ff9b::a00:1", // NAT64 of 10.0.0.1
    "2002:c0a8:101::1", // 6to4 of 192.168.1.1
    "2001:db8::1",
    "not an address",
  ])("refuses %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each([
    "93.184.216.34",
    "140.82.114.3",
    "8.8.8.8",
    "172.32.0.1",
    "100.128.0.1",
    "2606:4700::1111",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "2002:808:808::1",
  ])("allows %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });
});

describe("publicUrlRefusal", () => {
  const lookup = (table: Record<string, string[]>) => async (host: string) => {
    const hit = table[host];
    if (!hit) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return hit.map((address) => ({ address }));
  };

  it("refuses a literal private address in every spelling the URL parser accepts", async () => {
    for (const url of ["http://127.0.0.1/", "http://2130706433/", "http://0x7f.1/", "http://[::ffff:127.0.0.1]/", "http://169.254.169.254/latest/meta-data/"]) {
      expect(await publicUrlRefusal(url, lookup({})), url).toMatch(/not a public address/);
    }
  });

  it("refuses a name that resolves to one, even when another of its addresses is public", async () => {
    const dns = lookup({ "metadata.google.internal": ["169.254.169.254"], "split.test": ["93.184.216.34", "10.0.0.8"], "ok.test": ["93.184.216.34"] });
    expect(await publicUrlRefusal("http://metadata.google.internal/computeMetadata/v1/", dns)).toMatch(/resolves to 169\.254\.169\.254/);
    expect(await publicUrlRefusal("https://split.test/", dns)).toMatch(/10\.0\.0\.8/);
    expect(await publicUrlRefusal("https://ok.test/page", dns)).toBeUndefined();
  });

  it("refuses what it cannot check: a name that does not resolve, and a scheme that is not http(s)", async () => {
    expect(await publicUrlRefusal("https://nowhere.test/", lookup({}))).toMatch(/did not resolve/);
    expect(await publicUrlRefusal("file:///etc/passwd", lookup({}))).toMatch(/not http/);
    expect(await publicUrlRefusal("not a url", lookup({}))).toMatch(/not a URL/);
  });

  it("is an authorizer httpGet can run at every redirect hop", async () => {
    const allow = publicUrlsOnly(lookup({ "ok.test": ["93.184.216.34"] }));
    expect(await allow("https://ok.test/")).toBe(true);
    expect(await allow("http://localhost/")).toBe(false);
  });
});

describe("confinePath", () => {
  const temps: string[] = [];
  afterAll(() => {
    for (const d of temps) rmSync(d, { recursive: true, force: true });
  });
  const tree = () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "webindex-policy-")));
    temps.push(base);
    const root = join(base, "root");
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "a.txt"), "inside");
    writeFileSync(join(base, "secret.txt"), "outside");
    symlinkSync(join(base, "secret.txt"), join(root, "docs", "escape.txt"));
    symlinkSync(join(root, "docs", "a.txt"), join(root, "alias.txt"));
    return { base, root };
  };

  it("resolves a relative path against the root, and an absolute one inside it", () => {
    const { root } = tree();
    expect(confinePath(root, "docs/a.txt")).toBe(join(root, "docs", "a.txt"));
    expect(confinePath(root, join(root, "docs", "a.txt"))).toBe(join(root, "docs", "a.txt"));
    expect(confinePath(root, "alias.txt")).toBe(join(root, "docs", "a.txt"));
  });

  it("refuses a path outside the root, by traversal or by symlink", () => {
    const { base, root } = tree();
    expect(() => confinePath(root, "../secret.txt")).toThrow(/outside/);
    expect(() => confinePath(root, join(base, "secret.txt"))).toThrow(/outside/);
    expect(() => confinePath(root, "docs/escape.txt")).toThrow(/outside/);
  });

  it("says the same about a path outside the root whether or not it exists", () => {
    // Otherwise the refusal itself answers "does /etc/whatever exist?".
    const { root } = tree();
    const there = (() => {
      try {
        confinePath(root, "/etc/passwd");
      } catch (e) {
        return (e as Error).message;
      }
    })();
    const notThere = (() => {
      try {
        confinePath(root, "/etc/no-such-file-here");
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(there?.replace("passwd", "X")).toBe(notThere?.replace("no-such-file-here", "X"));
  });

  it("names a file that is not there inside the root as missing", () => {
    const { root } = tree();
    expect(() => confinePath(root, "docs/missing.txt")).toThrow(/no such file/);
  });

  it("takes a path under the root as the operator spelled it, when that spelling runs through a symlink", () => {
    // macOS's /tmp is /private/tmp, and $TMPDIR is under /var → /private/var:
    // the absolute paths the server advertised were refused as outside it.
    const { base, root } = tree();
    const link = join(base, "link");
    symlinkSync(root, link);
    expect(confinePath(link, join(link, "docs", "a.txt"))).toBe(join(root, "docs", "a.txt"));
    expect(confinePath(link, "docs/a.txt")).toBe(join(root, "docs", "a.txt"));
    expect(confinePath(link, join(root, "docs", "a.txt"))).toBe(join(root, "docs", "a.txt"));
    // The wall itself is unchanged, and names the root as it was given.
    expect(() => confinePath(link, join(link, "..", "secret.txt"))).toThrow(new RegExp(`outside ${link}`));
    expect(() => confinePath(link, "../secret.txt")).toThrow(/outside/);
    expect(() => confinePath(link, join(link, "docs", "escape.txt"))).toThrow(/outside/);
    expect(() => confinePath(link, join(base, "secret.txt"))).toThrow(/outside/);
    expect(() => confinePath(link, join(link, "missing.txt"))).toThrow(new RegExp(`no such file under ${link}`));
  });
});
