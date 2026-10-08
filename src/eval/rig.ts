/**
 * 三次一致复跑 rig：同一冻结留出集上跑三遍，逐例判分，按冻结阈值出
 * 「达标 / 不达标」二值判定；三次结论一致才算成立，否则判无结论。
 *
 * 判分语义与既有基线一致（research/generation-quality-baseline.md）：
 *   hit      生成词与目标精确相等
 *   wrong    通过校验但与目标不等
 *   blank    输出未通过白名单校验（CJK / 长度 / 读音音节）→ 安全留空
 *   unsup    协议层拒绝（拼音不可整切或非纯小写字母），不发请求
 *   error    传输或响应形状失败（HTTP 失败、非 JSON、形状不符）
 * 门槛按 schema 分别计算（候选外命中率 / 命中率 / 留空率 / 错误率），
 * 两个 schema 全部满足才判达标。
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import { compact, type JsonValue } from "../json/canonical.js";
import { ChatResponseSchema } from "../contracts/ollama-wire.js";
import { SAMPLING_OPTIONS } from "../contracts/policy.js";
import { isPlainPinyin, isSegmentable, readingMatches, segmentations } from "./syllables.js";
import { buildLexicon, type Lexicon } from "./dicts.js";
import { checkFrozen } from "./build-holdout.js";

export type SampleCategory = "hit" | "wrong" | "blank" | "unsup" | "error";

export interface FrozenSample {
  readonly id: string;
  readonly kind: "generation" | "boundary";
  readonly dimension: string;
  readonly precedingText: string;
  readonly pinyin: string;
  readonly target?: string;
  readonly labels?: Readonly<Record<string, SampleSchemaLabels>>;
}

export interface SampleSchemaLabels {
  readonly inside_complete: boolean;
  readonly rank: number | null;
  readonly beyond_page: boolean;
  readonly outside_complete: boolean;
}

export interface FrozenBundle {
  readonly samples: readonly FrozenSample[];
  readonly manifest: JsonValue;
  readonly lexicons: Readonly<Record<string, Lexicon>>;
  readonly primaryReadings: ReadonlyMap<string, ReadonlySet<string>>;
}

export async function loadFrozen(holdoutDir: string, cacheDir: string): Promise<FrozenBundle> {
  const problems = await checkFrozen({ cacheDir, holdoutDir, reportPath: path.join(cacheDir, "build-report.json") });
  if (problems.length > 0) throw new Error("frozen assets drifted: " + problems.join("; "));

  const manifest = JSON.parse(await readFile(path.join(holdoutDir, "manifest.json"), "utf8")) as JsonValue;
  const raw = await readFile(path.join(holdoutDir, "samples.jsonl"), "utf8");
  const samples: FrozenSample[] = [];
  for (const line of raw.split("\n")) {
    if (line === "") continue;
    const value = JSON.parse(line) as Record<string, JsonValue>;
    const id = value["id"] as string;
    const kind = value["kind"] as "generation" | "boundary";
    const dimension = value["dimension"] as string;
    const precedingText = value["preceding_text"] as string;
    const pinyin = value["pinyin"] as string;
    const target = typeof value["target"] === "string" ? value["target"] : undefined;
    const labels = value["labels"] === undefined ? undefined : (value["labels"] as unknown as Record<string, SampleSchemaLabels>);
    samples.push({ id, kind, dimension, precedingText, pinyin, ...(target === undefined ? {} : { target }), ...(labels === undefined ? {} : { labels }) });
  }

  const schemaDefs = (manifest as { schemas: Record<string, { repo: string; files: Record<string, unknown> }> }).schemas;
  const lexicons: Record<string, Lexicon> = {};
  for (const [name, def] of Object.entries(schemaDefs)) {
    const short = def.repo.split("/")[1] as string;
    const contents: { name: string; content: string }[] = [];
    for (const file of Object.keys(def.files)) {
      contents.push({ name: file, content: (await readFile(path.join(cacheDir, "dicts", short, file), "utf8")) });
    }
    lexicons[name] = buildLexicon(contents);
  }
  const primaryName = Object.keys(lexicons)[0];
  const primary = lexicons[primaryName as string] as Lexicon;
  return { samples, manifest, lexicons, primaryReadings: primary.charReadings };
}

// ---- 传输 ----

export interface TransportResult {
  readonly kind: "ok";
  readonly content: string;
  readonly latencyMs: number;
}

export interface TransportFailure {
  readonly kind: "failure";
  readonly code: string;
  readonly latencyMs: number;
}

export type TransportOutcome = TransportResult | TransportFailure;

export interface Transport {
  call(sample: FrozenSample, arm: ArmConfig): Promise<TransportOutcome>;
  close(): Promise<void>;
}

export interface ArmConfig {
  readonly model: string;
  readonly response_kind: "raw" | "json-text-field";
  readonly system: string;
  readonly user_template: string;
  readonly options?: Partial<typeof SAMPLING_OPTIONS>;
  readonly transport:
    | { readonly kind: "http"; readonly endpoint: string }
    | { readonly kind: "fixture"; readonly file: string };
}

const USER_DEFAULT_TEMPLATE = "上文：{context}\n待转换拼音：{pinyin}\n合法音节切分：{segments}\n只输出该拼音对应的词语。";

export function renderUserContent(sample: FrozenSample, arm: ArmConfig): string {
  const template = arm.user_template ?? USER_DEFAULT_TEMPLATE;
  const segs = segmentations(sample.pinyin)
    .map((s) => s.join("'"))
    .join(" / ");
  return template
    .replaceAll("{context}", sample.precedingText)
    .replaceAll("{pinyin}", sample.pinyin)
    .replaceAll("{segments}", segs);
}

/** 本地兼容（Ollama /api/chat）HTTP 传输；#13 的真实模型实验走这里。 */
export class HttpTransport implements Transport {
  async call(sample: FrozenSample, arm: ArmConfig): Promise<TransportOutcome> {
    const started = Date.now();
    const body = {
      model: arm.model,
      messages: [
        { role: "system", content: arm.system },
        { role: "user", content: renderUserContent(sample, arm) },
      ],
      stream: false,
      options: { ...SAMPLING_OPTIONS, ...(arm.options ?? {}) },
    };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120_000);
      if (arm.transport.kind !== "http") return { kind: "failure", code: "transport_misconfigured", latencyMs: Date.now() - started };
      let response: Response;
      try {
        response = await fetch(new URL("/api/chat", arm.transport.endpoint), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const latency = Date.now() - started;
      if (!response.ok) return { kind: "failure", code: "http_" + response.status, latencyMs: latency };
      const parsed = ChatResponseSchema.safeParse(await response.json());
      if (!parsed.success) return { kind: "failure", code: "invalid_response", latencyMs: latency };
      return { kind: "ok", content: parsed.data.message.content, latencyMs: latency };
    } catch (error) {
      const code = error instanceof Error && error.name === "AbortError" ? "timeout" : "transport_error";
      return { kind: "failure", code, latencyMs: Date.now() - started };
    }
  }

  async close(): Promise<void> {}
}

/** 确定性 fixture 传输：id → 固定响应，用于 rig 自证与回归。 */
export class FixtureTransport implements Transport {
  private readonly table: Readonly<Record<string, JsonValue>>;

  constructor(table: Readonly<Record<string, JsonValue>>) {
    this.table = table;
  }

  static async load(file: string): Promise<FixtureTransport> {
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, JsonValue>;
    return new FixtureTransport(raw);
  }

  async call(sample: FrozenSample, _arm: ArmConfig): Promise<TransportOutcome> {
    const started = Date.now();
    const entry = this.table[sample.id];
    if (entry === undefined || entry === null) return { kind: "failure", code: "fixture_missing", latencyMs: 0 };
    if (typeof entry === "object" && !Array.isArray(entry)) {
      const record = entry as Record<string, JsonValue>;
      if (typeof record["error"] === "string") {
        return { kind: "failure", code: record["error"] as string, latencyMs: Date.now() - started };
      }
      if (record["invalid"] === true) {
        return { kind: "failure", code: "invalid_response", latencyMs: Date.now() - started };
      }
    }
    return { kind: "ok", content: String(entry), latencyMs: Date.now() - started };
  }

  async close(): Promise<void> {}
}

export async function openTransport(arm: ArmConfig): Promise<Transport> {
  if (arm.transport.kind === "fixture") return FixtureTransport.load(arm.transport.file);
  return new HttpTransport();
}

// ---- 判分 ----

const CJK = /^[\u4e00-\u9fff]+$/;
const MAX_OUTPUT_SCALARS = 12;

export interface SampleOutcome {
  readonly id: string;
  readonly category: SampleCategory;
  readonly output: string;
  readonly latencyMs: number;
  readonly failureCode?: string;
}

export function extractOutput(content: string, arm: ArmConfig): string | null {
  if (arm.response_kind === "raw") return content;
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    const text = value["text"];
    return typeof text === "string" ? text : null;
  } catch {
    return null;
  }
}

export function scoreSample(sample: FrozenSample, outcome: TransportOutcome, arm: ArmConfig, readings: ReadonlyMap<string, ReadonlySet<string>>): SampleOutcome {
  if (sample.kind === "boundary" || !isPlainPinyin(sample.pinyin) || !isSegmentable(sample.pinyin)) {
    return { id: sample.id, category: "unsup", output: "", latencyMs: 0 };
  }
  if (outcome.kind === "failure") {
    return { id: sample.id, category: "error", output: "", latencyMs: outcome.latencyMs, failureCode: outcome.code };
  }
  const text = extractOutput(outcome.content, arm);
  if (text === null) {
    return { id: sample.id, category: "error", output: "", latencyMs: outcome.latencyMs, failureCode: "invalid_response" };
  }
  const trimmed = text.trim();
  if (trimmed === "" || !CJK.test(trimmed) || [...trimmed].length > MAX_OUTPUT_SCALARS || !readingMatches(trimmed, sample.pinyin, readings)) {
    return { id: sample.id, category: "blank", output: "", latencyMs: outcome.latencyMs };
  }
  return {
    id: sample.id,
    category: trimmed === sample.target ? "hit" : "wrong",
    output: trimmed,
    latencyMs: outcome.latencyMs,
  };
}

export interface SchemaMetrics {
  readonly outsideTotal: number;
  readonly outsideHits: number;
  readonly hits: number;
  readonly blanks: number;
  readonly errors: number;
}

export interface RunMetrics {
  readonly perSchema: Readonly<Record<string, SchemaMetrics>>;
  readonly total: number;
  readonly hits: number;
  readonly blanks: number;
  readonly errors: number;
  readonly coldLatencyMs: number;
  readonly warmP50Ms: number;
  readonly warmP90Ms: number;
  readonly categories: Readonly<Record<string, SampleCategory>>;
}

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index] as number;
}

export async function evaluateOnce(bundle: FrozenBundle, arm: ArmConfig, schemaNames: readonly string[], transport: Transport): Promise<RunMetrics> {
  const categories: Record<string, SampleCategory> = {};
  const outcomes: SampleOutcome[] = [];
  let firstLatency: number | null = null;
  const warm: number[] = [];
  for (const sample of bundle.samples) {
    let outcome: SampleOutcome;
    if (sample.kind === "boundary" || !isPlainPinyin(sample.pinyin) || !isSegmentable(sample.pinyin)) {
      outcome = { id: sample.id, category: "unsup", output: "", latencyMs: 0 };
    } else {
      const raw = await transport.call(sample, arm);
      outcome = scoreSample(sample, raw, arm, bundle.primaryReadings);
    }
    if (outcome.category !== "unsup") {
      if (firstLatency === null) firstLatency = outcome.latencyMs;
      else warm.push(outcome.latencyMs);
    }
    categories[sample.id] = outcome.category;
    outcomes.push(outcome);
  }
  const perSchema: Record<string, SchemaMetrics> = {};
  for (const name of schemaNames) {
    let outsideTotal = 0;
    let outsideHits = 0;
    for (const sample of bundle.samples) {
      const labels = sample.labels?.[name];
      if (labels?.outside_complete === true) {
        outsideTotal += 1;
        if (categories[sample.id] === "hit") outsideHits += 1;
      }
    }
    perSchema[name] = {
      outsideTotal,
      outsideHits,
      hits: outcomes.filter((o) => o.category === "hit").length,
      blanks: outcomes.filter((o) => o.category === "blank" || o.category === "unsup").length,
      errors: outcomes.filter((o) => o.category === "error").length,
    };
  }
  const sortedWarm = [...warm].sort((a, b) => a - b);
  return {
    perSchema,
    total: outcomes.length,
    hits: outcomes.filter((o) => o.category === "hit").length,
    blanks: outcomes.filter((o) => o.category === "blank" || o.category === "unsup").length,
    errors: outcomes.filter((o) => o.category === "error").length,
    coldLatencyMs: firstLatency ?? 0,
    warmP50Ms: percentile(sortedWarm, 0.5),
    warmP90Ms: percentile(sortedWarm, 0.9),
    categories,
  };
}

// ---- 阈值与三次一致 ----

export interface ThresholdConfig {
  readonly frozen: boolean;
  readonly min_outside_hit_rate: number;
  readonly min_hit_rate: number;
  readonly max_blank_rate: number;
  readonly max_error_rate: number;
}

export type Verdict = "pass" | "fail" | "inconclusive";

export function judgeVerdict(metrics: RunMetrics, threshold: ThresholdConfig): Verdict {
  for (const schemaMetrics of Object.values(metrics.perSchema)) {
    const outsideRate = schemaMetrics.outsideTotal === 0 ? 0 : schemaMetrics.outsideHits / schemaMetrics.outsideTotal;
    const hitRate = schemaMetrics.hits / metrics.total;
    const blankRate = schemaMetrics.blanks / metrics.total;
    const errorRate = schemaMetrics.errors / metrics.total;
    if (outsideRate < threshold.min_outside_hit_rate) return "fail";
    if (hitRate < threshold.min_hit_rate) return "fail";
    if (blankRate > threshold.max_blank_rate) return "fail";
    if (errorRate > threshold.max_error_rate) return "fail";
  }
  return "pass";
}

export interface RigReport {
  readonly arm: JsonValue;
  readonly threshold: ThresholdConfig;
  readonly runs: { readonly verdict: Verdict; readonly metrics: RunMetrics }[];
  readonly verdicts_consistent: boolean;
  readonly final_verdict: Verdict;
  readonly threshold_frozen: boolean;
  readonly stable_example_fraction: number;
}

export async function runRig(bundle: FrozenBundle, arm: ArmConfig, threshold: ThresholdConfig, runs: number, reportPath: string | null): Promise<RigReport> {
  const schemaNames = Object.keys(bundle.lexicons);
  const transport = await openTransport(arm);
  const runResults: { verdict: Verdict; metrics: RunMetrics }[] = [];
  try {
    for (let i = 0; i < runs; i++) {
      const metrics = await evaluateOnce(bundle, arm, schemaNames, transport);
      runResults.push({ verdict: judgeVerdict(metrics, threshold), metrics });
    }
  } finally {
    await transport.close();
  }
  const verdicts = runResults.map((r) => r.verdict);
  const consistent = verdicts.every((v) => v === verdicts[0]);
  const finalVerdict: Verdict = consistent ? (verdicts[0] as Verdict) : "inconclusive";
  const first = runResults[0]?.metrics.categories ?? {};
  let stable = 0;
  for (const [id, category] of Object.entries(first)) {
    if (runResults.every((r) => r.metrics.categories[id] === category)) stable += 1;
  }
  const report: RigReport = {
    arm: {
      model: arm.model,
      response_kind: arm.response_kind,
      transport: arm.transport,
      options: arm.options ?? null,
    } as JsonValue,
    threshold,
    runs: runResults,
    verdicts_consistent: consistent,
    final_verdict: finalVerdict,
    threshold_frozen: threshold.frozen,
    stable_example_fraction: runResults.length === 0 ? 0 : stable / Object.keys(first).length,
  };
  if (reportPath !== null) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  }
  return report;
}

/** 供 CLI 摘要输出使用。 */
export function summarize(report: RigReport): string {
  const lines: string[] = [];
  lines.push("final_verdict=" + report.final_verdict + (report.threshold_frozen ? "" : " (threshold NOT frozen — draft run)"));
  lines.push("verdicts=" + report.runs.map((r) => r.verdict).join(",") + " consistent=" + String(report.verdicts_consistent));
  lines.push("stable_example_fraction=" + report.stable_example_fraction.toFixed(3));
  for (const run of report.runs) {
    const parts = Object.entries(run.metrics.perSchema).map(([name, m]) => {
      const outsideRate = m.outsideTotal === 0 ? 0 : m.outsideHits / m.outsideTotal;
      return name + "{outside " + m.outsideHits + "/" + m.outsideTotal + "=" + outsideRate.toFixed(2) + ", hit " + m.hits + "/" + run.metrics.total + ", blank " + m.blanks + ", err " + m.errors + "}";
    });
    lines.push("run " + parts.join(" ") + " cold=" + run.metrics.coldLatencyMs + "ms p50=" + run.metrics.warmP50Ms + "ms p90=" + run.metrics.warmP90Ms + "ms");
  }
  return lines.join("\n");
}

/** 序列化摘要哈希：同一 run 三次判分类别向量是否一致（诊断用，不作为门槛）。 */
export function categoryFingerprint(metrics: RunMetrics): string {
  return createHash("sha256").update(compact(Object.entries(metrics.categories).map(([id, c]) => id + "=" + c) as JsonValue)).digest("hex").slice(0, 16);
}
