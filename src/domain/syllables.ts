/**
 * 冻结的普通话无声调音节表与合法切分器（评测资产专用）。
 *
 * 这是评测口径的一部分，不是产品运行时组件：留出集的候选集合计算与
 * 生成词读音校验都以这张表为唯一分节依据。表内不含声调（与全拼词库
 * 码列一致），ü 以 v 拼写。表为标准普通话音节集合的冻结快照；修订它
 * 等于修订评测口径，必须重建留出集与哈希。
 */

const SYLLABLE_LIST = [
  // 零声母
  "a", "o", "e", "ai", "ei", "ao", "ou", "an", "en", "ang", "eng", "er", "yo",
  "yi", "ya", "ye", "yao", "you", "yan", "yin", "yang", "ying", "yong",
  "yu", "yue", "yuan", "yun",
  "wu", "wa", "wo", "wai", "wei", "wan", "wen", "wang", "weng",
  // b p m f
  "ba", "bo", "bai", "bei", "bao", "ban", "ben", "bang", "beng", "bi", "biao", "bie", "bian", "bin", "bing", "bu",
  "pa", "po", "pai", "pei", "pao", "pou", "pan", "pen", "pang", "peng", "pi", "piao", "pie", "pian", "pin", "ping", "pu",
  "ma", "mo", "me", "mai", "mei", "mao", "mou", "man", "men", "mang", "meng", "mi", "miao", "mie", "mian", "min", "ming", "mu",
  "fa", "fo", "fei", "fou", "fan", "fen", "fang", "feng", "fu",
  // d t
  "da", "de", "dai", "dei", "dao", "dou", "dan", "den", "dang", "deng", "dong", "di", "dia", "diao", "die", "dian", "ding", "diu", "du", "duo", "dui", "duan", "dun",
  "ta", "te", "tai", "tao", "tou", "tan", "tang", "teng", "tong", "ti", "tiao", "tie", "tian", "ting", "tu", "tuo", "tui", "tuan", "tun",
  // n l
  "na", "ne", "nai", "nei", "nao", "nou", "nan", "nen", "nang", "neng", "nong", "ni", "niao", "nie", "nian", "nin", "niang", "ning", "nu", "nuo", "nuan", "nv", "nve",
  "la", "le", "lai", "lei", "lao", "lou", "lan", "lang", "leng", "long", "li", "lia", "liao", "lie", "lian", "lin", "liang", "ling", "liu", "lu", "luo", "luan", "lun", "lv", "lve",
  // g k h
  "ga", "ge", "gai", "gei", "gao", "gou", "gan", "gen", "gang", "geng", "gong", "gu", "gua", "guo", "guai", "gui", "guan", "gun", "guang",
  "ka", "ke", "kai", "kao", "kou", "kan", "ken", "kang", "keng", "kong", "ku", "kua", "kuo", "kuai", "kui", "kuan", "kun", "kuang",
  "ha", "he", "hai", "hei", "hao", "hou", "han", "hen", "hang", "heng", "hong", "hu", "hua", "huo", "huai", "hui", "huan", "hun", "huang",
  // j q x
  "ji", "jia", "jiao", "jie", "jian", "jin", "jiang", "jing", "jiong", "jiu", "ju", "jue", "juan", "jun",
  "qi", "qia", "qiao", "qie", "qian", "qin", "qiang", "qing", "qiong", "qiu", "qu", "que", "quan", "qun",
  "xi", "xia", "xiao", "xie", "xian", "xin", "xiang", "xing", "xiong", "xiu", "xu", "xue", "xuan", "xun",
  // zh ch sh r
  "zha", "zhe", "zhi", "zhai", "zhei", "zhao", "zhou", "zhan", "zhen", "zhang", "zheng", "zhong", "zhu", "zhua", "zhuo", "zhuai", "zhui", "zhuan", "zhun", "zhuang",
  "cha", "che", "chi", "chai", "chao", "chou", "chan", "chen", "chang", "cheng", "chong", "chu", "chua", "chuo", "chuai", "chui", "chuan", "chun", "chuang",
  "sha", "she", "shi", "shai", "shei", "shao", "shou", "shan", "shen", "shang", "sheng", "shu", "shua", "shuo", "shuai", "shui", "shuan", "shun", "shuang",
  "re", "ri", "rao", "rou", "ran", "ren", "rang", "reng", "rong", "ru", "rua", "ruo", "rui", "ruan", "run",
  // z c s
  "za", "ze", "zi", "zai", "zei", "zao", "zou", "zan", "zen", "zang", "zeng", "zong", "zu", "zuo", "zui", "zuan", "zun",
  "ca", "ce", "ci", "cai", "cao", "cou", "can", "cen", "cang", "ceng", "cong", "cu", "cuo", "cui", "cuan", "cun",
  "sa", "se", "si", "sai", "sao", "sou", "san", "sen", "sang", "seng", "song", "su", "suo", "sui", "suan", "sun",
] as const;

const SYLLABLES: ReadonlySet<string> = new Set(SYLLABLE_LIST);

/** 输入必须是纯小写字母（评测协议口径：其余一律协议层拒绝）。 */
export function isPlainPinyin(input: string): boolean {
  return /^[a-z]+$/.test(input);
}

const MAX_SYLLABLE_SCALARS = 6;
const MAX_SEGMENTATIONS = 64;

/**
 * 输入串的全部合法切分（每个切分是音节数组）。无可行切分时返回空数组。
 * 结果上限 MAX_SEGMENTATIONS，超出的切分按 DP 序丢弃——评测集的输入都
 * 远小于该上限，截断只保护病态输入。
 */
export function segmentations(input: string): string[][] {
  if (!isPlainPinyin(input) || input.length > 64) return [];
  const results: string[][] = [];

  const walk = (start: number, acc: string[]): boolean => {
    if (start === input.length) {
      results.push([...acc]);
      return results.length >= MAX_SEGMENTATIONS;
    }
    for (let len = 1; len <= MAX_SYLLABLE_SCALARS; len++) {
      if (start + len > input.length) break;
      const head = input.slice(start, start + len);
      if (!SYLLABLES.has(head)) continue;
      acc.push(head);
      const stop = walk(start + len, acc);
      acc.pop();
      if (stop) return true;
    }
    return false;
  };
  walk(0, []);
  return results;
}

/** 输入是否至少存在一种合法切分（协议层准入判据）。 */
export function isSegmentable(input: string): boolean {
  return segmentations(input).length > 0;
}

/**
 * 词的读音校验：存在某种切分 S（音节数 == 词长），使每个字都有该音节的读音。
 * readings[char] 是该字的全部合法读音（无声调）。
 */
export function readingMatches(word: string, pinyin: string, readings: ReadonlyMap<string, ReadonlySet<string>>): boolean {
  const chars = [...word];
  const segs = segmentations(pinyin);
  if (segs.length === 0 || chars.length === 0) return false;
  for (const seg of segs) {
    if (seg.length !== chars.length) continue;
    let ok = true;
    for (let i = 0; i < chars.length; i++) {
      const set = readings.get(chars[i] as string);
      if (set === undefined || !set.has(seg[i] as string)) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}
