/**
 * 留出集构建器：把 src/eval/samples.ts 的作者数据用真实词库校验、打标签、
 * 择优入集，并冻结构建口径与样本哈希。
 *
 * 产出（eval/holdout/）：
 *   samples.jsonl  每行一个样本（canonical compact JSON），逐行 sha256 进 manifest
 *   manifest.json  schema 词库身份（repo/commit/文件 sha256）、配额与计数、样本哈希清单
 * 构建报告（eval/.cache/build-report.json）：落选个体与真实标签，供修池迭代。
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import { compact, type JsonValue } from "../json/canonical.js";
import { sha256Hex } from "../json/digest.js";
import { isPlainPinyin, isSegmentable, readingMatches } from "./syllables.js";
import { buildLexicon, labelTarget, type Lexicon, type SampleLabels } from "./dicts.js";
import {
  ALL_DRAFT_SAMPLES,
  BOUNDARY_SAMPLES,
  OUTSIDE_POOL,
  BEYOND_PAGE_POOL,
  type DraftSample,
} from "./samples.js";

const CJK = /^[一-鿿]+$/;
const MAX_TARGET_SCALARS = 12;
const PAGE_SIZE = 5;

const OUTSIDE_QUOTA = 36;
const BEYOND_PAGE_QUOTA = 24;
const MIN_TOTAL = 100;

const SCHEMAS: readonly { name: string; repo: string; files: readonly string[] }[] = [
  {
    name: "rime-ice",
    repo: "iDvel/rime-ice",
    files: ["8105.dict.yaml", "41448.dict.yaml", "base.dict.yaml", "ext.dict.yaml", "others.dict.yaml", "tencent.dict.yaml"],
  },
  {
    name: "rime-frost",
    repo: "gaboolic/rime-frost",
    files: ["8105.dict.yaml", "41448.dict.yaml", "GB18030-2022.dict.yaml", "base.dict.yaml", "corrections.dict.yaml", "ext.dict.yaml", "others.dict.yaml", "tencent.dict.yaml"],
  },
];

export interface BuildPaths {
  readonly cacheDir: string;
  readonly holdoutDir: string;
  readonly reportPath: string;
}

interface LoadedSchema {
  readonly name: string;
  readonly repo: string;
  readonly commit: string;
  readonly fileHashes: ReadonlyMap<string, { bytes: number; sha256: string }>;
  readonly lexicon: Lexicon;
}

async function loadSchema(def: { name: string; repo: string; files: readonly string[] }, cacheDir: string): Promise<LoadedSchema> {
  const short = def.repo.split("/")[1] as string;
  const provenancePath = path.join(cacheDir, "dicts", "provenance.json");
  const provenance = JSON.parse(await readFile(provenancePath, "utf8")) as {
    repos: Record<string, { commit?: string }>;
  };
  const commit = provenance.repos[def.repo]?.commit ?? "unknown";
  const fileHashes = new Map<string, { bytes: number; sha256: string }>();
  const contents: { name: string; content: string }[] = [];
  for (const file of def.files) {
    const full = path.join(cacheDir, "dicts", short, file);
    const raw = await readFile(full);
    fileHashes.set(file, { bytes: raw.byteLength, sha256: createHash("sha256").update(raw).digest("hex") });
    contents.push({ name: file, content: raw.toString("utf8") });
  }
  return { name: def.name, repo: def.repo, commit, fileHashes, lexicon: buildLexicon(contents) };
}

interface PoolVerdict {
  readonly pass: boolean;
  readonly detail: Record<string, JsonValue>;
}

/** 对每个 schema 独立打标签并判定；detail 按 schema 名记录真实标签。 */
function judgePool(schemas: readonly LoadedSchema[], sample: DraftSample, pass: (labels: SampleLabels) => boolean): PoolVerdict {
  const detail: Record<string, JsonValue> = {};
  let ok = true;
  for (const schema of schemas) {
    const labels = labelTarget(schema.lexicon, sample.pinyin, sample.target as string);
    detail[schema.name] = {
      inside: labels.insideComplete,
      rank: labels.rank,
      outside: labels.outsideComplete,
    };
    if (!pass(labels)) ok = false;
  }
  return { pass: ok, detail };
}

export interface BuildResult {
  readonly sampleCount: number;
  readonly outsideCompletePerSchema: Record<string, number>;
  readonly beyondPagePerSchema: Record<string, number>;
  readonly rejected: { pool: string; id: string; target: string; detail: JsonValue }[];
}

export async function buildHoldout(paths: BuildPaths): Promise<BuildResult> {
  const schemas = await Promise.all(SCHEMAS.map((def) => loadSchema(def, paths.cacheDir)));
  const readings = schemas[0]?.lexicon.charReadings;
  if (readings === undefined) throw new Error("primary schema lexicon is empty");

  // ---- 结构校验（全部固定样本）----
  const structuralFailures: JsonValue[] = [];
  for (const sample of ALL_DRAFT_SAMPLES) {
    if (!isPlainPinyin(sample.pinyin) || !isSegmentable(sample.pinyin)) {
      structuralFailures.push({ id: sample.id, reason: "pinyin not segmentable" });
      continue;
    }
    const target = sample.target as string;
    if (target === undefined || !CJK.test(target) || [...target].length > MAX_TARGET_SCALARS) {
      structuralFailures.push({ id: sample.id, reason: "target missing, non-CJK, or too long" });
      continue;
    }
    if (sample.precedingText.includes(target)) {
      structuralFailures.push({ id: sample.id, reason: "target leaks in preceding text" });
      continue;
    }
    if (!readingMatches(target, sample.pinyin, readings)) {
      structuralFailures.push({ id: sample.id, target, reason: "target readings do not match pinyin" });
    }
    if (sample.dimension === "empty-context" && sample.precedingText !== "") {
      structuralFailures.push({ id: sample.id, reason: "empty-context sample has non-empty preceding" });
    }
  }
  if (structuralFailures.length > 0) {
    throw new Error("structural failures: " + compact(structuralFailures as JsonValue));
  }

  // ---- 边界样本：必须全部被协议层拒绝 ----
  for (const boundary of BOUNDARY_SAMPLES) {
    if (isPlainPinyin(boundary.pinyin) && isSegmentable(boundary.pinyin)) {
      throw new Error("boundary sample is wrongly acceptable: " + boundary.id);
    }
  }

  // ---- 池校验与择优（词库真实标签）----
  const rejected: { pool: string; id: string; target: string; detail: JsonValue }[] = [];
  const outsidePick: DraftSample[] = [];
  for (const sample of OUTSIDE_POOL) {
    if (outsidePick.length >= OUTSIDE_QUOTA) {
      rejected.push({ pool: "outside", id: sample.id, target: sample.target as string, detail: { reason: "quota filled" } });
      continue;
    }
    const verdict = judgePool(schemas, sample, (labels) => labels.outsideComplete);
    if (verdict.pass) outsidePick.push(sample);
    else rejected.push({ pool: "outside", id: sample.id, target: sample.target as string, detail: verdict.detail });
  }

  const beyondPick: DraftSample[] = [];
  for (const sample of BEYOND_PAGE_POOL) {
    if (beyondPick.length >= BEYOND_PAGE_QUOTA) {
      rejected.push({ pool: "beyond-page", id: sample.id, target: sample.target as string, detail: { reason: "quota filled" } });
      continue;
    }
    const verdict = judgePool(schemas, sample, (labels) => labels.insideComplete && labels.rank !== null && labels.rank > PAGE_SIZE);
    if (verdict.pass) beyondPick.push(sample);
    else rejected.push({ pool: "beyond-page", id: sample.id, target: sample.target as string, detail: verdict.detail });
  }

  const fixed = ALL_DRAFT_SAMPLES.filter(
    (s) => s.dimension !== "outside-complete" && s.dimension !== "beyond-page",
  );
  const boundarySamples: DraftSample[] = BOUNDARY_SAMPLES.map((b) => ({
    id: b.id,
    dimension: "boundary" as const,
    precedingText: "",
    pinyin: b.pinyin,
  }));
  const finalSamples: DraftSample[] = [...outsidePick, ...beyondPick, ...fixed, ...boundarySamples];

  // 报告先于配额判定落盘：配额不满足时正是靠它迭代修池。
  const reportDir = path.dirname(paths.reportPath);
  await mkdir(reportDir, { recursive: true });
  await writeFile(
    paths.reportPath,
    JSON.stringify(
      {
        built_at: new Date().toISOString(),
        quota: {
          outside: { picked: outsidePick.length, required: OUTSIDE_QUOTA },
          beyond_page: { picked: beyondPick.length, required: BEYOND_PAGE_QUOTA },
        },
        rejected,
        reserve_outside: OUTSIDE_POOL.map((s) => s.id).filter((id) => !outsidePick.some((s) => s.id === id)),
        reserve_beyond_page: BEYOND_PAGE_POOL.map((s) => s.id).filter((id) => !beyondPick.some((s) => s.id === id)),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  if (outsidePick.length < OUTSIDE_QUOTA) {
    throw new Error("outside quota unmet: " + outsidePick.length + "/" + OUTSIDE_QUOTA + " (see report)");
  }
  if (beyondPick.length < BEYOND_PAGE_QUOTA) {
    throw new Error("beyond-page quota unmet: " + beyondPick.length + "/" + BEYOND_PAGE_QUOTA + " (see report)");
  }
  if (finalSamples.length < MIN_TOTAL) throw new Error("holdout below " + MIN_TOTAL + ": " + finalSamples.length);

  // ---- 组装冻结产物 ----
  const lines: string[] = [];
  const hashes: { id: string; sha256: string }[] = [];
  const outsideCompletePerSchema: Record<string, number> = {};
  const beyondPagePerSchema: Record<string, number> = {};
  for (const schema of schemas) {
    outsideCompletePerSchema[schema.name] = 0;
    beyondPagePerSchema[schema.name] = 0;
  }
  for (const sample of finalSamples) {
    const isBoundary = sample.target === undefined;
    const line: Record<string, JsonValue> = {
      id: sample.id,
      kind: isBoundary ? "boundary" : "generation",
      dimension: sample.dimension,
      preceding_text: sample.precedingText,
      pinyin: sample.pinyin,
    };
    if (!isBoundary) {
      line["target"] = sample.target as string;
      if (sample.homophonePair !== undefined) line["homophone_pair"] = sample.homophonePair;
      const labels: Record<string, JsonValue> = {};
      for (const schema of schemas) {
        const l = labelTarget(schema.lexicon, sample.pinyin, sample.target as string);
        labels[schema.name] = {
          inside_complete: l.insideComplete,
          rank: l.rank,
          beyond_page: l.beyondPage,
          outside_complete: l.outsideComplete,
        };
        if (l.outsideComplete) outsideCompletePerSchema[schema.name] = (outsideCompletePerSchema[schema.name] ?? 0) + 1;
        if (l.beyondPage) beyondPagePerSchema[schema.name] = (beyondPagePerSchema[schema.name] ?? 0) + 1;
      }
      line["labels"] = labels;
    }
    const text = compact(line as JsonValue);
    lines.push(text);
    hashes.push({ id: sample.id, sha256: sha256Hex(text) });
  }

  const schemaManifest: Record<string, JsonValue> = {};
  for (const schema of schemas) {
    const files: Record<string, JsonValue> = {};
    for (const [name, hash] of schema.fileHashes) files[name] = hash;
    schemaManifest[schema.name] = { repo: schema.repo, commit: schema.commit, files };
  }

  const manifest = {
    version: 1,
    built_at: new Date().toISOString(),
    corpus_decision: "pure-synthetic (YG, 2026-10-08, issue #12 HITL gate)",
    cross_set_note:
      "全部样本为本票新撰合成文本，与旧 120 条开发集（作者仓库文档语料）无来源交集，同文档不跨集约束由构造满足。",
    candidate_set_definition:
      "concatenated code == pinyin 的去重词条，weight 降序、同权重文本码点升序；候选页大小 5。",
    target_context_rule: "目标不得出现在上文；构建器逐条断言。",
    schemas: schemaManifest,
    counts: {
      total: finalSamples.length,
      outside_complete_per_schema: outsideCompletePerSchema,
      beyond_page_per_schema: beyondPagePerSchema,
    },
    samples: hashes,
  };

  await mkdir(paths.holdoutDir, { recursive: true });
  await writeFile(path.join(paths.holdoutDir, "samples.jsonl"), lines.join("\n") + "\n", "utf8");
  await writeFile(path.join(paths.holdoutDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await mkdir(path.dirname(paths.reportPath), { recursive: true });
  await writeFile(
    path.join(reportDir, "build-report.json"),
    JSON.stringify(
      {
        built_at: manifest.built_at,
        counts: manifest.counts,
        rejected,
        reserve_outside: OUTSIDE_POOL.map((s) => s.id).filter((id) => !outsidePick.some((s) => s.id === id)),
        reserve_beyond_page: BEYOND_PAGE_POOL.map((s) => s.id).filter((id) => !beyondPick.some((s) => s.id === id)),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  return { sampleCount: finalSamples.length, outsideCompletePerSchema, beyondPagePerSchema, rejected };
}

/** 冻结校验：逐行重算 sha256 并与 manifest 比对；词库缓存与 manifest 比对。 */
export async function checkFrozen(paths: BuildPaths): Promise<string[]> {
  const problems: string[] = [];
  const manifest = JSON.parse(await readFile(path.join(paths.holdoutDir, "manifest.json"), "utf8")) as {
    schemas: Record<string, { repo: string; files: Record<string, { bytes: number; sha256: string }> }>;
    samples: { id: string; sha256: string }[];
  };
  const raw = await readFile(path.join(paths.holdoutDir, "samples.jsonl"), "utf8");
  const lines = raw.split("\n").filter((l) => l !== "");
  if (lines.length !== manifest.samples.length) problems.push("sample line count mismatch");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const recorded = manifest.samples[i];
    if (recorded === undefined) { problems.push("manifest missing line " + i); continue; }
    const id = (JSON.parse(line) as { id: string }).id;
    if (id !== recorded.id) problems.push("line order mismatch at " + i);
    if (sha256Hex(line) !== recorded.sha256) problems.push("hash mismatch: " + id);
  }
  for (const [name, schema] of Object.entries(manifest.schemas)) {
    const short = schema.repo.split("/")[1] as string;
    for (const [file, hash] of Object.entries(schema.files)) {
      try {
        const raw2 = await readFile(path.join(paths.cacheDir, "dicts", short, file));
        const sha = createHash("sha256").update(raw2).digest("hex");
        if (sha !== hash.sha256 || raw2.byteLength !== hash.bytes) problems.push("dict drift: " + name + "/" + file);
      } catch {
        problems.push("dict missing: " + name + "/" + file);
      }
    }
  }
  return problems;
}
