/**
 * 评测资产：音节表与切分器的行为锁定。
 */

import { describe, expect, it } from "vitest";

import { isPlainPinyin, isSegmentable, segmentations, readingMatches } from "../src/eval/syllables.js";

describe("isPlainPinyin", () => {
  it("接受纯小写字母", () => {
    expect(isPlainPinyin("nihao")).toBe(true);
    expect(isPlainPinyin("zhuang")).toBe(true);
  });

  it("拒绝大写、数字、空白与空串", () => {
    expect(isPlainPinyin("nihaoPython")).toBe(false);
    expect(isPlainPinyin("hello123")).toBe(false);
    expect(isPlainPinyin("")).toBe(false);
  });
});

describe("segmentations", () => {
  it("xian 两种切法都合法", () => {
    const segs = segmentations("xian");
    expect(segs).toContainEqual(["xian"]);
    expect(segs).toContainEqual(["xi", "an"]);
  });

  it("多音节长串至少存在标准切分", () => {
    expect(segmentations("yifengshun")).toContainEqual(["yi", "feng", "shun"]);
    expect(segmentations("xuezhongsongtan")).toContainEqual(["xue", "zhong", "song", "tan"]);
  });

  it("无合法切分返回空（协议层拒绝依据）", () => {
    expect(segmentations("nh")).toEqual([]);
    expect(segmentations("nihaom")).toEqual([]);
    expect(segmentations("w")).toEqual([]);
    expect(segmentations("xx")).toEqual([]);
  });

  it("非纯字母直接拒绝", () => {
    expect(segmentations("hello123")).toEqual([]);
  });
});

describe("isSegmentable", () => {
  it("与 segmentations 一致", () => {
    expect(isSegmentable("nihao")).toBe(true);
    expect(isSegmentable("nihaom")).toBe(false);
  });
});

describe("readingMatches", () => {
  const readings = new Map<string, ReadonlySet<string>>([
    ["涨", new Set(["zhang"])],
    ["高", new Set(["gao"])],
    ["长", new Set(["chang", "zhang"])],
  ]);

  it("涨高 匹配 zhanggao", () => {
    expect(readingMatches("涨高", "zhanggao", readings)).toBe(true);
  });

  it("长高 也匹配（多音字存在对应读音）", () => {
    expect(readingMatches("长高", "zhanggao", readings)).toBe(true);
  });

  it("音节数与字数不符则拒绝", () => {
    expect(readingMatches("涨", "zhanggao", readings)).toBe(false);
  });

  it("读音表缺字拒绝", () => {
    expect(readingMatches("塌高", "tagao", readings)).toBe(false);
  });
});
