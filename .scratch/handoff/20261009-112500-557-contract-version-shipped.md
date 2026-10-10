# 会话交接：#20 contract_version 全链路收口 + #19 分支重建（2026-10-09）

## 结论（已确认的决定与成果）

- #20 已完成并关闭；commit adf749e 已推送 research/native-integration。
  - CONTRACT_VERSION=1（src/contracts/envelope.ts:19）与 PROTOCOL_VERSION=1 语义分离；contract_version 键序紧随 version；ready 标记五键（version,seq,ts,bytes,sha256）不加字段。
  - 请求侧未知/缺失/类型错 → err("unsupported request envelope")；响应侧同条件 → null；60 秒过期门控（RESPONSE_MAX_AGE_SECONDS=60；created_at > now+1 容差或超 60s → null）为有意增强。
  - oracle fixture 再生：dump_fixtures.py 以 with_contract 注入信封/request_to_mapping/read_latest/byte 字段，4 条 contract 拒答用例（unknown=2/missing/string "1"/bool True）手写 result，response .ready 的 bytes/sha256 重算；inference/policy/decision_payloads/settings_mappings/chat_requests 段零漂移，runtime 的 pid 与 request_id 为非确定值不算漂移。
  - pnpm verify：19 文件 353 passed + 1 skipped；node dist/cli/main.js selftest：7 项 checks 全 ok；pnpm build 干净。
  - ADR 0005（docs/adr/0005-ipc-contract-version.md）；测试计数表述 210→354（README.md:7、docs/architecture/project-map.md:86）。
  - 票务：#20 收口评论 + close；#18 进度评论；#19 两条进度评论（审计 + 分支重建记录）。
- #19：fork CometDash77/weasel 的 0.17.4 tag 与上游逐字节一致（tag object f53a92543f2ef890503d0391e595af8fa9abdb02，指向 release commit 9cc96e20dc71b80876b12f689bb5863c76c2a7ed，2025-06-04）；predict-0.17.4 分支已从该 commit 经 GitHub API 创建并 readback 验证。AC 第 1 条完成。
- 边界裁决：Lua 侧「未知版本安全留空」归 S5（#24）实施；#20 收口评论已记录，勿在其他票重开。

## 未完成事项（下一步）

- #19 剩余交付：上游构建/打包链干净环境复现（Windows + MSVC 工具链）、sha256 二进制清单、fork Release 模板（源码 tag 链接/上游基底/四项改动预留/GPL-3 义务入口）、librime 零改动验证（submodule 指针对比上游 0.17.4）、Win10 x64 与 Win11 x64 构建前置条件记录。
- #19 完成后解锁 #21–#23；依赖图不变（#24 等 #21+#22，#25 等 #24，#26 等 #19+#24，#27 等 #24，#28 等 #26+#27，#29 等 #19-28，#30 等 #29）。
- 接手票前先读地图 #1 与对应实施票正文，勿凭摘要开工。

## 环境教训（新会话必读）

- 本机代理：git push 需 `git -c http.proxy=socks5h://127.0.0.1:10808 push ...`；gh 需 env HOME/USERPROFILE=C:\Users\77182、APPDATA=C:\Users\77182\AppData\Roaming、HTTPS_PROXY=socks5://127.0.0.1:10808（凭据在 AppData\Roaming\GitHub CLI\hosts.yml）。
- run_code 的 process.env 起始为空：selftest（ensurePrivateDirectory 需要 USERNAME/SystemRoot；src/cli/selftest.ts:55 的 os.tmpdir() 需要 TEMP）与 git commit（无 user.name/email）都会失败——显式传 env。
- git 身份：CometDash77 <anastasiiaprinling@gmail.com>（用 `git -c user.name=... -c user.email=...` 或从 git log 取）。
- gh api 传 body 用 --field（promisified execFile 不支持 input 选项，--input - 不可用）。
- PowerShell 跑 pnpm 用 cmd /c 前缀；工具教训：run_code 里 tools.edit 的简写属性必须与解构变量同名；tools.grep 的 pattern 是 ripgrep 正则，勿过度转义。
