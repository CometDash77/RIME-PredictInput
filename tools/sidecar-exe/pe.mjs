// PE header tool — read/patch Subsystem (CUI 3 <-> GUI 2), clear cert dir.
// Promoted verbatim from prototype/sidecar-artifact (issue #9, P0-verified).
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";

function peBase(file) {
  const b = readFileSync(file);
  const peOff = b.readUInt32LE(0x3c);
  if (b.readUInt32LE(peOff) !== 0x00004550) throw new Error("not PE: " + file);
  const opt = peOff + 24;
  const magic = b.readUInt16LE(opt); // 0x10b PE32 / 0x20b PE32+
  const dirOff = opt + (magic === 0x20b ? 112 : 96);
  return { b, peOff, opt, magic, dirOff };
}

export function peInfo(file) {
  const { b, peOff, magic, dirOff } = peBase(file);
  return {
    file,
    magic: magic.toString(16),
    machine: b.readUInt16LE(peOff + 4) === 0x8664 ? "x64" : "other",
    subsystem: b.readUInt16LE(peOff + 24 + 68), // 2=GUI, 3=CUI
    certSize: b.readUInt32LE(dirOff + 36),
  };
}

// copy src -> dest and set Subsystem = 2 (GUI)
export function copyAsGui(src, dest) {
  copyFileSync(src, dest);
  const { b } = peBase(dest);
  b.writeUInt16LE(2, peOffset(dest));
  writeFileSync(dest, b);
}
function peOffset(file) { const b = readFileSync(file); return b.readUInt32LE(0x3c) + 24 + 68; }

export function stripCert(file) {
  const { b, dirOff } = peBase(file);
  b.writeUInt32LE(0, dirOff + 32); // Certificate Table RVA
  b.writeUInt32LE(0, dirOff + 36); // Certificate Table size
  writeFileSync(file, b);
}

import { pathToFileURL } from "node:url";
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , cmd, ...rest] = process.argv;
  if (cmd === "info") { for (const f of rest) console.log(JSON.stringify(peInfo(f))); }
  else if (cmd === "copy-gui") copyAsGui(rest[0], rest[1]);
  else if (cmd === "strip-cert") stripCert(rest[0]);
  else console.error("usage: node pe.mjs info <files...> | copy-gui <src> <dest> | strip-cert <file>");
}
