/**
 * 更新检查（spec #10）：匿名 GET GitHub releases API，比较最新 stable。
 *
 * 四条硬约束在这里一次写清：
 * - 无用户数据出站：GET、无 body、仅一个静态产品 UA，不跟随重定向
 *   （FetchTransport 的 redirect:manual 先例）。
 * - 失败静默：传输错误、非 200、坏 JSON、没有 stable 可比，一律折叠成
 *   `unavailable`，绝不向上抛出、绝不回显服务端文本。
 * - 比较只认 stable：draft/prerelease 标记与非 semver tag 不参与比较。
 * - 只查不装：产出只有 tag 与跳转链接，下载与安装永远是用户动作。
 */
import { z } from "zod";

import type { HttpTransportLike, HttpResponse } from "./http.js";
import { decodeJsonBody } from "./http.js";
import type { Result } from "../domain/result.js";
import type { TransportFailureCode } from "../domain/error-codes.js";

/** 版本号与 package.json 同步维护；发布链落地时再改为单一来源。 */
// ponytail: hand-synced constant, wire to the release chain when it exists
export const SIDECAR_VERSION = "0.1.0";

export const RELEASES_API_URL = "https://api.github.com/repos/CometDash77/RIME-PredictInput/releases";

/** 会话内节流：同一进程里一个检查窗口内最多出站一次（缺省 1 小时）。 */
export const UPDATE_CHECK_MIN_INTERVAL_SECONDS = 3600;

/** 出站头只此一个：产品 UA 是 GitHub API 的硬要求，不含任何用户数据。 */
export const UPDATE_CHECK_USER_AGENT = `rime-model-predict/${SIDECAR_VERSION}`;

/** stable tag：v 前缀可选的三段数字；0.10.0 > 0.9.0 必须按数值比较。 */
const STABLE_TAG_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** 跳转链接只接受 github.com 页面，设置页将来直接把它渲染成入口。 */
const RELEASE_URL_PREFIX = "https://github.com/";

export interface StableRelease {
  readonly tag: string;
  readonly url: string;
}

export type UpdateCheckOutcome =
  | { readonly kind: "up-to-date" }
  | { readonly kind: "update-available"; readonly latest: StableRelease }
  | { readonly kind: "unavailable" };

const ReleaseEntrySchema = z.looseObject({
  tag_name: z.string(),
  html_url: z.string(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
});

const ReleasesPayloadSchema = z.array(ReleaseEntrySchema);

type Semver = readonly [number, number, number];

function semverOf(tag: string): Semver | null {
  const match = STABLE_TAG_PATTERN.exec(tag);
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(left: Semver, right: Semver): number {
  const [leftMajor, leftMinor, leftPatch] = left;
  const [rightMajor, rightMinor, rightPatch] = right;
  if (leftMajor !== rightMajor) return leftMajor < rightMajor ? -1 : 1;
  if (leftMinor !== rightMinor) return leftMinor < rightMinor ? -1 : 1;
  if (leftPatch !== rightPatch) return leftPatch < rightPatch ? -1 : 1;
  return 0;
}

/** releases 载荷里挑出最高 stable；draft/prerelease/坏 tag/外站链接一律跳过。 */
export function latestStable(payload: unknown): StableRelease | null {
  const parsed = ReleasesPayloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  let best: StableRelease | null = null;
  let bestSemver: Semver | null = null;
  for (const entry of parsed.data) {
    if (entry.draft === true || entry.prerelease === true) continue;
    if (!entry.html_url.startsWith(RELEASE_URL_PREFIX)) continue;
    const semver = semverOf(entry.tag_name);
    if (semver === null) continue;
    if (bestSemver === null || compareSemver(bestSemver, semver) < 0) {
      best = { tag: entry.tag_name, url: entry.html_url };
      bestSemver = semver;
    }
  }
  return best;
}

/** 纯比较：当前版本对最高 stable；没有 stable 可比就是「无信息」而非「最新」。 */
export function updateCheckOutcome(currentVersion: string, payload: unknown): UpdateCheckOutcome {
  const latest = latestStable(payload);
  if (latest === null) return { kind: "unavailable" };
  const current = semverOf(currentVersion);
  const candidate = semverOf(latest.tag);
  if (current === null || candidate === null) return { kind: "up-to-date" };
  return compareSemver(candidate, current) > 0 ? { kind: "update-available", latest } : { kind: "up-to-date" };
}

export interface UpdateCheckerOptions {
  readonly transport: HttpTransportLike;
  /** 单调秒（monotonicSeconds 先例）；测试注入假时钟。 */
  readonly now: () => number;
  readonly currentVersion: string;
}

/** 触发方决定何时询问（设置页会话打开时）；本类只负责节流与静默。 */
export class UpdateChecker {
  readonly #transport: HttpTransportLike;
  readonly #now: () => number;
  readonly #currentVersion: string;
  #checkedAt: number | null = null;
  #cached: UpdateCheckOutcome | null = null;

  constructor(options: UpdateCheckerOptions) {
    this.#transport = options.transport;
    this.#now = options.now;
    this.#currentVersion = options.currentVersion;
  }

  async maybeCheck(): Promise<UpdateCheckOutcome> {
    const now = this.#now();
    if (
      this.#cached !== null &&
      this.#checkedAt !== null &&
      now - this.#checkedAt < UPDATE_CHECK_MIN_INTERVAL_SECONDS
    ) {
      return this.#cached;
    }
    const outcome = await this.#fetch();
    this.#checkedAt = now;
    this.#cached = outcome;
    return outcome;
  }

  async #fetch(): Promise<UpdateCheckOutcome> {
    let response: Result<HttpResponse, TransportFailureCode>;
    try {
      response = await this.#transport.request("GET", RELEASES_API_URL, {
        headers: { "user-agent": UPDATE_CHECK_USER_AGENT },
      });
    } catch {
      return { kind: "unavailable" };
    }
    if (!response.ok || response.value.status !== 200) return { kind: "unavailable" };
    const decoded = decodeJsonBody(response.value.body);
    if (!decoded.ok) return { kind: "unavailable" };
    return updateCheckOutcome(this.#currentVersion, decoded.value);
  }
}
