/**
 * 凭据与个人数据扫描的判据（#27 验收③）。
 *
 * 这里全是**数据**：哪些文件可以有凭据字样、最多几处、为什么。规则是「上界」而不是
 * 「等号」——安全方向上的改动（删掉一处凭据字样）永远合法；任何**新增**凭据字样都会
 * 把计数顶破上界，于是发布被挡下、必须有人判断这处新增是不是泄漏。
 *
 * 反例自证：`credentials.harness` 检查会在内存里放一份带 `api_key = "…"` 的假源码，
 * 扫描器必须报出来。判据本身跑不通的扫描器，等于没有扫描器。
 */

/** 凭据类字样的完整词表；大小写不敏感匹配。 */
export const CREDENTIAL_TOKENS: readonly string[] = [
  "api_key",
  "apikey",
  "api-key",
  "x-api-key",
  "authorization",
  "bearer",
  "credential",
  "secret",
];

/**
 * 需要**赋值语境**才算凭据的字样。
 *
 * `secret` 是英文里的常用词（「secrets are not allowed」这类拒绝性文案里到处都是），
 * 按裸子串计数只会制造噪声；把判据收紧成「`secret:` / `"secret":` / `secret =` 这类
 * 键值形态」后，拒绝凭据的代码不再误报，而真正被写进产物的凭据仍然会被抓出来。
 */
export const ASSIGNMENT_REQUIRED_TOKENS: readonly string[] = ["secret"];

/** 该字样是否出现在键值写法里（`key:`, `"key":`, `key =`）。 */
export function hasAssignmentContext(text: string, token: string): boolean {
  const pattern = new RegExp(`["']?${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*[:=]`, "i");
  return pattern.test(text);
}

/** 机器本地路径与作者身份字样。 */
export const PERSONAL_PATTERNS: readonly { readonly id: string; readonly pattern: RegExp }[] = [
  { id: "personal-path", pattern: /(^|[^A-Za-z0-9_])[A-Za-z]:[\\/](Users|VibeCoding|Documents|Desktop|AppData|OneDrive)([\\/]|$)/i },
  { id: "user-profile-env", pattern: /\bUSERPROFILE\b|%USERPROFILE%/i },
  { id: "env-home", pattern: /\$env:(USERPROFILE|HOME)\b|\$\{?(HOME|USERPROFILE)\}?/ },
  { id: "email", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
];

/** 个人身份字样：公开的仓库/组织地址不算。 */
export const IDENTITY_PATTERNS: readonly { readonly id: string; readonly pattern: RegExp }[] = [
  { id: "personal-path", pattern: PERSONAL_PATTERNS[0]?.pattern ?? /$^/ },
];
export interface CredentialRule {
  readonly id: string;
  /** 相对仓库根的路径。 */
  readonly path: string;
  readonly token: string;
  /** 该文件里这个词最多允许出现几次。 */
  readonly max: number;
  readonly reason: string;
}

/** 生产代码里的基线；上界只允许下调，上调必须有人审。 */
export const CREDENTIAL_RULES: readonly CredentialRule[] = [
  {
    id: "installer-excluded-data-directory",
    path: "src/installer/payload.ts",
    token: "credential",
    max: 1,
    reason: "安装载荷拒绝 credentials 目录的字面名单；无凭据值，增加同类字样仍需重新审核",
  },
  {
    id: "cloud-wire-secret-keys",
    path: "src/contracts/cloud-wire.ts",
    token: "apikey",
    max: 13,
    reason: "云端四形态的请求构造器：字段名与鉴权头的形参名（不是字面量凭据值）",
  },
  {
    id: "cloud-wire-api-key-header",
    path: "src/contracts/cloud-wire.ts",
    token: "api-key",
    max: 3,
    reason: "Anthropic 形态的 `x-api-key` 请求头名字",
  },
  {
    id: "cloud-wire-authorization-header",
    path: "src/contracts/cloud-wire.ts",
    token: "authorization",
    max: 3,
    reason: "`Authorization: Bearer` 请求头名字",
  },
  {
    id: "cloud-wire-bearer",
    path: "src/contracts/cloud-wire.ts",
    token: "bearer",
    max: 3,
    reason: "同上：请求头取值前缀",
  },
  {
    id: "settings-error-codes",
    path: "src/domain/error-codes.ts",
    token: "api_key",
    max: 2,
    reason: "设置校验的封闭错误码文案（回给用户看的那两句）",
  },
  {
    id: "secret-keys-list",
    path: "src/domain/secret-keys.ts",
    token: "api_key",
    max: 1,
    reason: "凭据键名黑名单的唯一清单：`api_key` 必须在这里被点名",
  },
  {
    id: "secret-keys-list-apikey",
    path: "src/domain/secret-keys.ts",
    token: "apikey",
    max: 1,
    reason: "同上：无下划线拼写的黑名单项",
  },
  {
    id: "secret-keys-list-authorization",
    path: "src/domain/secret-keys.ts",
    token: "authorization",
    max: 1,
    reason: "同上：鉴权头键名",
  },
  {
    id: "credential-slot",
    path: "src/domain/settings.ts",
    token: "api_key",
    max: 13,
    reason: "设置文件里**唯一**被豁免的凭据槽位 `cloud.api_key` 的读写与校验",
  },
  {
    id: "credential-slot-camel",
    path: "src/domain/settings.ts",
    token: "apikey",
    max: 8,
    reason: "同一槽位在内存模型里的驼峰字段名",
  },
  {
    id: "cloud-provider-comment",
    path: "src/providers/cloud.ts",
    token: "api_key",
    max: 1,
    reason: "「凭据纪律」注释里点名槽位名",
  },
  {
    id: "cloud-provider-field",
    path: "src/providers/cloud.ts",
    token: "apikey",
    max: 10,
    reason: "把槽位值装进请求头（唯一的出站用法）",
  },
  {
    id: "local-backend-empty-key",
    path: "src/providers/ollama.ts",
    token: "apikey",
    max: 1,
    reason: "本地通道显式置空凭据，证明它不会被填入",
  },
  {
    id: "local-backend-empty-key-snake",
    path: "src/providers/ollama.ts",
    token: "api_key",
    max: 0,
    reason: "本地通道连下划线拼写的槽位名都不该出现",
  },
  {
    id: "settings-host-basic-auth",
    path: "src/web/settings-host.ts",
    token: "authorization",
    max: 2,
    reason: "设置页会话令牌的 `Authorization: Bearer <token>` 校验（会话令牌不是云端凭据）",
  },
  {
    id: "settings-host-basic-auth-bearer",
    path: "src/web/settings-host.ts",
    token: "bearer",
    max: 2,
    reason: "同上",
  },
];

/**
 * 边界文件的两级判据：
 * - `forbidden`：这个文件里**一个都不许出现**，出现即泄漏。
 * - `bounded`：允许出现但计数必须与基线一致（用于注释里点名槽位的场合）。
 */
export interface BoundaryRule {
  readonly id: string;
  readonly path: string;
  readonly forbiddenTokens: readonly string[];
  readonly bounded: readonly { readonly token: string; readonly max: number; readonly reason: string }[];
  readonly reason: string;
}

/**
 * 完成通知链路与诊断日志：票面第③条点名「不能进日志、IPC 完成通知」。
 * 这三份文件是那两条出口的全部代码面，所以在这里上一道「一个凭据字样都没有」的硬线。
 */
export const BOUNDARY_RULES: readonly BoundaryRule[] = [
  {
    id: "completion-notify",
    path: "src/runtime/completion-notify.ts",
    forbiddenTokens: CREDENTIAL_TOKENS,
    bounded: [],
    reason: "完成通知的载荷只有 engine id / request id / seq，凭据一个都不该沾",
  },
  {
    id: "completion-messenger",
    path: "src/runtime/weasel-messenger-koffi.ts",
    forbiddenTokens: CREDENTIAL_TOKENS,
    bounded: [],
    reason: "窗口消息的实际投递面",
  },
  {
    id: "privacy-log",
    path: "src/runtime/privacy-log.ts",
    forbiddenTokens: CREDENTIAL_TOKENS,
    bounded: [
      {
        token: "settings",
        max: 1,
        reason: "只 import `LogMode` 类型，不持有设置对象",
      },
    ],
    reason: "诊断日志只写元数据码；凭据不得出现在任何写入路径上",
  },
];

/**
 * ship-set 里绝不允许出现的字样（发布物的自我声明面）。
 *
 * 刻意只放**无歧义**的凭据形态：许可证正文里出现 `-----BEGIN` 是 i-Padic 那类
 * `COPYING.ipadic-----BEGIN` 行的一部分，所以私钥标记写全 `-----BEGIN `（带空格）。
 */
export const SHIP_SET_FORBIDDEN_TOKENS: readonly string[] = [
  "api_key",
  "apikey",
  "x-api-key",
  "-----BEGIN ",
  "secret_key",
  "client_secret",
  "password:",
];
