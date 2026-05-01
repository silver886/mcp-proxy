#!/usr/bin/env node
// Reads `lockedDependencies` from package.json, downloads each registry
// tarball over node:https, verifies the sha512 integrity recorded by
// `lockdeps.mjs` at pack time, and writes the verified tarballs to ./vendor/.
// Extraction is intentionally out of scope — pair with `tar -xzf` (system
// `tar` is on Win10 1803+, every Linux, every macOS) or your unpacker.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_PATH = join(ROOT, "package.json");
const OUT_DIR = resolve(ROOT, process.argv[2] ?? "vendor");
const USER_AGENT = "mcp-proxy-fetch";

const pkg = JSON.parse(await readFile(PKG_PATH, "utf8"));
const locked = pkg.lockedDependencies ?? {};
const names = Object.keys(locked);
if (names.length === 0) {
  console.log("No lockedDependencies in package.json; nothing to fetch.");
  process.exit(0);
}

await mkdir(OUT_DIR, { recursive: true });

for (const name of names) {
  const info = locked[name];
  console.log(`fetch ${name}@${info.version}`);
  const buf = await fetchAndVerify(info.tarball, info.integrity);
  // Slug the package name so scoped + unscoped packages don't collide on
  // the registry's bare `<name>-<version>.tgz` filename.
  const slug = name.replace(/^@/, "").replace(/\//g, "+");
  const out = join(OUT_DIR, `${slug}-${info.version}.tgz`);
  await writeFile(out, buf);
  console.log(`  -> ${out} (${buf.length} bytes)`);
}
console.log(`fetched ${names.length} package${names.length === 1 ? "" : "s"} into ${OUT_DIR}`);

async function fetchAndVerify(url, integrity) {
  const buf = await fetchBuffer(url, 5);
  const dash = integrity.indexOf("-");
  const algo = integrity.slice(0, dash);
  const expected = integrity.slice(dash + 1);
  if (algo !== "sha512") throw new Error(`unsupported integrity algo: ${algo}`);
  const actual = createHash("sha512").update(buf).digest("base64");
  if (actual !== expected) {
    throw new Error(`integrity mismatch for ${url}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
  return buf;
}

function fetchBuffer(url, redirectsLeft) {
  return new Promise((resolveP, rejectP) => {
    const u = new URL(url);
    const req = request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "GET",
        headers: { "user-agent": USER_AGENT, "accept": "*/*" },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          if (redirectsLeft <= 0) return rejectP(new Error(`too many redirects: ${url}`));
          const next = new URL(res.headers.location, url).toString();
          res.resume();
          fetchBuffer(next, redirectsLeft - 1).then(resolveP, rejectP);
          return;
        }
        if (status !== 200) {
          res.resume();
          return rejectP(new Error(`HTTP ${status} for ${url}`));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolveP(Buffer.concat(chunks)));
        res.on("error", rejectP);
      },
    );
    req.on("error", rejectP);
    req.end();
  });
}
