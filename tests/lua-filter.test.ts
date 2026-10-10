/**
 * S5 验收：真实 Lua 滤镜 + 真实文件 IPC + 假 sidecar 脚本。
 *
 * 这里跑的是 `assets/lua/` 下要发布的那份滤镜：宿主端口被换成测试替身，文件读写、
 * 时钟和"拉起 sidecar"由 Node 接住；答案一侧用真实的 `src/ipc/file-ipc.ts` 写文件，
 * 所以两侧是两套独立实现对着同一份字节契约互相校验。逐条对应 #24 的验收标准：
 *
 *   1. 按需拉起、单实例、空闲自退、启动清残骸 —— 拉起落在本文件，单实例/空闲/清理
 *      落在 `tests/lifecycle.test.ts`（真实进程与真实类）；
 *   2. 请求身份与既有文件 IPC 契约 —— "按需拉起并发出符合契约的请求"；
 *   3. 奇偶槽位、消费即删、不匹配留空 —— "按 seq 奇偶落在 a/b 槽位" +
 *      "身份、模型或 seq 不匹配的响应一律留空"；
 *   4. 只插预测槽位、异常留空、不阻塞普通输入 —— 同名的几条；
 *   5. 变化后作废旧结果、通知只触发刷新 —— "输入变化后…"、"设置变化后…"、
 *      "完成通知本身不产生候选"、"只有用户选中模型候选才算采纳"；
 *   6. 覆盖方式 —— 全程真实文件 IPC + 真实 Lua，不用 UI 自动化。
 *
 * S6 追加：生成模式的开关与请求里的 mode，以及"模型只能在词库里挑词条"所依赖的
 * 候选窗口 —— 窗口只放一页时，一页之外的编号没有任何意义。
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { RequestEnvelope } from "../src/contracts/envelope.js";
import { decisionInputFromPayload } from "../src/domain/decision.js";
import { resolveGeneratedWord } from "../src/domain/generation.js";
import { expectOk, isOk } from "../src/domain/result.js";
import { DEFAULT_MODEL, DEFAULT_SETTINGS, toWire, type Settings } from "../src/domain/settings.js";
import { FileIpc } from "../src/ipc/file-ipc.js";
import type { JsonObject } from "../src/json/guards.js";
import {
  hostPorts,
  startHarness,
  type FixtureCandidate,
  type LuaHarness,
  type RenderedCandidate,
} from "./support/lua.js";

/** 一次 RIME 会话里的"ni"：四个普通候选，页面大小 5。 */
const INPUT = "ni";
const CANDIDATES: readonly FixtureCandidate[] = [
  { text: "你", preedit: "ni", start: 0, finish: 2 },
  { text: "尼", preedit: "ni", start: 0, finish: 2 },
  { text: "呢", preedit: "ni", start: 0, finish: 2 },
  { text: "泥", preedit: "ni", start: 0, finish: 2 },
];
/** 一页装不下的"ni"：六个候选，页面大小还是 5 —— 两种模式在这里分道。 */
const WIDE_CANDIDATES: readonly FixtureCandidate[] = [
  ...CANDIDATES,
  { text: "腻", preedit: "ni", start: 0, finish: 2 },
  { text: "匿", preedit: "ni", start: 0, finish: 2 },
];
const MODEL_IDENTITY = `ollama:${"a".repeat(64)}`;
const TASK = "中文输入法候选选择";

interface Fixture {
  readonly harness: LuaHarness;
  readonly ipc: FileIpc;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup !== undefined) await cleanup();
  }
});

function sha256hex(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function writeSettings(harness: LuaHarness, overrides: Partial<Settings>): void {
  const settings: Settings = { ...DEFAULT_SETTINGS, ...overrides };
  writeFileSync(harness.paths.settings, JSON.stringify(toWire(settings)), "utf8");
}

async function fixture(
  options: { pageSize?: number; launcher?: boolean; settings?: Partial<Settings> } = {},
): Promise<Fixture> {
  const workspace = mkdtempSync(join(tmpdir(), "rime-lua-filter-"));
  const harness = await startHarness({
    root: workspace,
    ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
    ...(options.launcher === undefined ? {} : { launcher: options.launcher }),
  });
  const ipc = new FileIpc({
    requests: harness.paths.requests,
    responses: harness.paths.responses,
    now: () => harness.now(),
  });
  writeSettings(harness, options.settings ?? { enabled: true });
  await harness.init();
  cleanups.push(async () => {
    await harness.dispose();
    rmSync(workspace, { recursive: true, force: true });
  });
  return { harness, ipc };
}

/** 像用户敲下 "ni" 那样走一遍：上文属性就位、候选就位、更新通知、跑滤镜。 */
async function typeText(
  harness: LuaHarness,
  text: string,
  candidates: readonly FixtureCandidate[],
): Promise<RenderedCandidate[]> {
  await harness.setContext({ status: "ok", text: "你好", revision: `rev-${text}` });
  await harness.setInput(text, candidates);
  await harness.update();
  return harness.run();
}

function textsOf(rendered: readonly RenderedCandidate[]): string[] {
  return rendered.map((candidate) => candidate.text);
}

function lastSlot(rendered: readonly RenderedCandidate[]): RenderedCandidate {
  const slot = rendered.at(-1);
  if (slot === undefined) throw new Error("滤镜没有产出候选");
  return slot;
}

function predictRequests(ipc: FileIpc): RequestEnvelope[] {
  return ipc.takeRequests().filter((request) => request.kind === "predict");
}

function solePredictRequest(ipc: FileIpc): RequestEnvelope {
  const requests = predictRequests(ipc);
  expect(requests).toHaveLength(1);
  const first = requests[0];
  if (first === undefined) throw new Error("没有 predict 请求");
  return first;
}

/** 所有 settings 事件（采纳上报与作废通知都走这条通道），按落盘顺序。 */
function settingsPayloads(ipc: FileIpc): JsonObject[] {
  return ipc
    .takeRequests()
    .filter((request) => request.kind === "settings")
    .map((request) => request.payload);
}

function okPayload(choice: number, extra: JsonObject = {}): JsonObject {
  return {
    status: "ok",
    eligible: true,
    choice: String(choice),
    requested_model: DEFAULT_MODEL,
    model_identity: MODEL_IDENTITY,
    ...extra,
  };
}

function publish(ipc: FileIpc, request: RequestEnvelope, payload: JsonObject, now?: number): void {
  expectOk(
    ipc.publishResponse(request, payload, now),
    (error) => `发布响应失败: ${String(error)}`,
  );
}

/** 就地改写一个已经写好的响应正文，可顺带同步 .ready 里的字节数与校验和。 */
function rewriteResponse(
  directory: string,
  slot: "a" | "b",
  mutate: (response: Record<string, unknown>) => void,
  options: { refreshMarker?: boolean } = {},
): void {
  const bodyPath = join(directory, `response-${slot}.json`);
  const response = JSON.parse(readFileSync(bodyPath, "utf8")) as Record<string, unknown>;
  mutate(response);
  const body = JSON.stringify(response);
  writeFileSync(bodyPath, body, "utf8");
  if (options.refreshMarker === false) return;
  const markerPath = join(directory, `response-${slot}.ready`);
  const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
  marker["bytes"] = Buffer.byteLength(body, "utf8");
  marker["sha256"] = sha256hex(body);
  writeFileSync(markerPath, JSON.stringify(marker), "utf8");
}

describe("Lua 滤镜与 sidecar 的文件 IPC 闭环", () => {
  it("未启用预测时原样放行候选，不发布请求也不拉起 sidecar", async () => {
    const { harness } = await fixture({ settings: { enabled: false } });
    const rendered = await typeText(harness, INPUT, CANDIDATES);
    expect(textsOf(rendered)).toEqual(["你", "尼", "呢", "泥"]);
    expect(readdirSync(harness.paths.requests)).toEqual([]);
    expect(harness.launchCount()).toBe(0);
  });

  it("按需拉起 sidecar，并发出符合既有文件 IPC 契约的请求", async () => {
    const { harness, ipc } = await fixture();
    const rendered = await typeText(harness, INPUT, CANDIDATES);
    // 还没有答案：预测槽位留空，普通候选一个不少也不移位。
    expect(textsOf(rendered)).toEqual(["你", "尼", "呢", "泥", ""]);
    expect(lastSlot(rendered).type).toBe("model_predict_reserved");
    expect(harness.launchCount()).toBe(1);

    const engineId = await harness.engineId();
    expect(engineId).toMatch(/^[0-9a-f]{40}$/);
    const names = readdirSync(harness.paths.requests);
    expect(names).toHaveLength(1);
    const name = names[0] ?? "";
    expect(name).toMatch(new RegExp(`^req-${engineId}-0{19}1-[0-9a-f]{32}\\.json$`));

    // 键序就是冻结的验收面：解析回来之前先看原始字节。
    const raw = readFileSync(join(harness.paths.requests, name), "utf8");
    expect(Object.keys(JSON.parse(raw) as object)).toEqual([
      "version",
      "contract_version",
      "engine_id",
      "seq",
      "request_id",
      "kind",
      "sent_at",
      "payload",
    ]);

    // takeRequests 用的就是发布侧那份解析器：能被它接受，等于契约双向成立。
    const request = solePredictRequest(ipc);
    expect(request).toMatchObject({
      version: 1,
      contractVersion: 1,
      engineId,
      seq: 1,
      kind: "predict",
      sentAt: harness.now(),
    });
    expect(name).toContain(request.requestId);

    const payload = request.payload as Record<string, unknown>;
    expect(payload["state"]).toEqual({ task: TASK, preceding_text: "你好", pinyin: "ni" });
    expect(payload["candidates"]).toEqual(["你", "尼", "呢", "泥"]);
    expect(payload["candidate_fields"]).toEqual([
      { preedit: "ni", start: 0, end: 2 },
      { preedit: "ni", start: 0, end: 2 },
      { preedit: "ni", start: 0, end: 2 },
      { preedit: "ni", start: 0, end: 2 },
    ]);
    expect(payload["settings_revision"]).toMatch(/^[0-9a-f]{64}$/);
    expect(payload["candidate_fingerprint"]).toMatch(/^[0-9a-f]{64}$/);
    // 还没见过任何模型身份：请求里如实写 null，不编造。
    expect(payload["model_identity"]).toBeNull();

    // fork 的完成通知门控只认这三个属性名，写错就永远收不到刷新。
    const properties = await harness.properties();
    expect(properties["model_predict_engine_id"]).toBe(engineId);
    expect(properties["model_predict_request_id"]).toBe(request.requestId);
    expect(properties["model_predict_request_seq"]).toBe("1");
    expect(properties["model_predict_reserved"]).toBe("1");
  });

  it("答案按 seq 奇偶落在 a/b 槽位，采纳后消费即删，刷新不换发请求", async () => {
    const { harness, ipc } = await fixture();
    const engineId = await harness.engineId();
    const directory = join(harness.paths.responses, engineId);

    await typeText(harness, INPUT, CANDIDATES);
    const first = solePredictRequest(ipc);
    expect(first.seq).toBe(1);
    publish(ipc, first, okPayload(2));
    expect(existsSync(join(directory, "response-a.json"))).toBe(true);

    // 完成通知只负责让前端立刻重组：候选由文件 IPC 提供，且不产生新请求。
    await harness.update();
    const adopted = await harness.run();
    expect(lastSlot(adopted)).toMatchObject({ type: "model_predict", text: "尼" });
    expect(predictRequests(ipc)).toEqual([]);
    expect(existsSync(join(directory, "response-a.json"))).toBe(false);
    expect(existsSync(join(directory, "response-a.ready"))).toBe(false);

    // 续输入：新请求走偶数 seq，答案落在 b 槽位。
    await harness.setContext({ text: "你好世界", revision: "rev-2" });
    await harness.setInput(INPUT, CANDIDATES);
    await harness.update();
    expect(lastSlot(await harness.run()).type).toBe("model_predict_reserved");
    const second = solePredictRequest(ipc);
    expect(second.seq).toBe(2);
    // 上一条答案里确认过的模型身份要带进后续请求：这一轮预测是"哪个模型"给的证据。
    expect((second.payload as Record<string, unknown>)["model_identity"]).toBe(MODEL_IDENTITY);
    publish(ipc, second, okPayload(1));
    expect(existsSync(join(directory, "response-b.json"))).toBe(true);
    expect(lastSlot(await harness.run())).toMatchObject({ type: "model_predict", text: "你" });
    expect(existsSync(join(directory, "response-b.json"))).toBe(false);
  });

  it("响应损坏、缺正文、校验和不符、版本未知或时间越界时静默留空", async () => {
    const { harness, ipc } = await fixture();
    const engineId = await harness.engineId();
    const directory = join(harness.paths.responses, engineId);
    const clear = (): void => {
      rmSync(directory, { recursive: true, force: true });
    };

    await typeText(harness, INPUT, CANDIDATES);
    const request = solePredictRequest(ipc);

    const expectBlank = async (label: string): Promise<void> => {
      const rendered = await harness.run();
      expect({ label, slot: lastSlot(rendered) }).toMatchObject({
        label,
        slot: { type: "model_predict_reserved", text: "" },
      });
    };

    clear();
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "response-a.ready"), "{not json", "utf8");
    writeFileSync(join(directory, "response-a.json"), "{}", "utf8");
    await expectBlank("标记文件不是 JSON");

    clear();
    publish(ipc, request, okPayload(2));
    unlinkSync(join(directory, "response-a.json"));
    await expectBlank("正文缺失");

    clear();
    publish(ipc, request, okPayload(2));
    rewriteResponse(directory, "a", (response) => {
      // 正文被换掉但 .ready 还是旧的：摘要与字节对不上，整条记录作废。
      (response["payload"] as Record<string, unknown>)["choice"] = "4";
    }, { refreshMarker: false });
    await expectBlank("校验和不符");

    clear();
    publish(ipc, request, okPayload(2));
    rewriteResponse(directory, "a", (response) => {
      response["version"] = 2;
    });
    await expectBlank("协议版本未知");

    clear();
    publish(ipc, request, okPayload(2));
    rewriteResponse(directory, "a", (response) => {
      response["contract_version"] = 2;
    });
    await expectBlank("契约版本未知");

    clear();
    publish(ipc, request, okPayload(2));
    rewriteResponse(directory, "a", (response) => {
      response["engine_id"] = "b".repeat(40);
    });
    await expectBlank("引擎标识不符");

    clear();
    publish(ipc, request, okPayload(2), harness.now() - 120);
    await expectBlank("响应已过期");

    clear();
    publish(ipc, request, okPayload(2), harness.now() + 5);
    await expectBlank("响应来自未来");

    // 一路坏文件之后，好答案照样能被采纳：损坏不污染状态。
    clear();
    publish(ipc, request, okPayload(3));
    expect(lastSlot(await harness.run())).toMatchObject({ type: "model_predict", text: "呢" });
  });

  it("身份、模型或 seq 不匹配的响应一律留空", async () => {
    const { harness, ipc } = await fixture();
    const engineId = await harness.engineId();
    const directory = join(harness.paths.responses, engineId);

    await typeText(harness, INPUT, CANDIDATES);
    const first = solePredictRequest(ipc);
    expect(first.seq).toBe(1);

    // 模型换了：答案只对当初问过的模型有效。
    publish(ipc, first, okPayload(2, { requested_model: "other/model" }));
    expect(lastSlot(await harness.run()).type).toBe("model_predict_reserved");
    expect(existsSync(join(directory, "response-a.json"))).toBe(false);
    // 这一轮只是把作废的答案吃掉；下一次编辑才会重新发问。
    expect(lastSlot(await harness.run()).type).toBe("model_predict_reserved");
    const retry = solePredictRequest(ipc);
    expect(retry.seq).toBe(2);

    // 上一轮的答案迟到：seq 更小，丢弃而不是显示。
    publish(ipc, first, okPayload(3));
    expect(lastSlot(await harness.run()).type).toBe("model_predict_reserved");
    expect(existsSync(join(directory, "response-a.json"))).toBe(false);

    // 同一 seq 但 request_id 不是我们问的那次：不认，也不吃掉它。
    publish(ipc, retry, okPayload(4));
    rewriteResponse(directory, "b", (response) => {
      response["request_id"] = "f".repeat(32);
    });
    expect(lastSlot(await harness.run()).type).toBe("model_predict_reserved");
    expect(existsSync(join(directory, "response-b.json"))).toBe(true);
  });

  it("sidecar 报错时不显示候选，也不挡住下一轮预测", async () => {
    const { harness, ipc } = await fixture();
    const engineId = await harness.engineId();
    const directory = join(harness.paths.responses, engineId);

    await typeText(harness, INPUT, CANDIDATES);
    const first = solePredictRequest(ipc);
    // 本地推理失败（模型没拉起来、后端没就绪）走的正是这条形状。
    publish(ipc, first, { status: "unavailable", error_code: "backend_not_ready", eligible: false });
    expect(lastSlot(await harness.run()).type).toBe("model_predict_reserved");
    // 作废的响应被消费掉，不会一直躺在槽位里。
    expect(existsSync(join(directory, "response-a.json"))).toBe(false);

    // 下一轮照样拿得到正常答案。
    await harness.setContext({ revision: "rev-2" });
    await harness.setInput(INPUT, CANDIDATES);
    await harness.update();
    expect(lastSlot(await harness.run()).type).toBe("model_predict_reserved");
    const second = solePredictRequest(ipc);
    publish(ipc, second, okPayload(3));
    expect(lastSlot(await harness.run())).toMatchObject({ type: "model_predict", text: "呢" });
  });

  it("会话结束（输入清空）后旧答案不得显示，重新输入要重新发问", async () => {
    const { harness, ipc } = await fixture();
    const engineId = await harness.engineId();
    const directory = join(harness.paths.responses, engineId);

    await typeText(harness, INPUT, CANDIDATES);
    const first = solePredictRequest(ipc);
    publish(ipc, first, okPayload(2));

    // 会话结束：输入清空，librime 发一次 update 通知。
    await harness.setInput("", []);
    await harness.update();
    expect(await harness.run()).toEqual([]);
    expect(settingsPayloads(ipc).map((payload) => payload["action"])).toContain("cancel_prediction");

    // 重新开始打字：旧 seq 已经作废，新请求从 seq 2 起，旧答案会被丢弃。
    const rendered = await typeText(harness, INPUT, CANDIDATES);
    expect(lastSlot(rendered).type).toBe("model_predict_reserved");
    expect(solePredictRequest(ipc).seq).toBe(2);

    // 再跑一轮才会去读槽位：旧 seq 的答案被消费丢弃，槽位保持留空。
    expect(lastSlot(await harness.run()).type).toBe("model_predict_reserved");
    expect(existsSync(join(directory, "response-a.json"))).toBe(false);
  });

  it("输入变化后旧结果不得显示", async () => {
    const { harness, ipc } = await fixture();
    await typeText(harness, INPUT, CANDIDATES);
    const first = solePredictRequest(ipc);
    publish(ipc, first, okPayload(2));
    await harness.update();
    expect(lastSlot(await harness.run()).type).toBe("model_predict");

    const longer: readonly FixtureCandidate[] = [
      { text: "你好", preedit: "nihao", start: 0, finish: 5 },
      { text: "妮好", preedit: "nihao", start: 0, finish: 5 },
    ];
    const rendered = await typeText(harness, "nihao", longer);
    expect(rendered.filter((candidate) => candidate.type === "model_predict")).toEqual([]);
    expect(lastSlot(rendered).type).toBe("model_predict_reserved");
    const next = solePredictRequest(ipc);
    expect(next.seq).toBe(2);
    expect((next.payload as Record<string, unknown>)["state"]).toMatchObject({ pinyin: "nihao" });
  });

  it("设置变化后旧结果作废，并按新的槽位插入新结果", async () => {
    const { harness, ipc } = await fixture();
    await typeText(harness, INPUT, CANDIDATES);
    const first = solePredictRequest(ipc);
    publish(ipc, first, okPayload(2));
    await harness.update();
    expect(lastSlot(await harness.run()).type).toBe("model_predict");

    writeSettings(harness, { enabled: true, slot: 3 });
    const changed = await harness.run();
    expect(changed.map((candidate) => candidate.text)).toEqual(["你", "尼", "", "呢", "泥"]);
    expect(changed.filter((candidate) => candidate.type === "model_predict")).toEqual([]);

    const next = solePredictRequest(ipc);
    expect(next.seq).toBe(2);
    const before = (first.payload as Record<string, unknown>)["settings_revision"];
    expect((next.payload as Record<string, unknown>)["settings_revision"]).not.toBe(before);

    publish(ipc, next, okPayload(4));
    const adopted = await harness.run();
    expect(adopted).toHaveLength(5);
    expect(adopted[2]).toMatchObject({ type: "model_predict", text: "泥" });
  });

  it("完成通知本身不产生候选，超时后重新发问", async () => {
    const { harness, ipc } = await fixture();
    await typeText(harness, INPUT, CANDIDATES);
    const first = solePredictRequest(ipc);
    expect(first.seq).toBe(1);

    await harness.update();
    expect(lastSlot(await harness.run()).type).toBe("model_predict_reserved");
    expect(predictRequests(ipc)).toEqual([]);

    harness.advanceClock(61);
    expect(lastSlot(await harness.run()).type).toBe("model_predict_reserved");
    expect(solePredictRequest(ipc).seq).toBe(2);
    // 上一轮已经过了拉起节流窗口，可以再问一次启动器。
    expect(harness.launchCount()).toBe(2);
  });

  it("只有用户选中模型候选才算采纳", async () => {
    const { harness, ipc } = await fixture();
    await typeText(harness, INPUT, CANDIDATES);
    const first = solePredictRequest(ipc);

    // 还没等到答案就选了第一个普通候选：不算采纳；按既有契约，这次待定请求
    // 随即被作废（selection 在前，cancel_prediction 在后）。
    await harness.commit(1);
    const aborted = settingsPayloads(ipc);
    expect(aborted.map((payload) => payload["action"])).toEqual(["selection", "cancel_prediction"]);
    expect(aborted[0]).toMatchObject({
      action: "selection",
      prediction_seq: first.seq,
      adopted: false,
    });
    expect(aborted[1]).toMatchObject({
      action: "cancel_prediction",
      seq: first.seq,
      request_id: first.requestId,
    });

    // 继续打字：作废之后重新发问，seq 递增；答案到了才轮到"采纳"这件事。
    await harness.update();
    expect(lastSlot(await harness.run()).type).toBe("model_predict_reserved");
    const again = solePredictRequest(ipc);
    expect(again.seq).toBe(2);
    publish(ipc, again, okPayload(2));
    await harness.update();
    expect(lastSlot(await harness.run())).toMatchObject({ type: "model_predict", text: "尼" });
    await harness.commit(5);
    const adopted = settingsPayloads(ipc);
    // 答案已经被消费，这次没有待定请求可作废，所以只有一条上报。
    expect(adopted.map((payload) => payload["action"])).toEqual(["selection"]);
    expect(adopted[0]).toMatchObject({
      action: "selection",
      engine_id: await harness.engineId(),
      prediction_request_id: again.requestId,
      prediction_seq: again.seq,
      adopted: true,
    });
  });

  it("没有启动器时静默不预测，普通输入照常", async () => {
    const { harness, ipc } = await fixture({ launcher: false });
    const rendered = await typeText(harness, INPUT, CANDIDATES);
    expect(textsOf(rendered)).toEqual(["你", "尼", "呢", "泥", ""]);
    expect(harness.launchCount()).toBe(0);
    // 请求照发（sidecar 不在时没人答，超时后被清掉），普通输入不等它。
    expect(predictRequests(ipc)).toHaveLength(1);
  });

  it("生成模式开启时把词库摊到一页之外，回来的词条按显示编号插入", async () => {
    const { harness, ipc } = await fixture({
      settings: { enabled: true, generationEnabled: true },
    });
    const rendered = await typeText(harness, INPUT, WIDE_CANDIDATES);
    expect(textsOf(rendered)).toEqual(["你", "尼", "呢", "泥", "", "腻", "匿"]);

    const request = solePredictRequest(ipc);
    const payload = request.payload as Record<string, unknown>;
    expect(payload["mode"]).toBe("generation");
    expect(payload["candidates"]).toEqual(["你", "尼", "呢", "泥", "腻", "匿"]);
    expect(payload["candidate_fields"]).toHaveLength(6);

    // 滤镜写出去的载荷必须原样被运行时接受，且第 6 个词条要能通过词库校验。
    const decision = decisionInputFromPayload(payload);
    if (!isOk(decision) || decision.value.mode !== "generation") {
      throw new Error("运行时没有接受生成模式的载荷");
    }
    expect(resolveGeneratedWord("匿", decision.value)).toEqual({ ok: true, value: 6 });

    publish(ipc, request, okPayload(6));
    const adopted = await harness.run();
    expect(adopted).toHaveLength(7);
    expect(adopted[4]).toMatchObject({ type: "model_predict", text: "匿" });
  });

  it("生成模式默认关闭：请求写 selection，一页之外的编号不被认", async () => {
    const { harness, ipc } = await fixture({ settings: { enabled: true } });
    await typeText(harness, INPUT, WIDE_CANDIDATES);
    const request = solePredictRequest(ipc);
    const payload = request.payload as Record<string, unknown>;
    expect(payload["mode"]).toBe("selection");
    expect(payload["candidates"]).toEqual(["你", "尼", "呢", "泥", "腻"]);

    // 模型报了一个只在词库里有、当前这一页没有的编号：不是显示编号，槽位留空。
    publish(ipc, request, okPayload(6));
    const rendered = await harness.run();
    expect(rendered.filter((candidate) => candidate.type === "model_predict")).toEqual([]);
    expect(rendered[4]).toMatchObject({ type: "model_predict_reserved", text: "" });
  });

  it("开关切换算设置变化：旧答案作废，模式、窗口与指纹一起换", async () => {
    const { harness, ipc } = await fixture({ settings: { enabled: true } });
    await typeText(harness, INPUT, WIDE_CANDIDATES);
    const first = solePredictRequest(ipc);
    publish(ipc, first, okPayload(2));
    expect((await harness.run()).some((candidate) => candidate.type === "model_predict")).toBe(
      true,
    );

    writeSettings(harness, { enabled: true, generationEnabled: true });
    const after = await harness.run();
    expect(after.filter((candidate) => candidate.type === "model_predict")).toEqual([]);
    expect(after[4]).toMatchObject({ type: "model_predict_reserved" });

    const next = solePredictRequest(ipc);
    expect(next.seq).toBe(2);
    const payload = next.payload as Record<string, unknown>;
    expect(payload["mode"]).toBe("generation");
    expect(payload["candidates"]).toHaveLength(6);
    // 同一段输入、同一份候选，换模式就是另一个问题：指纹不能复用。
    expect(payload["candidate_fingerprint"]).not.toBe(
      (first.payload as Record<string, unknown>)["candidate_fingerprint"],
    );
  });

  it("发布用的 host 与测试替身的端口集合完全一致", async () => {
    const { real, stub } = await hostPorts();
    expect(stub).toEqual(real);
    expect(real).toEqual([
      "exists",
      "getenv",
      "module_directory",
      "random_hex",
      "read_file",
      "remove",
      "rename",
      "start_sidecar",
      "time",
      "write_file",
    ]);
  });
});
