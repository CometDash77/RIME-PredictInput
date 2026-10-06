/**
 * 凭据类键名的唯一清单。
 *
 * 文件 IPC、设置文件和设置网页三处都要拒绝同一批键名，旧实现各写了一份集合，
 * 任意一处漏改都会让凭据从另一条路径流出去。
 */
export const SECRET_KEYS: readonly string[] = [
  "api_key",
  "apikey",
  "secret",
  "authorization",
  "credential",
  "token",
];

/**
 * Python 的 `str.casefold`：小写化之外还需处理 ß→ss、ſ→s、İ→i̇，
 * 否则 "ſecret" 这类写法能绕过大小写比较。
 */
export function casefold(value: string): string {
  return value.toLowerCase().replace(/ß/g, "ss").replace(/ſ/g, "s").replace(/\u0130/g, "i\u0307");
}

/** 递归查找第一个凭据键名（原样返回），没有则返回 null。 */
export function findSecretKey(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSecretKey(item);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_KEYS.includes(casefold(key))) return key;
    const found = findSecretKey(nested);
    if (found !== null) return found;
  }
  return null;
}
