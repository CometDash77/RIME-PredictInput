// PROTOTYPE measurement orchestrator for issue #9 (throwaway).
// Runs the full matrix, prints live state, writes results.json next to this file.
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { peInfo } from "./pe.mjs";

const PROTO = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(PROTO, "..", "..");
const ART = path.join(PROTO, "artifacts");
const HELPER = path.join(PROTO, "helper.exe");
const PROBE_NODE = path.join(PROTO, "probe-node.cjs");
const RESULTS = path.join(PROTO, "results.json");

const exists = (p) => fs.existsSync(p);
const mb = (n) => (n / 1048576).toFixed(1) + "MB";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (o) => console.log(JSON.stringify(o));
const COPYDATA_ID = 0x52504d31;

function run(exe, args, opts = {}) {
  const t0 = Date.now();
  const r = spawnSync(exe, args, { encoding: "utf8", timeout: opts.timeout ?? 15000, windowsHide: true, cwd: opts.cwd ?? PROTO });
  return { code: r.status, signal: r.signal, stdout: r.stdout || "", stderr: r.stderr || "", ms: Date.now() - t0, timedOut: Boolean(r.error && r.error.code === "ETIMEDOUT") };
}
function parseFirstJson(s) {
  const line = String(s).split(/\r?\n/).find((l) => l.trim().startsWith("{"));
  try { return line ? JSON.parse(line) : null; } catch { return null; }
}
const readJsonFile = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
function taskkill(pid) { try { spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" }); } catch {} }
function pct(arr, q) { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]; }

// probe forms; node-baseline drives probe-node.cjs directly, artifact forms embed it
const forms = [
  { name: "node-baseline", exe: process.execPath, pre: [PROBE_NODE] },
  { name: "sea",       exe: path.join(ART, "probe-sea.exe"),       pre: [] },
  { name: "sea-gui",   exe: path.join(ART, "probe-sea-gui.exe"),   pre: [] },
  { name: "bun",       exe: path.join(ART, "probe-bun.exe"),       pre: [] },
  { name: "bun-gui",   exe: path.join(ART, "probe-bun-gui.exe"),   pre: [] },
  { name: "deno",      exe: path.join(ART, "probe-deno.exe"),      pre: [] },
  { name: "deno-gui",  exe: path.join(ART, "probe-deno-gui.exe"),  pre: [] },
  { name: "pkg",       exe: path.join(ART, "probe-pkg.exe"),       pre: [] },
  { name: "pkg-gui",   exe: path.join(ART, "probe-pkg-gui.exe"),   pre: [] },
];
for (const f of forms) f.ok = exists(f.exe);
const results = { startedAt: new Date().toISOString(), forms: {}, flash: {}, childWindow: {}, coldStart: {}, memory: {}, exitBlock: {}, lock: {}, copydata: {}, selftest: {} };

// ---------- P0 inventory ----------
console.log("=== P0 inventory: runtime / size / PE subsystem ===");
for (const f of forms) {
  if (!f.ok) { results.forms[f.name] = { missing: true }; J({ form: f.name, missing: true }); continue; }
  const size = fs.statSync(f.exe).size;
  let pe = null; try { pe = peInfo(f.exe); } catch (e) { pe = { error: String(e.message) }; }
  const env = parseFirstJson(run(f.exe, [...f.pre, "env"]).stdout) || {};
  results.forms[f.name] = { sizeBytes: size, sizeMB: mb(size), subsystem: pe.subsystem, runtime: env.runtime || null, ffi: env.koffi ?? env.bunFfi ?? env.denoFfi ?? null };
  J({ form: f.name, size: mb(size), subsystem: pe.subsystem, runtime: env.runtime || "?", ffi: results.forms[f.name].ffi });
}

// ---------- P1 console flash on spawn (parent gives no flags / CREATE_NO_WINDOW) ----------
console.log("=== P1 spawn console flash (helper spawns artifact; visible console windows counted) ===");
for (const f of forms) {
  if (!f.ok) continue;
  results.flash[f.name] = {};
  for (const flags of ["none", "no-window"]) {
    run(HELPER, ["consoles", PROTO + "\\_c0.json"]);
    const base = readJsonFile(PROTO + "\\_c0.json") || { count: -1 };
    run(HELPER, ["spawn", PROTO + "\\_c1.json", flags + "-nowait", f.exe, ...f.pre, "heartbeat", "1500"]);
    const r = parseFirstJson(fs.readFileSync(PROTO + "\\_c1.json", "utf8")) || {};
    await sleep(600);
    run(HELPER, ["consoles", PROTO + "\\_c2.json"]);
    const now = readJsonFile(PROTO + "\\_c2.json") || { count: -1 };
    if (r.pid) taskkill(r.pid);
    results.flash[f.name][flags] = { baseline: base.count, during: now.count, flash: now.count - base.count, spawnError: r.winError ?? null };
    J({ form: f.name, flags, flash: now.count - base.count, during: now.count });
  }
}

// ---------- P2 child-spawn window behavior from console-less artifact ----------
console.log("=== P2 artifact (console-less) spawns CUI child: child console state ===");
for (const f of forms) {
  if (!f.ok) continue;
  results.childWindow[f.name] = [];
  for (const parentFlags of ["no-window", "detached"]) {
    const modes = f.name.startsWith("deno") ? ["default"] : ["default", "hide"];
    for (const childMode of modes) {
      const r = run(f.exe, [...f.pre, "child-report", HELPER, path.join(os.tmpdir(), "proto-child.json"), childMode], { timeout: 20000 });
      const j = parseFirstJson(r.stdout);
      const row = { parentFlags, childMode, childAttached: j?.child?.attached ?? null, childVisible: j?.child?.visible ?? null, note: j?.note ?? null };
      results.childWindow[f.name].push(row);
      J({ form: f.name, ...row });
    }
  }
}

// ---------- P3 cold start: spawn -> READY line, 1 warmup + 10 runs ----------
console.log("=== P3 cold start (spawn to READY stdout, 1 warmup + 10 runs) ===");
for (const f of forms) {
  if (!f.ok) continue;
  const one = () => run(f.exe, [...f.pre, "heartbeat", "200"], { timeout: 20000 });
  const w = one();
  const times = []; let ready = String(w.stdout).startsWith("READY");
  for (let i = 0; i < 10; i++) { const r = one(); times.push(r.ms); ready = ready && String(r.stdout).startsWith("READY"); }
  results.coldStart[f.name] = { readyAll10: ready, p50: pct(times, 0.5), p95: pct(times, 0.95), min: Math.min(...times), max: Math.max(...times), runs: times };
  J({ form: f.name, readyAll10: ready, p50: pct(times, 0.5), p95: pct(times, 0.95) });
}

// ---------- P4 resident memory while idle ----------
console.log("=== P4 idle resident memory (heartbeat 6s, sampled at 4.5s) ===");
for (const f of forms) {
  if (!f.ok) continue;
  const out = PROTO + "\\_m.json";
  run(HELPER, ["spawn", out, "no-window-nowait", f.exe, ...f.pre, "heartbeat", "6000"]);
  const sp = parseFirstJson(fs.readFileSync(out, "utf8")) || {};
  let mem = null;
  if (sp.pid) {
    await sleep(4500);
    const ps = spawnSync("powershell.exe", ["-NoProfile", "-Command", "Get-Process -Id " + sp.pid + " | Select-Object Id,WorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress"], { encoding: "utf8", timeout: 15000, windowsHide: true });
    try { mem = JSON.parse(ps.stdout); } catch {}
    await sleep(2500);
    taskkill(sp.pid);
  }
  results.memory[f.name] = { ws: mem?.WorkingSet64 ?? null, private: mem?.PrivateMemorySize64 ?? null };
  J({ form: f.name, wsMB: mem ? mb(mem.WorkingSet64) : null, privMB: mem ? mb(mem.PrivateMemorySize64) : null });
}

// ---------- P5 exit semantics with live child ----------
console.log("=== P5 exit with live child (natural end / unref / process.exit), 5s budget ===");
for (const f of forms) {
  if (!f.ok) continue;
  results.exitBlock[f.name] = {};
  for (const v of ["exitblock-natural", "exitblock-unref", "exitblock-exit"]) {
    const r = run(f.exe, [...f.pre, v, HELPER], { timeout: 5000 });
    const blocked = r.timedOut || r.ms > 4500;
    results.exitBlock[f.name][v] = { ms: r.ms, blocked, code: r.code, signal: r.signal };
    J({ form: f.name, variant: v, ms: r.ms, blocked });
  }
}

// ---------- P6 single-instance lock equivalence ----------
console.log("=== P6 single-instance lock (openSync wx + kill(pid,0)) ===");
for (const f of forms) {
  if (!f.ok) continue;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-lock-"));
  const c1 = spawn(f.exe, [...f.pre, "lock", dir], { stdio: ["ignore", "pipe", "pipe"] });
  let o1 = ""; c1.stdout.on("data", (d) => (o1 += d));
  await sleep(1200);
  const r2 = run(f.exe, [...f.pre, "lock-second", dir], { timeout: 8000 });
  const j1 = await new Promise((res) => { const to = setTimeout(() => res(null), 8000); c1.on("close", () => { clearTimeout(to); res(parseFirstJson(o1)); }); });
  const j2 = parseFirstJson(r2.stdout);
  const pass = Boolean(j1?.acquired && j1?.selfAlive && j2?.eexist && j2?.prevAlive);
  results.lock[f.name] = { first: j1, second: j2, pass };
  J({ form: f.name, pass, first: j1, second: j2 });
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ---------- P7 WM_COPYDATA from inside each artifact form ----------
console.log("=== P7 WM_COPYDATA send from inside each form (mock receiver) ===");
{
  const recvFile = path.join(os.tmpdir(), "proto-recv.jsonl");
  try { fs.rmSync(recvFile, { force: true }); } catch {}
  const recv = spawn(HELPER, ["recv", recvFile, "40000"], { stdio: "ignore" });
  let ready = false;
  for (let i = 0; i < 30 && !ready; i++) { await sleep(100); try { ready = JSON.parse(fs.readFileSync(recvFile, "utf8")).ready === true; } catch {} }
  J({ receiverReady: ready });
  if (ready) {
    for (const f of forms) {
      if (!f.ok) continue;
      const payload = f.name + "\nreq-1\n1";
      const r = run(f.exe, [...f.pre, "send", payload], { timeout: 20000 });
      results.copydata[f.name] = { sender: parseFirstJson(r.stdout), stderr: r.stderr.slice(0, 200) };
      J({ form: f.name, sender: results.copydata[f.name].sender });
    }
    const ps = run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(PROTO, "ps-bridge.ps1"), "-Payload", "ps-bridge\nreq-1\n1"], { timeout: 30000 });
    results.copydata["ps-bridge"] = { sender: parseFirstJson(ps.stdout), ms: ps.ms };
    J({ form: "ps-bridge", sender: results.copydata["ps-bridge"].sender, ms: ps.ms });
    await sleep(500);
    taskkill(recv.pid);
    let entries = [];
    try {
      const raw = fs.readFileSync(recvFile, "utf8");
      const byLine = raw.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && e.utf8);
      // scan mode recovers records glued onto the ready line (line-parse misses those)
      const byScan = (raw.match(/\{[^{}]*\}/g) || []).map((t) => { try { return JSON.parse(t); } catch { return null; } }).filter((e) => e && e.utf8);
      entries = byScan.length >= byLine.length ? byScan : byLine;
    } catch {}
    for (const [form, rec] of Object.entries(results.copydata)) {
      const payload = form + "\nreq-1\n1";
      const hit = entries.find((e) => e.utf8.replace(/\u0000+$/, "") === payload);
      rec.received = hit ? { dwData: hit.dwData, cbData: hit.cbData, ok: (hit.dwData >>> 0) === COPYDATA_ID } : null;
      J({ form, received: rec.received });
    }
  }
}

// ---------- P8 real sidecar selftest equivalence ----------
console.log("=== P8 real sidecar selftest vs node direct ===");
{
  const baseline = parseFirstJson(run(process.execPath, [path.join(REPO, "dist", "cli", "main.js"), "selftest"], { cwd: REPO, timeout: 60000 }).stdout);
  results.selftest.baseline = { status: baseline?.status ?? null, checks: baseline?.checks ?? null, ms: null };
  J({ form: "node-dist-baseline", status: baseline?.status, checks: baseline?.checks?.map((c) => c.ok) });
  for (const [name, exe] of [["sea", path.join(ART, "rime-sea.exe")], ["sea-gui", path.join(ART, "rime-sea-gui.exe")], ["bun", path.join(ART, "rime-bun.exe")], ["deno", path.join(ART, "rime-deno.exe")], ["pkg", path.join(ART, "rime-pkg.exe")]]) {
    if (!exists(exe)) { results.selftest[name] = { missing: true }; J({ form: name, missing: true }); continue; }
    const r = run(exe, ["selftest"], { timeout: 90000 });
    const j = parseFirstJson(r.stdout);
    const checksMatch = Boolean(baseline?.checks && j?.checks && JSON.stringify(j.checks) === JSON.stringify(baseline.checks));
    results.selftest[name] = { code: r.code, status: j?.status ?? null, checksOk: j?.checks?.map((c) => c.ok) ?? null, checksMatch, ms: r.ms, stderr: r.stderr.slice(0, 300) };
    J({ form: name, code: r.code, status: j?.status, checksMatch, ms: r.ms });
  }
}

// cleanup scratch console snapshots
for (const f of ["_c0.json", "_c1.json", "_c2.json", "_m.json"]) { try { fs.rmSync(path.join(PROTO, f), { force: true }); } catch {} }

fs.writeFileSync(RESULTS, JSON.stringify(results, null, 2));
console.log("DONE results.json written");
