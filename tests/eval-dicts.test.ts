/**
 * 评测资产：词库解析与完整候选集合（冻结口径）的行为锁定。
 */

import { describe, expect, it } from "vitest";

import { buildLexicon, completeCandidates, labelTarget, parseDictYaml } from "../src/eval/dicts.js";

const DICT_A = [
  "# minimal dict",
  "...",
  "你好\tni hao\t100",
  "拟好\tni hao\t50",
  "你\tni\t200",
  "泥\tni\t180",
  "逆\tni\t10",
  "呢\tni\t20",
  "妮\tni\t15",
  "倪\tni\t12",
  "尼\tni\t30",
  "世界\tshi jie\t500",
  "视角\tshi jiao\t300",
].join("\n");

const DICT_B = [
  "...",
  "你好\tni hao\t120",
  "距好\tni hao\t5",
].join("\n");

function miniLexicon() {
  return buildLexicon([
    { name: "a.dict.yaml", content: DICT_A },
    { name: "b.dict.yaml", content: DICT_B },
  ]);
}

describe("parseDictYaml", () => {
  it("跳过表头与注释，解析词条", () => {
    const parsed = parseDictYaml(DICT_A);
    expect(parsed.entries.length).toBe(11);
    expect(parsed.skipped).toBe(0);
    expect(parsed.entries[0]?.text).toBe("你好");
    expect(parsed.entries[0]?.concat).toBe("nihao");
    expect(parsed.entries[0]?.weight).toBe(100);
  });

  it("非字母码列计入 skipped", () => {
    const parsed = parseDictYaml("...\n问号\tni hao?\t9\n世界\tshi jie\t1");
    expect(parsed.entries.length).toBe(1);
    expect(parsed.skipped).toBe(1);
  });
});

describe("buildLexicon", () => {
  it("跨文件同 text+concat 去重取最大 weight", () => {
    const lexicon = miniLexicon();
    const nihao = lexicon.byConcat.get("nihao") ?? [];
    const you = nihao.find((e) => e.text === "你好");
    expect(you?.weight).toBe(120);
  });

  it("单字读音表来自单字词条", () => {
    const lexicon = miniLexicon();
    expect(lexicon.charReadings.get("你")).toContain("ni");
  });
});

describe("completeCandidates", () => {
  it("weight 降序、同权重文本码点升序、rank 1 起", () => {
    const lexicon = miniLexicon();
    const ranked = completeCandidates(lexicon, "ni");
    expect(ranked.map((c) => c.text)).toEqual(["你", "泥", "尼", "呢", "妮", "倪", "逆"]);
    expect(ranked[0]?.rank).toBe(1);
    expect(ranked[6]?.rank).toBe(7);
  });

  it("concat 相同的不同切分词同集（ni hao / nihao）", () => {
    const lexicon = miniLexicon();
    const ranked = completeCandidates(lexicon, "nihao").map((c) => c.text);
    expect(ranked).toContain("你好");
    expect(ranked).toContain("拟好");
    expect(ranked).toContain("距好");
  });

  it("纯词条口径：无词条的 pinyin 集合为空", () => {
    const lexicon = miniLexicon();
    expect(completeCandidates(lexicon, "zhanggao")).toEqual([]);
  });
});

describe("labelTarget", () => {
  it("集合外目标 outsideComplete=true", () => {
    const labels = labelTarget(miniLexicon(), "zhanggao", "涨高");
    expect(labels.outsideComplete).toBe(true);
    expect(labels.insideComplete).toBe(false);
    expect(labels.rank).toBe(null);
  });

  it("第 5 位之后的目标 beyondPage=true", () => {
    const labels = labelTarget(miniLexicon(), "ni", "呢");
    expect(labels.insideComplete).toBe(true);
    expect(labels.rank).toBe(4);
    expect(labels.beyondPage).toBe(false);
    const deep = labelTarget(miniLexicon(), "ni", "逆");
    expect(deep.rank).toBe(7);
    expect(deep.beyondPage).toBe(true);
  });
});
