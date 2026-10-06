# ADR 0001：完成通知改成「门控纯逻辑 + 原生发送端口」

- 状态：已采纳（2026-10-06）
- 背景：旧实现 `weasel_refresh.notify_completion(request)` 用 ctypes 调
  `FindWindowW("WeaselIPCWindow_1.0")` + `SendMessageTimeoutW(hwnd, WM_COPYDATA 0x004A, 0,
  &COPYDATASTRUCT(0x52504D31, len, "\n"-joined payload), SMTO_ABORTIFHUNG, 300ms)`。
  这条消息让候选窗在预测结果落盘后**立刻刷新**，用户不必再按一次键。

## 决定

- 「该不该发、发什么」保留为可测的纯函数：`completionPayload` + `isNotifiableNotice`
  （`engine_id` 40 位十六进制、`request_id` 32 位十六进制、`0 < seq`）。
- 「怎么发」抽成端口 `NativeWindowMessenger.send(windowClass, messageId, payload, timeoutMs)`；
  `messengerCompletionNotifier` 适配它。
- 默认实现是 `unsupportedCompletionNotifier`：不发送、返回 `false`。宿主通过
  `SidecarRuntime` 的 `completionNotify` 注入真实实现。

## 后果

- 现在开始到原生助手就位之前，**降级表现 = 预测结果要等下一次按键/输入事件才出现在候选窗**。
  阈值与状态语义不变，只是刷新时机变慢。
- 门控条件（发布成功 + `status === "ok"` + `eligible === true`）保持逐字一致，将来换上真实
  发送端不需要再改调用方。
- 后续实现方式二选一：编译一个小原生助手（沿用旧 `rime_model_predict_launcher.c` 的
  `FindWindowW`+`SendMessageTimeoutW` 逻辑），或改由 Lua 侧在收到响应后自行触发刷新。
