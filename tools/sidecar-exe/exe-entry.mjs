// Single-file exe entry shim (issue #9 / ADR 0003): argv[1] is the executable
// itself in pkg form, so user args start at slice(2); node running the bundle
// directly also lands on slice(2). Imports main-noguard.mjs (strip-guard output):
// no TLA / no import.meta, required for CJS bundling; .then() avoids TLA here too.
import { main } from "../../dist/cli/main-noguard.mjs";
main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
