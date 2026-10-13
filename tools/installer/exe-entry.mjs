import { main } from "../../dist/installer/main.js";
main(process.argv.slice(2)).then(code => { process.exitCode = code; });
