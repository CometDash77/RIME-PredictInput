/**
 * 凭据/个人数据扫描器（#27 验收③）。
 *
 * 扫描面分三层，每层都返回**计数**而不是布尔：告警只有在计数超过基线时才构成失败，
 * 所以报告里能看出「这处凭据字样一直在这儿」和「这次多出来一处」的区别。
 */
import { nodeFs, type ReleaseFs } from "./fs.js";
import {
  ASSIGNMENT_REQUIRED_TOKENS,
  CREDENTIAL_TOKENS,
  hasAssignmentContext,
  PERSONAL_PATTERNS,
  SHIP_SET_FORBIDDEN_TOKENS,
  type BoundaryRule,
  type CredentialRule,
} from "./credential-policy.js";
import { NOTICES_PATH } from "./notices.js";
import type { CredentialFinding } from "./types.js";

/** 计数：大小写不敏感的子串出现次数。 */
export function countOccurrences(haystack: string, needle: string): number {
  const lowerHaystack = haystack.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  if (lowerNeedle.length === 0) return 0;
  let count = 0;
  let index = lowerHaystack.indexOf(lowerNeedle);
  while (index >= 0) {
    count += 1;
    index = lowerHaystack.indexOf(lowerNeedle, index + lowerNeedle.length);
  }
  return count;
}

export function matchPatterns(text: string, patterns: readonly { readonly id: string; readonly pattern: RegExp }[]): readonly string[] {
  const matched: string[] = [];
  for (const { id, pattern } of patterns) {
    if (pattern.test(text)) matched.push(id);
  }
  return matched;
}

export interface CredentialScan {
  readonly findings: readonly CredentialFinding[];
  readonly filesScanned: number;
  /** 上界被顶破的规则 id；非空即失败。 */
  readonly violations: readonly string[];
}

export interface ScanInput {
  readonly fs: ReleaseFs;
  /** 相对仓库根 → 扫描位置；只有列在这里的文件会被静态规则判失败。 */
  readonly files: readonly string[];
}

/**
 * 生产代码的基线扫描：扫描面就是 `src/` 下所有生产文件（**不是**规则里那几个路径）。
 *
 * 逐文件对**整张词表**计数，再拿规则里声明过的上界比对：
 * - 计数 > 上界（含规则没提过的文件：上界默认 0）⇒ 违规，必须有人判断这处是不是泄漏；
 * - 计数 < 上界 ⇒ 也算漂移，基线必须跟着收紧，否则它只是一串过期数字。
 */
export function scanCredentialBaseline(
  root: string,
  rules: readonly CredentialRule[],
  input: ScanInput,
): CredentialScan {
  const findings: CredentialFinding[] = [];
  const violations: string[] = [];
  const declaredPaths = [...new Set(rules.map((rule) => rule.path))].sort();

  let scanned = 0;
  for (const path of input.files) {
    const text = input.fs.readText(`${root}/${path}`);
    if (text === null) {
      // 「清单里有、磁盘上没有」是打包/复制出错的味道，不能当成「干净」放过。
      findings.push({ location: path, rule: "unreadable-source", count: 0, allowed: 0 });
      violations.push(`${path} 读不到内容（清单里有、磁盘上没有？）`);
      continue;
    }
    scanned += 1;
    const known = rules.filter((rule) => rule.path === path);
    if (known.length === 0) {
      // 规则没提过的生产文件：词表里任何一个字样出现即违规（上界默认 0）。
      for (const token of CREDENTIAL_TOKENS) {
        if (ASSIGNMENT_REQUIRED_TOKENS.includes(token) && !hasAssignmentContext(text, token)) continue;
        const count = countOccurrences(text, token);
        if (count === 0) continue;
        findings.push({ location: `${path}#${token}`, rule: "undeclared-credential-token", count, allowed: 0 });
        violations.push(`${path} 未被任何规则覆盖，却出现 ${token} ×${String(count)}`);
      }
      continue;
    }
    for (const rule of known) {
      const count = countOccurrences(text, rule.token);
      findings.push({ location: `${path}#${rule.token}`, rule: rule.id, count, allowed: rule.max });
      if (count > rule.max) {
        violations.push(`${rule.id}:${path} ${rule.token} ${String(count)}>${String(rule.max)}`);
      }
      if (count < rule.max) {
        violations.push(`${rule.id}:${path} ${rule.token} ${String(count)}<${String(rule.max)}（基线需下调）`);
      }
    }
  }

  for (const path of declaredPaths) {
    if (input.files.includes(path)) continue;
    const rule = rules.find((candidate) => candidate.path === path);
    findings.push({ location: `${path}#${rule?.token ?? "?"}`, rule: rule?.id ?? "missing", count: 0, allowed: rule?.max ?? 0 });
    violations.push(`${rule?.id ?? "?"}:${path} 不在扫描面内`);
  }

  findings.sort((left, right) => left.location.localeCompare(right.location));
  return { findings, filesScanned: scanned, violations };
}

/** 边界文件扫描：`forbiddenTokens` 一个都不许出现，`bounded` 只许等于基线。 */
export function scanBoundaryRules(root: string, rules: readonly BoundaryRule[], input: ScanInput): CredentialScan {
  const findings: CredentialFinding[] = [];
  const violations: string[] = [];
  for (const rule of rules) {
    const text = input.fs.readText(`${root}/${rule.path}`);
    if (text === null) {
      findings.push({ location: rule.path, rule: rule.id, count: 0, allowed: 0 });
      violations.push(`${rule.id}:${rule.path} 不存在`);
      continue;
    }
    for (const token of rule.forbiddenTokens) {
      const count = countOccurrences(text, token);
      if (count === 0) continue;
      findings.push({ location: `${rule.path}#${token}`, rule: rule.id, count, allowed: 0 });
      violations.push(`${rule.id}:${rule.path} 出现 ${token} ×${String(count)}（${rule.reason}）`);
    }
    for (const bounded of rule.bounded) {
      const count = countOccurrences(text, bounded.token);
      findings.push({ location: `${rule.path}#${bounded.token}`, rule: rule.id, count, allowed: bounded.max });
      if (count !== bounded.max) {
        violations.push(`${rule.id}:${rule.path} ${bounded.token} ${String(count)}≠${String(bounded.max)}`);
      }
    }
  }
  findings.sort((left, right) => left.location.localeCompare(right.location));
  return { findings, filesScanned: rules.length, violations };
}

/** 发布物扫描：产物里出现凭据字样或私钥标记即挡下。 */
export function scanShipSet(root: string, files: readonly string[], fs: ReleaseFs = nodeFs): CredentialScan {
  const findings: CredentialFinding[] = [];
  const violations: string[] = [];
  for (const path of files) {
    const text = fs.readText(`${root}/${path}`);
    if (text === null) continue;
    for (const token of SHIP_SET_FORBIDDEN_TOKENS) {
      const count = countOccurrences(text, token);
      if (count === 0) continue;
      findings.push({ location: `${path}#${token}`, rule: "ship-set-forbidden-token", count, allowed: 0 });
      violations.push(`${path} 出现 ${token} ×${String(count)}`);
    }
  }
  findings.sort((left, right) => left.location.localeCompare(right.location));
  return { findings, filesScanned: files.length, violations };
}

export function scanPersonalData(
  root: string,
  files: readonly string[],
  fs: ReleaseFs = nodeFs,
): { readonly findings: readonly CredentialFinding[]; readonly violations: readonly string[] } {
  const findings: CredentialFinding[] = [];
  const violations: string[] = [];
  for (const path of files) {
    const text = fs.readText(`${root}/${path}`);
    if (text === null) continue;
    for (const { id, pattern } of PERSONAL_PATTERNS) {
      if (!pattern.test(text)) continue;
      findings.push({ location: `${path}#${id}`, rule: id, count: 1, allowed: 0 });
      violations.push(`${path} 命中 ${id}`);
    }
  }
  findings.sort((left, right) => left.location.localeCompare(right.location));
  return { findings, violations };
}

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * 第三方声明里的邮箱不是泄漏，而是**版权声明本身**：这些地址必须逐字出现在
 * 依赖随包附带的许可证正文里。这条判据把「声明抄自安装树」变成可核对的等式，
 * 顺带把「有人在声明里塞了一个只有本机才有的邮箱」也抓出来。
 */
export function scanNoticesProvenance(
  noticesText: string | null,
  licenseTexts: readonly string[],
): { readonly findings: readonly CredentialFinding[]; readonly violations: readonly string[] } {
  const findings: CredentialFinding[] = [];
  const violations: string[] = [];
  if (noticesText === null) return { findings, violations };
  const haystack = licenseTexts.join("\n");
  const seen = new Set<string>();
  for (const match of noticesText.match(EMAIL_PATTERN) ?? []) {
    if (seen.has(match)) continue;
    seen.add(match);
    findings.push({ location: `${NOTICES_PATH}#email:${match}`, rule: "notices-provenance", count: 1, allowed: 1 });
    if (!haystack.includes(match)) {
      violations.push(`${NOTICES_PATH} 出现安装树许可证正文里没有的地址：${match}`);
    }
  }
  return { findings, violations };
}
