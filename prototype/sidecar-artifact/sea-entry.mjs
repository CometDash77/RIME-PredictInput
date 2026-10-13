// PROTOTYPE entry shim — real sidecar behind each artifact form. argv[1] is the
// executable itself in SEA/pkg/bun-compile forms, so user args start at slice(2);
// node running the bundle directly also lands on slice(2). Throwaway.
// Imports main-noguard.mjs (strip-guard.mjs output): no TLA / no import.meta, required
// for CJS bundling; run.ps1 regenerates it before bundling. .then() avoids TLA here too.
import { main } from "../../dist/cli/main-noguard.mjs";
main(process.argv.slice(2)).then((code) => { process.exitCode = code; });