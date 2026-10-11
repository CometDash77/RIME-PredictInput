import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { describe, expect, test } from "vitest";

describe.skipIf(process.platform !== "win32")("native bootstrap cache guard", () => {
  test("accepts a private cache and rejects descendants redirected outside it", () => {
    const base = resolve("build/bootstrap-test");
    mkdirSync(base, { recursive: true });
    const workspace = mkdtempSync(join(base, "guard-"));
    const cache = join(workspace, "RimePredictInstaller");
    const outside = join(workspace, "outside");
    const guard = (root: string) => spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File",
      resolve("tools/installer/cache-guard.ps1"), "-Root", root], {
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "programdata")),
        ProgramData: workspace }, windowsHide: true, encoding: "utf8",
    });
    try {
      mkdirSync(join(cache, "cache/0.1.0"), { recursive: true });
      mkdirSync(outside);
      const ordinary = guard(cache);
      expect(ordinary.status, ordinary.stderr).toBe(0);
      expect(guard(outside).status).not.toBe(0);
      symlinkSync(outside, join(cache, "cache/0.1.0/redirect"), "junction");
      const linked = guard(cache);
      expect(linked.status).not.toBe(0);
      expect(linked.stderr).toContain("Refusing linked installer cache");
    } finally {
      // Delete only the verified test checkout child; never the redirected target.
      if (!workspace.startsWith(base + sep)) throw new Error("Unexpected test workspace");
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
