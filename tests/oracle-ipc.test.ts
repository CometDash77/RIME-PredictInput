/**
 * 文件 IPC 的端到端行为，按旧实现的脚本顺序重放。
 *
 * 时间戳一律用小数：Python 把 1000.0 写成 "1000.0"，JS 写不出这个字面量，
 * 所以整数时间戳只能比较解析后的字段，小数时间戳才能逐字节比对。
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { CONTRACT_VERSION, PROTOCOL_VERSION, responseWire } from "../src/contracts/envelope.js";
import { engineId, sequence } from "../src/domain/ids.js";
import { expectOk } from "../src/domain/result.js";
import { FileIpc } from "../src/ipc/file-ipc.js";
import { isJsonObject, type JsonObject } from "../src/json/guards.js";
import { oracle, basePayload } from "./support/oracle.js";

const workspace = mkdtempSync(join(tmpdir(), "rime-ipc-"));

const ENGINE_A = expectOk(engineId("a".repeat(40)), (error) => "bad engine id: " + error);
const ENGINE_B = expectOk(engineId("b".repeat(40)), (error) => "bad engine id: " + error);
const ENGINE_C = expectOk(engineId("c".repeat(40)), (error) => "bad engine id: " + error);

/** 快照里的候选页负载；这里只确认它确实是个 JSON 对象。 */
function jsonObject(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new Error("oracle fixture payload is not a JSON object");
  return value;
}

const validPayload = jsonObject(basePayload);

function prepare(directory: string): void {
  mkdirSync(directory, { recursive: true });
}

let minted = 0;

function newIpc(name: string, hex?: string, now?: () => number): { ipc: FileIpc; root: string } {
  const root = join(workspace, name);
  const ipc = new FileIpc({
    requests: join(root, "ipc", "requests"),
    responses: join(root, "ipc", "responses"),
    prepareDirectory: prepare,
    randomHex: (bytes: number) => hex ?? (minted++).toString(16).padStart(bytes * 2, "0"),
    ...(now === undefined ? {} : { now }),
  });
  return { ipc, root };
}

function relativeFiles(root: string, directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    found.push(join(entry.parentPath, entry.name).slice(root.length + 1).split(sep).join("\\"));
  }
  return found.sort();
}

function onlyFile(directory: string, suffix: string): string {
  const names = readdirSync(directory).filter((name) => name.endsWith(suffix));
  const first = names[0];
  if (first === undefined) throw new Error("no file ending in " + suffix + " under " + directory);
  return join(directory, first);
}

const requestIdSchema = z.object({ request_id: z.string() });
const responseSlotSchema = z.object({ seq: z.number() });

describe("请求文件", () => {
  it("写出的字段与键顺序与旧实现一致", () => {
    const recordedRaw: unknown = JSON.parse(Object.values(oracle.responses.request_files)[0] ?? "{}");
    const recorded = requestIdSchema.parse(recordedRaw);
    const { ipc, root } = newIpc("request", recorded.request_id);
    const published = expectOk(
      ipc.publishRequest({
        engineId: ENGINE_A,
        seq: expectOk(sequence(1), (error) => "bad seq: " + error),
        kind: "predict",
        payload: validPayload,
        now: 1000,
      }),
      (error) => "publish failed: " + error,
    );
    expect(published.version).toBe(PROTOCOL_VERSION);
    expect(published.contractVersion).toBe(CONTRACT_VERSION);
    expect(published.requestId).toBe(recorded.request_id);

    const file = onlyFile(join(root, "ipc", "requests"), ".json");
    const text = readFileSync(file, "utf8");
    const parsed: unknown = JSON.parse(text);
    expect(parsed).toEqual(oracle.responses.request_to_mapping);
    expect(Object.keys(z.record(z.string(), z.unknown()).parse(parsed))).toEqual(
      Object.keys(z.record(z.string(), z.unknown()).parse(recordedRaw)),
    );
    // 旧快照的 request_tree 里同时含目录，这里只比文件数。
    expect(relativeFiles(root, join(root, "ipc", "requests")).length).toBe(Object.keys(oracle.responses.request_files).length);
  });
});

describe("响应文件", () => {
  it("响应体与就绪标记与旧实现一致", () => {
    const recordedRequest = requestIdSchema.parse(JSON.parse(Object.values(oracle.responses.request_files)[0] ?? "{}"));
    const { ipc, root } = newIpc("response", recordedRequest.request_id);
    const request = expectOk(
      ipc.publishRequest({
        engineId: ENGINE_A,
        seq: expectOk(sequence(1), (error) => "bad seq: " + error),
        kind: "predict",
        payload: validPayload,
        now: 1000,
      }),
      (error) => "publish failed: " + error,
    );
    const published = expectOk(
      ipc.publishResponse(request, { status: "ok", backend: "local" }, 1001.25),
      (error) => "response failed: " + error,
    );
    expect(published).toBe(oracle.responses.publish_ok);

    const directory = join(root, "ipc", "responses", "a".repeat(40));
    expect(readFileSync(onlyFile(directory, ".json"), "utf8")).toBe(recordedFile(oracle.responses.response_files, "response-a.json"));
    expect(readFileSync(onlyFile(directory, ".ready"), "utf8")).toBe(recordedFile(oracle.responses.response_files, "response-a.ready"));
    expect(relativeFiles(root, join(root, "ipc", "responses")).length).toBe(Object.keys(oracle.responses.response_files).length);
  });

  it("读取最新响应并消费", () => {
    const recordedRequest = requestIdSchema.parse(JSON.parse(Object.values(oracle.responses.request_files)[0] ?? "{}"));
    const { ipc, root } = newIpc("consume", recordedRequest.request_id, () => 1001.25);
    const request = expectOk(
      ipc.publishRequest({
        engineId: ENGINE_A,
        seq: expectOk(sequence(1), (error) => "bad seq: " + error),
        kind: "predict",
        payload: validPayload,
        now: 1000,
      }),
      (error) => "publish failed: " + error,
    );
    expectOk(ipc.publishResponse(request, { status: "ok", backend: "local" }, 1001.25), (error) => "response failed: " + error);

    const latest = expectOk(ipc.readLatestResponse(ENGINE_A), (error) => "read failed: " + error);
    expect(latest).not.toBeNull();
    if (latest === null || latest.requestId === null || latest.createdAt === null) {
      throw new Error("response record is incomplete");
    }
    expect(latest.seq).toBe(responseSlotSchema.parse(oracle.responses.read_latest).seq);
    expect(latest.requestId).toBe(recordedRequest.request_id);
    expect(
      responseWire({
        engineId: latest.engineId,
        seq: latest.seq,
        requestId: latest.requestId,
        createdAt: latest.createdAt,
        payload: latest.payload,
      }),
    ).toEqual(oracle.responses.read_latest);

    expect(expectOk(ipc.consumeResponse(ENGINE_A, latest.requestId), (error) => "consume failed: " + error)).toBe(
      oracle.responses.consume_ok,
    );
    expect(expectOk(ipc.consumeResponse(ENGINE_A, "f".repeat(32)), (error) => "consume failed: " + error)).toBe(
      oracle.responses.consume_wrong_id_refused,
    );
    // 消费后两个槽位文件都被清掉，只剩目录（旧快照的 response_tree_after_consume 只剩目录项）。
    expect(relativeFiles(root, join(root, "ipc", "responses")).length).toBe(0);
    expect(expectOk(ipc.readLatestResponse(ENGINE_A), (error) => "read failed: " + error)).toBeNull();
  });

  it("只在槽位里存在更新响应时拒绝旧答案", () => {
    const { ipc, root } = newIpc("stale", undefined, () => 1003);
    const stale = expectOk(
      ipc.publishRequest({
        engineId: ENGINE_A,
        seq: expectOk(sequence(2), (error) => "bad seq: " + error),
        kind: "predict",
        payload: validPayload,
        now: 1002,
      }),
      (error) => "publish failed: " + error,
    );
    const newer = expectOk(
      ipc.publishRequest({
        engineId: ENGINE_A,
        seq: expectOk(sequence(3), (error) => "bad seq: " + error),
        kind: "predict",
        payload: validPayload,
        now: 1003,
      }),
      (error) => "publish failed: " + error,
    );
    expect(expectOk(ipc.publishResponse(stale, { status: "ok" }, 1004), (error) => "response failed: " + error)).toBe(
      oracle.responses.publish_stale_refused,
    );
    expect(expectOk(ipc.publishResponse(newer, { status: "ok" }, 1005), (error) => "response failed: " + error)).toBe(
      oracle.responses.publish_newest_ok,
    );

    const first = expectOk(
      ipc.publishRequest({
        engineId: ENGINE_B,
        seq: expectOk(sequence(2), (error) => "bad seq: " + error),
        kind: "predict",
        payload: validPayload,
        now: 1002,
      }),
      (error) => "publish failed: " + error,
    );
    expect(expectOk(ipc.publishResponse(first, { status: "ok" }, 1002.5), (error) => "response failed: " + error)).toBe(
      oracle.responses.publish_first_ok,
    );
    const older = expectOk(
      ipc.publishRequest({
        engineId: ENGINE_B,
        seq: expectOk(sequence(1), (error) => "bad seq: " + error),
        kind: "predict",
        payload: validPayload,
        now: 1001,
      }),
      (error) => "publish failed: " + error,
    );
    expect(expectOk(ipc.publishResponse(older, { status: "ok" }, 1003), (error) => "response failed: " + error)).toBe(
      oracle.responses.publish_older_refused,
    );
    const twin = expectOk(
      ipc.publishRequest({
        engineId: ENGINE_B,
        seq: expectOk(sequence(2), (error) => "bad seq: " + error),
        kind: "predict",
        payload: validPayload,
        now: 1002.25,
      }),
      (error) => "publish failed: " + error,
    );
    expect(expectOk(ipc.publishResponse(twin, { status: "ok" }, 1003.5), (error) => "response failed: " + error)).toBe(
      oracle.responses.publish_same_seq_other_id_refused,
    );
    const latest = expectOk(ipc.readLatestResponse(ENGINE_B), (error) => "read failed: " + error);
    expect(latest?.seq).toBe(oracle.responses.latest_seq_after_refusals);
    expect(relativeFiles(root, join(root, "ipc", "requests")).length).toBeGreaterThan(0);
  });

  it("小数时间戳的字节可以逐字节比对", () => {
    const recorded = requestIdSchema.parse(JSON.parse(oracle.responses.request_bytes_fractional));
    const { ipc, root } = newIpc("fractional", recorded.request_id, () => 1001.25);
    const request = expectOk(
      ipc.publishRequest({
        engineId: ENGINE_C,
        seq: expectOk(sequence(7), (error) => "bad seq: " + error),
        kind: "predict",
        payload: validPayload,
        now: 1000.25,
      }),
      (error) => "publish failed: " + error,
    );
    expect(readFileSync(onlyFile(join(root, "ipc", "requests"), ".json"), "utf8")).toBe(
      oracle.responses.request_bytes_fractional,
    );
    expect(expectOk(ipc.publishResponse(request, { status: "ok", backend: "local" }, 1001.25), (error) => "failed: " + error)).toBe(
      oracle.responses.publish_response_fractional_ok,
    );
    const directory = join(root, "ipc", "responses", "c".repeat(40));
    expect(readFileSync(onlyFile(directory, "response-a.json"), "utf8")).toBe(oracle.responses.response_bytes_fractional);
    expect(readFileSync(join(directory, "response-a.ready"), "utf8")).toBe(oracle.responses.ready_bytes_fractional);
    const latest = expectOk(ipc.readLatestResponse(ENGINE_C), (error) => "read failed: " + error);
    expect(latest).not.toBeNull();
    if (latest === null || latest.requestId === null || latest.createdAt === null) {
      throw new Error("response record is incomplete");
    }
    expect(
      responseWire({
        engineId: latest.engineId,
        seq: latest.seq,
        requestId: latest.requestId,
        createdAt: latest.createdAt,
        payload: latest.payload,
      }),
    ).toEqual(oracle.responses.read_latest_fractional);
  });
});

describe("contract_version 门控", () => {
  function rewriteWithoutContract(root: string): void {
    const directory = join(root, "ipc", "responses", "a".repeat(40));
    const bodyPath = join(directory, "response-a.json");
    const body = JSON.parse(readFileSync(bodyPath, "utf8")) as Record<string, unknown>;
    delete body["contract_version"];
    const text = JSON.stringify(body);
    const marker = JSON.parse(readFileSync(join(directory, "response-a.ready"), "utf8")) as Record<string, unknown>;
    marker["bytes"] = Buffer.byteLength(text);
    marker["sha256"] = createHash("sha256").update(text, "utf8").digest("hex");
    writeFileSync(bodyPath, text, "utf8");
    writeFileSync(join(directory, "response-a.ready"), JSON.stringify(marker), "utf8");
  }

  it("正文缺 contract_version 时读取返回 null", () => {
    const { ipc, root } = newIpc("cv-missing", undefined, () => 1001.5);
    const request = expectOk(
      ipc.publishRequest({
        engineId: ENGINE_A,
        seq: expectOk(sequence(1), (error) => "bad seq: " + error),
        kind: "predict",
        payload: validPayload,
        now: 1000,
      }),
      (error) => "publish failed: " + error,
    );
    expectOk(ipc.publishResponse(request, { status: "ok", backend: "local" }, 1001.25), (error) => "response failed: " + error);
    rewriteWithoutContract(root);
    // 时钟停在 1001.5：过期门控放行，null 只能来自 contract_version 校验。
    expect(expectOk(ipc.readLatestResponse(ENGINE_A), (error) => "read failed: " + error)).toBeNull();
  });

  it("响应超过 60 秒视为过期返回 null", () => {
    const { ipc } = newIpc("cv-expired", undefined, () => 1062.25);
    const request = expectOk(
      ipc.publishRequest({
        engineId: ENGINE_A,
        seq: expectOk(sequence(1), (error) => "bad seq: " + error),
        kind: "predict",
        payload: validPayload,
        now: 1000,
      }),
      (error) => "publish failed: " + error,
    );
    expectOk(ipc.publishResponse(request, { status: "ok", backend: "local" }, 1001.25), (error) => "response failed: " + error);
    // created_at 1001.25，时钟 1062.25：正文完好，仅超龄。
    expect(expectOk(ipc.readLatestResponse(ENGINE_A), (error) => "read failed: " + error)).toBeNull();
  });
});

function recordedFile(record: Record<string, string>, suffix: string): string {
  const found = Object.entries(record).find(([key]) => key.endsWith(suffix));
  if (found === undefined) throw new Error("oracle fixture is missing " + suffix);
  return found[1];
}
