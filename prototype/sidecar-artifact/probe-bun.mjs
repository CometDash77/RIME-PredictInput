// PROTOTYPE probe — bun form (Bun.spawn + bun:ffi). Throwaway.
import fs from "node:fs";
import path from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";
const RT = "bun " + Bun.version;

const out = (o) => console.log(JSON.stringify(o));
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };

const user32 = dlopen("user32.dll", {
  FindWindowW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
  SendMessageTimeoutW: { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.u64, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.u64 },
});
const { FindWindowW, SendMessageTimeoutW } = user32.symbols;

function sendCd(payload) {
  const clsBuf = Buffer.from("WeaselIPCWindow_1.0\u0000", "utf16le");
  const hwnd = FindWindowW(ptr(clsBuf), null);
  if (hwnd === 0n) return { ffi: "bun:ffi", found: false };
  const payloadBuf = Buffer.from(payload + "\u0000", "utf8");
  const p = BigInt(ptr(payloadBuf));
  const cds = Buffer.alloc(24);
  const dv = new DataView(cds.buffer);
  dv.setBigUint64(0, 0x52504d31n, true);
  dv.setUint32(8, payloadBuf.length, true);
  dv.setBigUint64(16, p, true);
  const res = Buffer.alloc(8);
  const ok = SendMessageTimeoutW(hwnd, 0x4a, 0, BigInt(ptr(cds)), 3, 300, ptr(res));
  return { ffi: "bun:ffi", found: true, sent: ok !== 0n, delivered: res.readBigUInt64LE(0).toString() };
}

const mode = process.argv[2];
if (mode === "exit") { process.exit(0); }
else if (mode === "env") out({ runtime: RT, bunFfi: true });
else if (mode === "heartbeat") { process.stdout.write("READY " + RT + "\n"); setTimeout(() => process.exit(0), Number(process.argv[3] || "8000")); }
else if (mode === "child-report") {
  const [helper, outFile, cmode] = process.argv.slice(3, 6);
  try { fs.rmSync(outFile, { force: true }); } catch {}
  Bun.spawn([helper, "report", outFile], { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: cmode === "hide" });
  let j = null;
  for (let i = 0; i < 40 && !j; i++) { await Bun.sleep(100); j = readJson(outFile); }
  out({ runtime: RT, childMode: cmode, child: j });
}
else if (mode === "send") out({ runtime: RT, ...sendCd(process.argv[3]) });
else if (mode === "exitblock-natural") { Bun.spawn([process.argv[3], "sleep", "8000"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }); /* natural end */ }
else if (mode === "exitblock-exit") { Bun.spawn([process.argv[3], "sleep", "8000"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }); process.exit(0); }
else if (mode === "exitblock-unref") { const p = Bun.spawn([process.argv[3], "sleep", "8000"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }); p.unref(); }
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
  const r1 = Bun.spawnSync(["icacls.exe", dir, "/inheritance:r", "/grant:r", grant]);
  const r2 = Bun.spawnSync(["icacls.exe", dir]);
  out({
    runtime: RT,
    icaclsTighten: r1.exitCode, icaclsRead: r2.exitCode,
    stderr: (r1.stderr || "").toString().slice(0, 120),
    acl: (r2.stdout || "").toString().split(/\r?\n/).slice(0, 4),
  });
}
else { out({ runtime: RT, error: "unknown mode " + mode }); process.exit(2); }
