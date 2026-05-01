// Resolves runtime dependencies from pnpm-lock.yaml into a `lockedDependencies`
// field on package.json so the published tarball carries everything an offline
// installer needs (exact version, registry tarball URL, integrity hash) without
// requiring pnpm/npm at consume time. Walks transitively from the `dependencies`
// field; devDependencies are excluded.
//
// Modes:
//   (default) — write the field
//   remove    — delete the field (used by postpack to restore source state)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_PATH = resolve(ROOT, "package.json");
const LOCK_PATH = resolve(ROOT, "pnpm-lock.yaml");
const REGISTRY = "https://registry.npmjs.org";

const mode = process.argv[2];
const pkg = JSON.parse(readFileSync(PKG_PATH, "utf8"));

if (mode === "remove") {
  delete pkg.lockedDependencies;
  writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n");
  console.log("lockdeps: removed lockedDependencies from package.json");
} else {
  const lock = yaml.load(readFileSync(LOCK_PATH, "utf8"));
  const importer = lock.importers?.["."];
  if (!importer) throw new Error("pnpm-lock.yaml: missing importers['.']");

  const direct = pkg.dependencies ?? {};
  const queue = Object.keys(direct).map((name) => {
    const entry = importer.dependencies?.[name];
    if (!entry) throw new Error(`pnpm-lock.yaml: no resolution for direct dep ${name}`);
    return { name, version: entry.version };
  });

  const seen = new Set();
  const locked = {};
  while (queue.length > 0) {
    const { name, version } = queue.shift();
    const key = `${name}@${version}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const pkgEntry = lock.packages?.[key];
    if (!pkgEntry?.resolution?.integrity) {
      throw new Error(`pnpm-lock.yaml: missing resolution.integrity for ${key}`);
    }

    // Registry tarball URL convention: scoped → /@scope/name/-/name-version.tgz,
    // unscoped → /name/-/name-version.tgz. The file portion drops the scope.
    const file = name.startsWith("@") ? name.split("/")[1] : name;
    locked[name] = {
      version,
      tarball: `${REGISTRY}/${name}/-/${file}-${version}.tgz`,
      integrity: pkgEntry.resolution.integrity,
    };

    // Walk transitive deps from the snapshot. Strip pnpm's `(peer)` suffixes.
    const snap = lock.snapshots?.[key];
    for (const [depName, depVerRaw] of Object.entries(snap?.dependencies ?? {})) {
      const depVer = String(depVerRaw).split("(")[0];
      queue.push({ name: depName, version: depVer });
    }
  }

  pkg.lockedDependencies = locked;
  writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`lockdeps: wrote ${Object.keys(locked).length} locked dependencies`);
}
