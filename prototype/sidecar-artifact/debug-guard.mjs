import { pathToFileURL } from "node:url";
console.log(JSON.stringify({ importMeta: import.meta.url, argv1: process.argv[1], argUrl: pathToFileURL(process.argv[1]).href, cwd: process.cwd(), equal: import.meta.url === pathToFileURL(process.argv[1]).href }));
