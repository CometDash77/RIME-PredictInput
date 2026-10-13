// PROTOTYPE probe — deno form (Deno.Command + Deno.dlopen). Throwaway.
import fs from "node:fs";
import path from "node:path";
const RT = "deno " + Deno.version.deno;

const out = (o) => console.log(JSON.stringify(o));
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };

const user32 = Deno.dlopen("user32.dll", {
  FindWindowW: { parameters: ["pointer", "pointer"], result: "u64" },
  SendMessageTimeoutW: { parameters: ["u64", "u32", "u64", "pointer", "u32", "u32", "pointer"], result: "u64" },
});

// FindWindowW wants UTF-16LE; TextEncoder only emits UTF-8, so build the buffer by hand.
const wide = (s) => { const b = new Uint8Array((s.length + 1) * 2); for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); b[i * 2] = c & 0xff; b[i * 2 + 1] = c >> 8; } return b; };

function sendCd(payload) {
  const enc = new TextEncoder();
  const clsBuf = wide("WeaselIPCWindow_1.0");
  const hwnd = user32.symbols.FindWindowW(Deno.UnsafePointer.of(clsBuf), null);
  if (hwnd === 0n) return { ffi: "Deno.dlopen", found: false };
  const payloadBuf = enc.encode(payload + "\u0000");
  const cds = new Uint8Array(24);
  const dv = new DataView(cds.buffer);
  dv.setBigUint64(0, 0x52504d31n, true);
  dv.setUint32(8, payloadBuf.length, true);
  dv.setBigUint64(16, Deno.UnsafePointer.value(Deno.UnsafePointer.of(payloadBuf)), true);
  const res = new Uint8Array(8);
  const ok = user32.symbols.SendMessageTimeoutW(hwnd, 0x4a, 0n, Deno.UnsafePointer.of(cds), 3, 300, Deno.UnsafePointer.of(res));
  return { ffi: "Deno.dlopen", found: true, sent: ok !== 0n, delivered: new DataView(res.buffer).getBigUint64(0, true).toString() };
}

const mode = process.argv[2];
if (mode === "exit") { Deno.exit(0); }
else if (mode === "env") out({ runtime: RT, denoFfi: typeof Deno.dlopen === "function" });
else if (mode === "heartbeat") { console.log("READY " + RT); await new Promise((r) => setTimeout(r, Number(process.argv[3] || "8000"))); }
else if (mode === "child-report") {
  const [helper, outFile, cmode] = process.argv.slice(3, 6);
  try { fs.rmSync(outFile, { force: true }); } catch {}
  // NOTE: Deno.CommandOptions has no windowsHide — that absence is itself a measured finding.
  const child = new Deno.Command(helper, { args: ["report", outFile], stdin: "null", stdout: "null", stderr: "null" }).spawn();
  if (cmode === "hide") out({ runtime: RT, childMode: cmode, note: "Deno.Command has no windowsHide option; ran default instead", child: null });
  else {
    let j = null;
    for (let i = 0; i < 40 && !j; i++) { await new Promise((r) => setTimeout(r, 100)); j = readJson(outFile); }
    out({ runtime: RT, childMode: cmode, child: j });
  }
  try { child.kill(); } catch {}
}
else if (mode === "send") out({ runtime: RT, ...sendCd(process.argv[3]) });
else if (mode === "exitblock-natural") { new Deno.Command(process.argv[3], { args: ["sleep", "8000"], stdin: "null", stdout: "null", stderr: "null" }).spawn(); }
else if (mode === "exitblock-exit") { new Deno.Command(process.argv[3], { args: ["sleep", "8000"], stdin: "null", stdout: "null", stderr: "null" }).spawn(); Deno.exit(0); }
else if (mode === "exitblock-unref") { const c = new Deno.Command(process.argv[3], { args: ["sleep", "8000"], stdin: "null", stdout: "null", stderr: "null" }).spawn(); try { c.unref(); } catch (e) { console.error("unref: " + e); } }
else if (mode === "lock") {
  const dir = process.argv[3]; const p = path.join(dir, "sidecar.lock");
  let fd; try { fd = fs.openSync(p, "wx"); } catch (e) { out({ runtime: RT, acquired: false, code: e.code }); Deno.exit(0); }
  fs.writeSync(fd, String(process.pid));
  let selfAlive = false; try { process.kill(process.pid, 0); selfAlive = true; } catch {}
  out({ runtime: RT, acquired: true, selfAlive, pid: process.pid });
  setTimeout(() => { try { fs.closeSync(fd); fs.rmSync(p, { force: true }); } catch {} Deno.exit(0); }, 5000);
}
else if (mode === "lock-second") {
  const dir = process.argv[3]; const p = path.join(dir, "sidecar.lock");
  let prevPid = 0; try { prevPid = Number(fs.readFileSync(p, "utf8")); } catch {}
  let fd = null, eexist = false;
  try { fd = fs.openSync(p, "wx"); } catch (e) { eexist = e.code === "EEXIST"; }
  let alive = false; try { process.kill(prevPid, 0); alive = true; } catch {}
  if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  out({ runtime: RT, eexist, prevAlive: alive });
  Deno.exit(0);
}
else if (mode === "acl") {
  const dir = process.argv[3];
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), "enabled = true\n");
  const grant = Deno.env.get("USERDOMAIN") + "\\" + Deno.env.get("USERNAME") + ":(OI)(CI)F";
  const r1 = new Deno.Command("icacls.exe", { args: [dir, "/inheritance:r", "/grant:r", grant], stdin: "ignore", stdout: "piped", stderr: "piped" }).output();
  const r2 = new Deno.Command("icacls.exe", { args: [dir], stdin: "ignore", stdout: "piped", stderr: "piped" }).output();
  out({
    runtime: RT,
    icaclsTighten: r1.code, icaclsRead: r2.code,
    stderr: new TextDecoder().decode(r1.stderr).slice(0, 120),
    acl: new TextDecoder().decode(r2.stdout).split(/\r?\n/).slice(0, 4),
  });
}
else { out({ runtime: RT, error: "unknown mode " + mode }); Deno.exit(2); }
