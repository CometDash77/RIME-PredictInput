// Strip the TLA direct-invocation guard from dist/cli/main.js so the CJS bundle
// has no top-level await and no import.meta reference (ADR 0003 pipeline step).
// Refuses to emit anything if the guard block is not found (fail loud, not silent).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "..", "..", "dist", "cli", "main.js");
// Emit next to main.js so the module's relative imports (../runtime/lifecycle.js etc.) keep resolving.
const out = path.resolve(here, "..", "..", "dist", "cli", "main-noguard.mjs");
const code = readFileSync(src, "utf8");
const re = /\r?\nconst invokedDirectly[\s\S]*?process\.exitCode = await main\(process\.argv\.slice\(2\)\);\r?\n\}\r?\n?/;
const stripped = code.replace(re, "\n");
if (stripped === code) {
  console.error("strip-guard: guard block not found in dist/cli/main.js — refusing to emit bundle input");
  process.exit(1);
}
if (/\bimport\.meta\b/.test(stripped)) {
  console.error("strip-guard: import.meta still referenced after strip — CJS bundle would crash at runtime");
  process.exit(1);
}
writeFileSync(out, stripped);
console.log("strip-guard: wrote " + out);
