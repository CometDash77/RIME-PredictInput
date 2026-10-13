// PROTOTYPE entry shim — real sidecar behind each artifact form. argv[1] is the
// executable itself in SEA/pkg/bun-compile forms, so user args start at slice(2);
// node running the bundle directly also lands on slice(2). Throwaway.
import { main } from "../../dist/cli/main.js";
process.exitCode = await main(process.argv.slice(2));
