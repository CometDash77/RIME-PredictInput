/**
 * 设置页主机的边界测试：回环约束、令牌会话、页面 nonce、以及 400/401/403/404/503 的
 * 分支。这里用真实的 HTTP 请求打真实监听的回环端口，因为这一层最容易出错的地方就是
 * 「线」本身的形状（状态码、响应头、请求方式），而不是内部函数。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_MODEL, DEFAULT_SETTINGS, type Settings } from "../src/domain/settings.js";
import { ok, type Result } from "../src/domain/result.js";
import type { InferenceStatusMetadata, SidecarState } from "../src/domain/status.js";
import type { SettingsActionReply } from "../src/inference/actions.js";
import type { HealthReport } from "../src/inference/health.js";
import type { JsonObject } from "../src/json/guards.js";
import type { SettingsStoreError } from "../src/settings/store.js";
import {
  SettingsWebHost,
  type SettingsWebInference,
  type SettingsWebRuntime,
  type SettingsWebStore,
} from "../src/web/settings-host.js";
import { safeError, safeMetadata } from "../src/web/safe-metadata.js";
import { toJsonObject } from "./support/json.js";

const TOKEN = "t".repeat(43);
const OTHER_TOKEN = "u".repeat(43);
const PAGE = '<html><style nonce="__NONCE__"></style><script nonce="__NONCE__">1</script></html>';

class FakeStore implements SettingsWebStore {
  saved: Settings | null = null;

  save(settings: Settings): Result<Settings, SettingsStoreError> {
    this.saved = settings;
    return ok(settings);
  }
}

class FakeRuntime implements SettingsWebRuntime {
  readonly store = new FakeStore();
  readonly idle = {
    touch: (): void => {
      this.touches += 1;
    },
  };
  settings: Settings = DEFAULT_SETTINGS;
  reload: Result<Settings, SettingsStoreError> = ok(DEFAULT_SETTINGS);
  lastState: SidecarState = "ready";
  pid = 4242;
  touches = 0;

  get settingsStore(): SettingsWebStore {
    return this.store;
  }

  reloadSettings(): Result<Settings, SettingsStoreError> {
    return this.reload;
  }
}

class FakeInference implements SettingsWebInference {
  statusRevision = 3;
  revisionsSeen: number[] = [];
  actions: JsonObject[] = [];
  healthFails = false;

  health(): Promise<HealthReport> {
    if (this.healthFails) return Promise.reject(new Error("provider exploded"));
    return Promise.resolve({
      status: "ready",
      backend: "local",
      connection: { status: "connected", provider: "local", version: "0.12.0" },
      selectedModel: { kind: "invalid-name", errorCode: "invalid_model_name" },
      cacheEntries: 2,
      lastInference: { status: "idle" },
    });
  }

  statusSince(revision: number): InferenceStatusMetadata {
    this.revisionsSeen.push(revision);
    return revision < this.statusRevision ? { status: "ok", cache_hit: true } : { status: "idle" };
  }

  settingsAction(payload: JsonObject): Promise<SettingsActionReply> {
    this.actions.push(payload);
    if (payload["action"] === "clear_cache") return Promise.resolve({ kind: "cache-cleared", cacheEntries: 0 });
    return Promise.resolve({ kind: "unavailable", errorCode: "invalid_request" });
  }
}

const directory = mkdtempSync(join(tmpdir(), "rime-settings-web-"));
const pagePath = join(directory, "settings.html");
writeFileSync(pagePath, PAGE, "utf8");

let host: SettingsWebHost;
let runtime: FakeRuntime;
let inference: FakeInference;
let base = "";

async function call(
  path: string,
  options: { readonly method?: string; readonly token?: string; readonly body?: unknown; readonly headers?: Record<string, string> } = {},
): Promise<{ readonly status: number; readonly body: unknown }> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.token !== undefined) headers["Authorization"] = `Bearer ${options.token}`;
  const response = await fetch(base + path, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

function rawHostRequest(hostHeader: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port: host.port, path: "/", method: "GET", headers: { Host: hostHeader } },
      (response) => {
        response.resume();
        response.on("end", () => {
          resolve(response.statusCode ?? 0);
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

beforeAll(async () => {
  runtime = new FakeRuntime();
  inference = new FakeInference();
  host = new SettingsWebHost({
    inference,
    runtime,
    port: 0,
    pageUrl: pathToFileURL(pagePath),
  });
  await host.start();
  base = `http://127.0.0.1:${host.port}`;
});

afterAll(async () => {
  await host.stop();
  rmSync(directory, { recursive: true, force: true });
});

describe("settings page", () => {
  it("serves the page with a fresh nonce and a locked-down CSP", async () => {
    const response = await fetch(base + "/");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).not.toContain("__NONCE__");
    const policy = response.headers.get("content-security-policy") ?? "";
    const nonce = /script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(policy)?.[1] ?? "";
    expect(nonce).not.toBe("");
    expect(html).toContain(`nonce="${nonce}"`);
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("rejects a host header that is not the loopback authority", async () => {
    expect(await rawHostRequest("evil.example")).toBe(400);
    expect(await rawHostRequest(`127.0.0.1:${host.port}`)).toBe(200);
  });

  it("answers 404 for unknown paths and 405 for OPTIONS", async () => {
    const missing = await call("/api/other");
    expect({ status: missing.status, body: missing.body }).toEqual({ status: 404, body: { error: "not_found" } });
    const options = await call("/", { method: "OPTIONS" });
    expect({ status: options.status, body: options.body }).toEqual({ status: 405, body: { error: "method_not_allowed" } });
  });

  it("answers 503 when the page asset cannot be read", async () => {
    const broken = new SettingsWebHost({
      inference,
      runtime,
      port: 0,
      pageUrl: pathToFileURL(join(directory, "missing.html")),
    });
    await broken.start();
    try {
      const response = await fetch(`http://127.0.0.1:${broken.port}/`);
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 503,
        body: { error: "ui_unavailable" },
      });
    } finally {
      await broken.stop();
    }
  });
});

describe("session tokens", () => {
  it("refuses short or non-URL-safe tokens", async () => {
    const short = await call("/session", { method: "POST", body: { token: "short" } });
    expect({ status: short.status, body: short.body }).toEqual({ status: 400, body: { error: "invalid_session" } });
    const bad = await call("/session", { method: "POST", body: { token: `${"t".repeat(40)}!` } });
    expect(bad.status).toBe(400);
  });

  it("rejects an origin that is not the loopback page", async () => {
    const rejected = await call("/session", {
      method: "POST",
      body: { token: TOKEN },
      headers: { Origin: "http://evil.example" },
    });
    expect({ status: rejected.status, body: rejected.body }).toEqual({ status: 403, body: { error: "origin_rejected" } });
    const accepted = await call("/session", {
      method: "POST",
      body: { token: TOKEN },
      headers: { Origin: `http://127.0.0.1:${host.port}` },
    });
    expect({ status: accepted.status, body: accepted.body }).toEqual({ status: 200, body: { status: "session_ready" } });
  });

  it("requires a bearer token for reads and writes", async () => {
    expect((await call("/api/settings")).body).toEqual({ error: "session_expired" });
    expect((await call("/api/settings", { method: "POST", body: {} })).status).toBe(401);
    expect((await call("/api/settings", { token: OTHER_TOKEN })).status).toBe(401);
  });

  it("ends a session and stops accepting its token", async () => {
    const ended = await call("/api/session/end", { method: "POST", token: TOKEN });
    expect({ status: ended.status, body: ended.body }).toEqual({ status: 200, body: { status: "ended" } });
    expect((await call("/api/settings", { token: TOKEN })).status).toBe(401);
  });
});

describe("settings view", () => {
  beforeAll(async () => {
    await call("/session", { method: "POST", body: { token: TOKEN } });
  });

  it("returns settings, a filtered health snapshot and the sidecar state", async () => {
    const response = await call("/api/settings", { token: TOKEN });
    expect(response.status).toBe(200);
    const body = toJsonObject(response.body);
    expect(Object.keys(toJsonObject(body["settings"]))[0]).toBe("enabled");
    const health = toJsonObject(body["health"]);
    expect(health["status"]).toBe("ready");
    expect(health["cache_entries"]).toBe(2);
    // 会话建立时记录的是当时的 status_revision：这里是 3，因此最近状态是 idle。
    expect(health["last_inference"]).toEqual({ status: "idle" });
    expect(body["sidecar"]).toEqual({ state: "ready", pid: 4242 });
    expect(runtime.touches).toBeGreaterThan(0);
  });

  it("degrades health to status_unavailable instead of failing the page", async () => {
    inference.healthFails = true;
    try {
      const response = await call("/api/settings", { token: TOKEN });
      const health = toJsonObject(toJsonObject(response.body)["health"]);
      expect({ status: health["status"], error_code: health["error_code"] }).toEqual({
        status: "unavailable",
        error_code: "status_unavailable",
      });
    } finally {
      inference.healthFails = false;
    }
  });

  it("saves a validated mapping and reports invalid values verbatim", async () => {
    const bad = await call("/api/settings", { method: "POST", token: TOKEN, body: { slot: 0 } });
    expect({ status: bad.status, body: bad.body }).toEqual({
      status: 400,
      body: { error: "slot must be a positive integer" },
    });
    const good = await call("/api/settings", {
      method: "POST",
      token: TOKEN,
      body: { enabled: true, backend: "local", provider: null, local_model: DEFAULT_MODEL, slot: 5, local_wait_ms: 150, thresholds: {}, log_mode: "metadata" },
    });
    expect({ status: good.status, body: good.body }).toEqual({ status: 200, body: { status: "ok" } });
    expect(runtime.store.saved?.enabled).toBe(true);
    expect(runtime.store.saved?.slot).toBe(5);
  });

  it("routes actions and reports an unknown action as invalid_request", async () => {
    const cleared = await call("/api/action", { method: "POST", token: TOKEN, body: { action: "clear_cache" } });
    expect({ status: cleared.status, body: cleared.body }).toEqual({
      status: 200,
      body: { status: "ok", cache_entries: 0 },
    });
    const unknown = await call("/api/action", { method: "POST", token: TOKEN, body: { action: "nonsense" } });
    expect(unknown.body).toEqual({ status: "unavailable", error_code: "invalid_request" });
    expect(inference.actions.at(-1)).toEqual({ action: "nonsense" });
  });

  it("rejects a body that is too large or not JSON", async () => {
    const tooLarge = await call("/api/settings", {
      method: "POST",
      token: TOKEN,
      body: { enabled: true, padding: "x".repeat(9000) },
    });
    expect({ status: tooLarge.status, body: tooLarge.body }).toEqual({ status: 400, body: { error: "invalid_json" } });
    const wrongType = await fetch(base + "/api/settings", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "text/plain" },
      body: "{}",
    });
    expect(wrongType.status).toBe(400);
  });
});

describe("response filtering", () => {
  it("drops forbidden keys at any depth", () => {
    expect(
      safeMetadata({ status: "ok", text: "用户正文", nested: { choice: 2, value: 1 }, token: "secret" }),
    ).toEqual({ status: "ok", nested: { value: 1 } });
  });

  it("folds non-JSON values and non-finite numbers to null", () => {
    expect(safeMetadata([undefined, Number.NaN, () => 1, new Date()])).toEqual([null, null, null, null]);
  });

  it("only passes whitelisted error strings through", () => {
    expect(safeError("slot must be a positive integer")).toBe("slot must be a positive integer");
    expect(safeError("settings file is too large")).toBe("invalid_request");
  });
});
