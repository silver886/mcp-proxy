import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// dist/proxy/pairing/static-assets.js → ../../../static (project root).
// Resolved at module load so we fail fast at startup rather than on the
// first browser hit.
const STATIC_DIR = resolve(__dirname, "..", "..", "..", "static");

export const SETUP_HTML = readFileSync(resolve(STATIC_DIR, "setup.html"));
export const SETUP_CSS = readFileSync(resolve(STATIC_DIR, "style.css"));
export const SETUP_PAGE_CSS = readFileSync(resolve(STATIC_DIR, "setup.css"));
export const SETUP_JS = readFileSync(resolve(STATIC_DIR, "setup.js"));
