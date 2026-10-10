/**
 * 词库解析与「完整候选集合」计算（评测资产专用，冻结口径）。
 *
 * 冻结定义（写入留出集 manifest，rig 只消费标签不重算）：
 *   输入 pinyin 的完整候选集合 = 该 schema 全部词库文件中、concatenated
 *   码 == pinyin 的去重词条，按 weight 降序、同权重按文本码点升序排列。
 *   口径对齐 research/generation-quality-baseline.md 的实测基线：polyphone
 *   （涨高）是唯一的 wf26 候选外样本，说明基线口径不含运行时组词；本定义
 *   与其一致（纯词条查询，不含用户词库学习行为）。
 */

export interface DictEntry {
  readonly text: string;
  /** 原始码列的音节数组（保留切分供单字读音表使用）。 */
  readonly syllables: readonly string[];
  /** 连接成串的码（无声调、无分隔）。 */
  readonly concat: string;
  readonly weight: number;
}

export interface Lexicon {
  /** concat 码 → 去重后的词条（同 text+concat 只保留最大 weight）。 */
  readonly byConcat: ReadonlyMap<string, readonly DictEntry[]>;
  /** 单字 → 全部合法读音（无声调音节）。 */
  readonly charReadings: ReadonlyMap<string, ReadonlySet<string>>;
  readonly entryCount: number;
  readonly skippedLines: number;
}

interface RawParse {
  readonly entries: DictEntry[];
  readonly skipped: number;
}

/** 解析一个 RIME dict.yaml 的正文行：text TAB code[ TAB weight]。表头与注释跳过。 */
export function parseDictYaml(content: string): RawParse {
  const entries: DictEntry[] = [];
  let skipped = 0;
  let inBody = false;
  for (const line of content.split(/\r?\n/)) {
    if (!inBody) {
      if (line.trim() === "...") inBody = true;
      continue;
    }
    if (line === "" || line.startsWith("#")) continue;
    const cols = line.split("\t");
    if (cols.length < 2) { skipped += 1; continue; }
    const text = cols[0] as string;
    const codeRaw = cols[1] as string;
    const weight = cols.length >= 3 ? Number.parseFloat(cols[2] as string) : 0;
    const syllables = codeRaw.split(/[\s']+/).filter((s) => s !== "");
    if (text === "" || syllables.length === 0) { skipped += 1; continue; }
    let ok = true;
    for (const syl of syllables) {
      if (!/^[a-z]+$/.test(syl)) { ok = false; break; }
    }
    if (!ok) { skipped += 1; continue; }
    if (!Number.isFinite(weight)) { skipped += 1; continue; }
    entries.push({ text, syllables, concat: syllables.join(""), weight });
  }
  return { entries, skipped };
}

/** 合并多个词库文件为一个 schema 词典；同 text+concat 去重取最大 weight。 */
export function buildLexicon(files: readonly { name: string; content: string }[]): Lexicon {
  const best = new Map<string, DictEntry>();
  const charReadings = new Map<string, Set<string>>();
  let skipped = 0;
  let entryCount = 0;
  for (const file of files) {
    const parsed = parseDictYaml(file.content);
    skipped += parsed.skipped;
    for (const entry of parsed.entries) {
      entryCount += 1;
      if ([...entry.text].length === 1) {
        const char = entry.text as string;
        let set = charReadings.get(char);
        if (set === undefined) { set = new Set(); charReadings.set(char, set); }
        for (const syl of entry.syllables) set.add(syl);
      }
      const key = entry.text + "\u0000" + entry.concat;
      const prev = best.get(key);
      if (prev === undefined || entry.weight > prev.weight) best.set(key, entry);
    }
  }
  const byConcat = new Map<string, DictEntry[]>();
  for (const entry of best.values()) {
    let list = byConcat.get(entry.concat);
    if (list === undefined) { list = []; byConcat.set(entry.concat, list); }
    list.push(entry);
  }
  return { byConcat, charReadings, entryCount, skippedLines: skipped };
}

export interface RankedCandidate {
  readonly text: string;
  readonly weight: number;
  /** 1 起的全序位次（weight 降序、同权重按文本码点升序后的下标 +1）。 */
  readonly rank: number;
}

/** 输入 pinyin 的完整候选集合（冻结口径：纯词条查询），已排序带位次。 */
export function completeCandidates(lexicon: Lexicon, pinyin: string): RankedCandidate[] {
  const list = [...(lexicon.byConcat.get(pinyin) ?? [])];
  list.sort((a, b) => (b.weight - a.weight) || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
  return list.map((entry, index) => ({ text: entry.text, weight: entry.weight, rank: index + 1 }));
}

export interface SampleLabels {
  /** 目标是否在完整候选集合内。 */
  readonly insideComplete: boolean;
  /** 目标在完整集合中的位次（不在则为 null）。 */
  readonly rank: number | null;
  /** 目标在集合内但位次在第 5 页之后（候选页外）。 */
  readonly beyondPage: boolean;
  /** 目标完全在完整候选集合之外（生成能力的核心收益）。 */
  readonly outsideComplete: boolean;
}

/** 对单个目标在给定词典下打标签（冻结口径的唯一定义点）。 */
export function labelTarget(lexicon: Lexicon, pinyin: string, target: string): SampleLabels {
  const ranked = completeCandidates(lexicon, pinyin);
  const hit = ranked.find((c) => c.text === target);
  const inside = hit !== undefined;
  const rank = inside ? (hit as RankedCandidate).rank : null;
  return {
    insideComplete: inside,
    rank,
    beyondPage: inside && rank !== null && rank > 5,
    outsideComplete: !inside,
  };
}
