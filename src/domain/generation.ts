/**
 * 词库内生成校验（spec #18 §3、决策 05 Q2A）。
 *
 * 生成模式的承诺是「只在词库内选择，绝不造词」：模型给出的词条必须逐字命中交给它的
 * 候选集合（运行时它就是用户词库的投影），读音与音节都对得上本次拼音，长度也在冻结
 * 上限内，并且要能还原成候选列表里的一项。任何一项不通过 → 安全留空，不改词库、
 * 不代用户提交。
 *
 * 读音与音节的**运行时候据**只有候选的 preedit 与请求里的拼音：留出集评测用的是
 * 单字读音表，运行时不持有词库文件，逐字读音由「候选 preedit 与本次拼音等价」代表，
 * 音节由冻结切分表对齐。这条投影写进 ADR 0007（偏离冻结点之一）。
 */

import type { GenerationDecision } from "./decision.js";
import { err, ok, type Result } from "./result.js";
import { segmentations } from "./syllables.js";

/** 冻结生成契约的 maxLength（reference/.scratch/rime-model-predict/runs/wf26/generation_contract.py）。 */
export const MAX_GENERATED_SCALARS = 32;

/** 冻结生成契约的切分上限：超过它视为 ambiguous_input；运行时同样拒绝。 */
export const MAX_REFERENCE_SEGMENTATIONS = 32;

export type GenerationRejection =
  | "empty_text"
  | "too_long"
  | "invalid_character"
  | "syllable_mismatch"
  | "reading_mismatch"
  | "not_in_lexicon";

/** 与冻结契约 CJK_RANGE 同一批平面（U+3400-U+4DBF / U+4E00-U+9FFF / U+20000-U+323AF）。 */
function isCjkScalar(value: number): boolean {
  return (value >= 0x3400 && value <= 0x4dbf) || (value >= 0x4e00 && value <= 0x9fff) || (value >= 0x20000 && value <= 0x323af);
}

export function isCjkText(text: string): boolean {
  return [...text].every((char) => isCjkScalar(char.codePointAt(0) ?? 0));
}

/** 拼音与 preedit 的比较只看字母：大小写、空白、撇号都不参与判定。 */
export function normalizeReading(value: string): string {
  return value.toLowerCase().replace(/[\s']/g, "");
}

/**
 * 本次拼音的全部合法切分；撇号是**硬边界**——「xi'an」不等于「xian」，这是输入法
 * 里真实存在的区分，归一化不能把它抹掉。返回空数组表示无法切成合法音节。
 * 结果最多 `MAX_REFERENCE_SEGMENTATIONS + 1` 条：多出来的那一条就是「歧义」信号。
 */
export function generationPaths(pinyin: string): readonly (readonly string[])[] {
  const parts = pinyin.toLowerCase().split("'");
  if (parts.length === 0 || parts.some((part) => !/^[a-z]+$/.test(part))) return [];
  let paths: string[][] = [[]];
  for (const part of parts) {
    const inner = segmentations(part);
    if (inner.length === 0) return [];
    const combined: string[][] = [];
    for (const left of paths) {
      for (const right of inner) {
        combined.push([...left, ...right]);
        if (combined.length > MAX_REFERENCE_SEGMENTATIONS) return combined;
      }
    }
    paths = combined;
  }
  return paths;
}

/** 是否有一个切分的音节数与字数相同（生成词条与本次拼音对齐的唯一判据）。 */
export function alignsWithPinyin(text: string, pinyin: string): boolean {
  const scalars = [...text].length;
  const paths = generationPaths(pinyin);
  if (paths.length === 0 || paths.length > MAX_REFERENCE_SEGMENTATIONS) return false;
  return paths.some((path) => path.length === scalars);
}

/**
 * 生成词条 → 候选显示编号（1 起）。
 *
 * 顺序有意从便宜到贵，并且都在**拒绝**一侧：空 → 超长 → 非汉字 → 音节对齐 →
 * 词库成员（硬约束）→ 读音。候选字段缺席时读音无从核对，同样拒绝。
 */
export function resolveGeneratedWord(text: string, decision: GenerationDecision): Result<number, GenerationRejection> {
  if (text === "") return err("empty_text");
  const scalars = [...text];
  if (scalars.length > MAX_GENERATED_SCALARS) return err("too_long");
  if (!isCjkText(text)) return err("invalid_character");

  const reading = normalizeReading(decision.state.pinyin);
  if (!/^[a-z]+$/.test(reading) || !alignsWithPinyin(text, decision.state.pinyin)) {
    return err("syllable_mismatch");
  }

  const index = decision.candidates.indexOf(text);
  if (index < 0) return err("not_in_lexicon");
  const field = decision.candidateFields[index];
  if (field === undefined || normalizeReading(field.preedit) !== reading) return err("reading_mismatch");
  return ok(index + 1);
}
