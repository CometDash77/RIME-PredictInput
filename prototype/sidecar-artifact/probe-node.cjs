// PROTOTYPE probe — node form (also bundled by SEA and packaged by @yao-pkg/pkg). Throwaway.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const RT = "node " + process.version;

function out(o) { process.stdout.write(JSON.stringify(o) + "\n"); }
function sleepSync(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }

function sendKoffi(payload) {
  const koffi = require("koffi");
  const user32 = koffi.load("user32.dll");
  const FindWindowW = user32.func("FindWindowW", "uint64", ["str16", "str16"]);
  const SendMessageTimeoutW = user32.func("SendMessageTimeoutW", "uint64",
    ["uint64", "uint32", "uint64", "void *", "uint32", "uint32", "void *"]);
  const hwnd = FindWindowW("WeaselIPCWindow_1.0", null);
  if (!hwnd) return { ffi: "koffi", found: false };
  const payloadBuf = Buffer.from(payload + "\u0000", "utf8");
  const cds = Buffer.alloc(24);
  cds.writeBigUInt64LE(BigInt(0x52504d31), 0);          // COPYDATA_ID, matches completion-notify.ts
  cds.writeUInt32LE(payloadBuf.length, 8);
  if (typeof koffi.address !== "function") throw new Error("koffi.address unavailable");
  cds.writeBigUInt64LE(koffi.address(payloadBuf), 16);
  const res = Buffer.alloc(8);
  const ok = SendMessageTimeoutW(hwnd, 0x4a, 0, cds, 3 /*SMTO_ABORTIFHUNG*/, 300, res);
  return { ffi: "koffi", found: true, sent: Boolean(ok), delivered: res.readBigUInt64LE(0).toString() };
}

const mode = process.argv[2];
if (mode === "exit") { process.exit(0); }
else if (mode === "env") {
  let koffi; try { require("koffi"); koffi = true; } catch (e) { koffi = "no: " + String(e.message).slice(0, 60); }
  out({ runtime: RT, koffi });
}
else if (mode === "heartbeat") { process.stdout.write("READY " + RT + "\n"); setTimeout(() => process.exit(0), Number(process.argv[3] || "8000")); }
else if (mode === "child-report") {
  // child-report <helper> <outFile> <default|hide|detached> — spawn helper, it self-reports console state
  const [helper, outFile, cmode] = process.argv.slice(3, 6);
  try { fs.rmSync(outFile, { force: true }); } catch {}
  const c = spawn(helper, ["report", outFile], {
    stdio: "ignore",
    windowsHide: cmode === "hide",
    detached: cmode === "detached",
  });
  c.unref();
  let j = null;
  for (let i = 0; i < 40 && !j; i++) { sleepSync(100); j = readJson(outFile); }
  out({ runtime: RT, childMode: cmode, child: j });
}
else if (mode === "send") {
  let r; try { r = sendKoffi(process.argv[3]); } catch (e) { r = { ffi: "koffi", error: String((e && e.message) || e).slice(0, 160) }; }
  out({ runtime: RT, ...r });
}
else if (mode === "exitblock-natural") { spawn(process.argv[3], ["sleep", "8000"], { stdio: "ignore" }); /* script ends naturally */ }
else if (mode === "exitblock-exit") { spawn(process.argv[3], ["sleep", "8000"], { stdio: "ignore" }); process.exit(0); }
else if (mode === "exitblock-unref") { const c = spawn(process.argv[3], ["sleep", "8000"], { stdio: "ignore" }); c.unref(); }
else if (mode === "lock") {
  const dir = process.argv[3]; const p = path.join(dir, "sidecar.lock");
  let fd; try { fd = fs.openSync(p, "wx"); } catch (e) { out({ runtime: RT, acquired: false, code: e.code }); process.exit(0); }
  fs.writeSync(fd, String(process.pid));
  let selfAlive = false; try { process.kill(process.pid, 0); selfAlive = true; } catch {}
  out({ runtime: RT, acquired: true, selfAlive, pid: process.pid });
  setTimeout(() => { try { fs.closeSync(fd); fs.rmSync(p, { force: true }); } catch {} process.exit(0); }, 5000);
}
else if (mode === "lock-second") {
  const dir = process.argv[3]; const p = path.join(dir, "sidecar.lock");
  let prevPid = 0; try { prevPid = Number(fs.readFileSync(p, "utf8")); } catch {}
  let fd = null, eexist = false;
  try { fd = fs.openSync(p, "wx"); } catch (e) { eexist = e.code === "EEXIST"; }
  let alive = false; try { process.kill(prevPid, 0); alive = true; } catch {}
  if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  out({ runtime: RT, eexist, prevAlive: alive });
  process.exit(0);
}
else if (mode === "acl") {
  const dir = process.argv[3];
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), "enabled = true\n");
  const grant = process.env.USERDOMAIN + "\\" + process.env.USERNAME + ":(OI)(CI)F";
  const r1 = spawnSync("icacls.exe", [dir, "/inheritance:r", "/grant:r", grant], { windowsHide: true });
  const r2 = spawnSync("icacls.exe", [dir], { windowsHide: true });
  out({
    runtime: RT,
    icaclsTighten: r1.status, icaclsRead: r2.status,
    stderr: (r1.stderr || "").toString().slice(0, 120),
    acl: (r2.stdout || "").toString().split(/\r?\n/).slice(0, 4),
  });
}
else { out({ runtime: RT, error: "unknown mode " + mode }); process.exit(2); }
