/**
 * settings.json 的读写边界。
 *
 * 断言的核心是「字节级兼容」：旧实现写出来的 json 必须能被新实现逐字节复现，
 * 否则用户目录里同一份文件会在两代进程之间来回改写。
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_MODEL, DEFAULT_SETTINGS, MAX_SETTINGS_BYTES, settingsFromMapping, toWire } from "../src/domain/settings.js";
import { expectOk } from "../src/domain/result.js";
import { appPaths, type AppPaths } from "../src/ipc/app-paths.js";
import { SettingsStore, migrateLegacySettings } from "../src/settings/store.js";
import { oracle } from "./support/oracle.js";

const workspace = mkdtempSync(join(tmpdir(), "rime-settings-"));

function store(path: string): SettingsStore {
  return new SettingsStore(path, {
    prepareDirectory: (directory: string) => {
      mkdirSync(directory, { recursive: true });
    },
    randomHex: () => "0123456789abcdef",
  });
}

function settings(mapping: unknown) {
  return expectOk(settingsFromMapping(mapping), (error) => "rejected setting: " + error);
}

describe("设置存储", () => {
  it("写出的 settings.json 与旧实现逐字节一致", () => {
    const path = join(workspace, "settings.json");
    expectOk(store(path).save(settings({ enabled: true, slot: 3 })), (error) => "save failed: " + error);
    expect(readFileSync(path, "utf8")).toBe(oracle.responses.settings_file_bytes);
  });

  it("overwrite:false 写出的文件与旧实现逐字节一致", () => {
    const path = join(workspace, "second.json");
    expectOk(store(path).save(settings({}), { overwrite: false }), (error) => "save failed: " + error);
    expect(readFileSync(path, "utf8")).toBe(oracle.responses.settings_file_no_overwrite_bytes);
  });

  it("目标已存在时不覆盖并发写入的设置", () => {
    const path = join(workspace, "guarded.json");
    expectOk(store(path).save(settings({ slot: 7 }), { overwrite: false }), (error) => "save failed: " + error);
    const written = readFileSync(path, "utf8");
    const second = store(path).save(settings({ slot: 9 }), { overwrite: false });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toBe("settings_already_exists");
    expect(readFileSync(path, "utf8")).toBe(written);
  });

  it("写出的设置可以原样读回", () => {
    const path = join(workspace, "round-trip.json");
    const written = settings({ enabled: true, backend: "local", provider: null, local_model: "m:1", slot: 2, local_wait_ms: 180, log_mode: "off", thresholds: { "pair:1": 0.5 } });
    expectOk(store(path).save(written), (error) => "save failed: " + error);
    const loaded = expectOk(store(path).load(), (error) => "load failed: " + error);
    expect(toWire(loaded)).toEqual(toWire(written));
  });

  it("缺失的文件读成默认设置", () => {
    const loaded = expectOk(store(join(workspace, "absent.json")).load(), (error) => "load failed: " + error);
    expect(loaded).toEqual(DEFAULT_SETTINGS);
    expect(loaded.localModel).toBe(DEFAULT_MODEL);
  });

  it("旧的 Cloud 偏好按默认设置运行且原文件不动", () => {
    const path = join(workspace, "cloud.json");
    const legacy = '{"enabled":true,"backend":"cloud","slot":3}';
    writeFileSync(path, legacy, "utf8");
    const loaded = expectOk(store(path).load(), (error) => "load failed: " + error);
    expect(loaded.enabled).toBe(false);
    expect(loaded.slot).toBe(DEFAULT_SETTINGS.slot);
    expect(readFileSync(path, "utf8")).toBe(legacy);
  });

  it("过大的文件被拒绝", () => {
    const path = join(workspace, "huge.json");
    writeFileSync(path, " ".repeat(MAX_SETTINGS_BYTES + 1), "utf8");
    const loaded = store(path).load();
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error).toBe("settings file is too large");
  });

  it("损坏的文件被拒绝", () => {
    const path = join(workspace, "broken.json");
    writeFileSync(path, '{"enabled":', "utf8");
    const loaded = store(path).load();
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error).toBe("settings file is unreadable");
  });
});

describe("旧位置迁移", () => {
  it("只在目标不存在时搬一次", () => {
    const localAppData = join(workspace, "local-app-data");
    const legacyDirectory = join(localAppData, "rime-model-predict");
    mkdirSync(legacyDirectory, { recursive: true });
    writeFileSync(join(legacyDirectory, "settings.json"), '{"enabled":true,"slot":3}', "utf8");

    const paths = appPaths(join(workspace, "user", ".rime-model-predict"));
    expect(migrate(paths, localAppData)).toBe(true);
    expect(readFileSync(paths.settings, "utf8")).toBe(oracle.responses.settings_file_bytes);
    const loaded = expectOk(store(paths.settings).load(), (error) => "load failed: " + error);
    expect(loaded.enabled).toBe(true);
    expect(loaded.slot).toBe(3);

    expect(migrate(paths, localAppData)).toBe(false);
    expect(migrate(appPaths(join(workspace, "other", ".rime-model-predict")), join(workspace, "no-legacy"))).toBe(false);
  });
});

function migrate(paths: AppPaths, localAppData: string): boolean {
  return migrateLegacySettings(paths, localAppData);
}
