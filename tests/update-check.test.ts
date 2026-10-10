/**
 * 更新检查（spec #10 Testing Decisions）的三条行为锁定：
 * - 失败静默：传输拒绝、非 200、坏 JSON、无 stable 可比 → 一律 unavailable，绝不抛出。
 * - 无用户数据出站：GET 固定 URL、无 body、仅静态产品 UA。
 * - 比较逻辑只认 stable：draft/prerelease/非 semver tag 不参与。
 * 假 transport + 可注入时钟，不打真实 API。
 */

import { describe, expect, it } from "vitest";

import type { HttpRequestOptions, HttpResponse } from "../src/providers/http.js";
import type { HttpTransportLike } from "../src/providers/http.js";
import {
  RELEASES_API_URL,
  UPDATE_CHECK_USER_AGENT,
  UpdateChecker,
  latestStable,
  updateCheckOutcome,
} from "../src/providers/update.js";
import type { Result } from "../src/domain/result.js";
import { err, ok } from "../src/domain/result.js";
import type { TransportFailureCode } from "../src/domain/error-codes.js";

const RELEASE_URL = "https://github.com/CometDash77/RIME-PredictInput/releases/tag";

type Reply = Result<HttpResponse, TransportFailureCode>;

class FakeTransport implements HttpTransportLike {
  readonly calls: { method: string; url: string; options: HttpRequestOptions | undefined }[] = [];
  #reply: () => Reply;
  constructor(reply: () => Reply) {
    this.#reply = reply;
  }
  async request(
    method: string,
    url: string,
    options?: HttpRequestOptions,
  ): Promise<Result<HttpResponse, TransportFailureCode>> {
    this.calls.push({ method, url, options });
    return this.#reply();
  }
}

const jsonReply = (payload: unknown, status = 200): Reply =>
  ok({ status, body: new TextEncoder().encode(JSON.stringify(payload)) });

const rawReply = (text: string, status = 200): Reply =>
  ok({ status, body: new TextEncoder().encode(text) });

const entry = (tag: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  tag_name: tag,
  html_url: `${RELEASE_URL}/${tag}`,
  ...extra,
});

const CURRENT = "0.1.0";

describe("stable 判定与比较", () => {
  it("draft、prerelease 与非 semver tag 不参与比较，取最高 stable", () => {
    const payload = [
      entry("v0.11.0", { draft: true }),
      entry("0.10.0-rc1", { prerelease: true }),
      entry("nightly"),
      entry("v0.9.0"),
      entry("v0.1.0"),
    ];
    expect(latestStable(payload)).toEqual({ tag: "v0.9.0", url: `${RELEASE_URL}/v0.9.0` });
    expect(updateCheckOutcome(CURRENT, payload)).toEqual({
      kind: "update-available",
      latest: { tag: "v0.9.0", url: `${RELEASE_URL}/v0.9.0` },
    });
  });

  it("三段数字按数值比较：v0.10.0 高于 v0.9.0", () => {
    const payload = [entry("v0.10.0"), entry("v0.9.0")];
    expect(updateCheckOutcome("0.9.0", payload)).toEqual({
      kind: "update-available",
      latest: { tag: "v0.10.0", url: `${RELEASE_URL}/v0.10.0` },
    });
  });

  it("相等或当前更高都算无需更新", () => {
    expect(updateCheckOutcome("0.9.0", [entry("v0.9.0")])).toEqual({ kind: "up-to-date" });
    expect(updateCheckOutcome("0.10.0", [entry("v0.9.0")])).toEqual({ kind: "up-to-date" });
  });

  it.each([
    ["非数组", {}],
    ["空数组", []],
    ["条目缺 html_url", [{ tag_name: "v1.0.0" }]],
    ["外站链接", [entry("v9.0.0", { html_url: "https://evil.example.com/v9.0.0" })]],
  ])("%s 折叠为 unavailable", (_name, payload) => {
    expect(latestStable(payload)).toBeNull();
    expect(updateCheckOutcome(CURRENT, payload)).toEqual({ kind: "unavailable" });
  });
});

describe("UpdateChecker：无用户数据出站", () => {
  it("出站仅是 GET 固定 URL、无 body、仅静态产品 UA", async () => {
    const transport = new FakeTransport(() => jsonReply([entry("v0.2.0")]));
    const checker = new UpdateChecker({ transport, now: () => 1000, currentVersion: CURRENT });
    const outcome = await checker.maybeCheck();
    expect(outcome).toEqual({
      kind: "update-available",
      latest: { tag: "v0.2.0", url: `${RELEASE_URL}/v0.2.0` },
    });
    expect(transport.calls).toHaveLength(1);
    const call = transport.calls[0];
    expect(call?.method).toBe("GET");
    expect(call?.url).toBe(RELEASES_API_URL);
    expect(call?.options?.body).toBeUndefined();
    expect(Object.keys(call?.options?.headers ?? {})).toEqual(["user-agent"]);
    expect(call?.options?.headers?.["user-agent"]).toBe(UPDATE_CHECK_USER_AGENT);
    expect(UPDATE_CHECK_USER_AGENT).toBe("rime-model-predict/0.1.0");
  });
});

describe("UpdateChecker：节流（可注入时钟）", () => {
  it("窗口内重复询问不出站并返回缓存，窗口过后重新出站", async () => {
    let now = 1000;
    const transport = new FakeTransport(() => jsonReply([entry("v0.2.0")]));
    const checker = new UpdateChecker({ transport, now: () => now, currentVersion: CURRENT });
    await checker.maybeCheck();
    expect(transport.calls).toHaveLength(1);
    now += 3599;
    await checker.maybeCheck();
    expect(transport.calls).toHaveLength(1);
    now += 1;
    await checker.maybeCheck();
    expect(transport.calls).toHaveLength(2);
  });
});

describe("UpdateChecker：失败静默", () => {
  it.each([
    ["传输拒绝", (): Reply => err("timeout")],
    ["非 200", (): Reply => jsonReply([entry("v0.2.0")], 403)],
    ["坏 JSON", (): Reply => rawReply("not json{")],
  ])("%s → unavailable，不抛出且窗口内不再出站", async (_name, reply) => {
    const transport = new FakeTransport(reply);
    const checker = new UpdateChecker({ transport, now: () => 7, currentVersion: CURRENT });
    const outcome = await checker.maybeCheck();
    expect(outcome).toEqual({ kind: "unavailable" });
    const second = await checker.maybeCheck();
    expect(second).toEqual({ kind: "unavailable" });
    expect(transport.calls).toHaveLength(1);
  });
});
