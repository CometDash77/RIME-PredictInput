# 归档的许可证正文（provenance）

本目录存放**逐字归档**的许可证正文副本——它们是发布合规判据的输入，不是摘要也不是转述。

## `GPL-3.0.txt`

- 来源：`rime/weasel` 上游 release commit `9cc96e20dc71b80876b12f689bb5863c76c2a7ed` 的 `LICENSE.txt`
  ——即本仓库 fork 所承的同一份 GPL-3.0 正文（`docs/fork/build-and-release.md` §3 步骤 6 会把它复制进
  `output\data\LICENSE.txt` 随安装包分发）。
- URL：`https://raw.githubusercontent.com/rime/weasel/9cc96e20dc71b80876b12f689bb5863c76c2a7ed/LICENSE.txt`
- 字节数：35147（LF）
- sha256：`8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903`
- 用途：#27 验收①「Weasel fork 继续按 GPL-3 派生物处理」的正文依据；fork 的对应源码义务在
  `docs/fork/release-template.md` 的「GPL-3.0-only 源码义务」段声明。

## `Node.js-v22.23.2-LICENSE.txt`

- 来源：`nodejs/node` 官方 tag `v22.23.2` 的 `LICENSE`
  ——即 `@yao-pkg/pkg` 为 `node22-win-x64` 拉取的运行时版本（见 `node_modules/@yao-pkg/pkg-fetch/patches/patches.json`）。
- URL：`https://raw.githubusercontent.com/nodejs/node/v22.23.2/LICENSE`
- 字节数：145485（LF）
- sha256：`c738ae413cf561f174e34f6961f8ca458aae2369a73640dda6234c629b98bcc4`
- 为什么归档而不是从本机读：Windows 的 Node 安装包**不含** `LICENSE` 文件
  （`C:\Program Files\nodejs\` 下只有 `node.exe` 与 npm 脚本），构建机上也一样。
  归档正文同时包含 Node 自身与其内嵌第三方组件（OpenSSL、V8、zlib、ICU 等）的许可证清单。
- 用途：#27 验收②「内嵌 Node 运行时的许可证与版权声明」的正文依据；`src/release/licenses.ts`
  按 `docs/license/Node.js-<版本>-LICENSE.txt` 读取，缺失即发布被挡下。

## 更新纪律

升级运行时或更换 fork 基底时，重新取对应 tag 的正文覆盖本目录文件，并同步更新本节记录的
URL、字节数与 sha256（`pnpm release:check` 的 `licenses.embedded-node` 检查会打印当前正文哈希供比对）。
