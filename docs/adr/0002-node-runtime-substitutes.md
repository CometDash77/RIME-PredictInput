# ADR 0002：纯 Node 运行时里对两处 Win32 设施的替代

- 状态：已采纳（2026-10-06）
- 背景：旧伴随进程是 Python + ctypes + `subprocess`，可以直接用 Win32 API。Node 没有 FFI。

## 单实例：命名互斥体 → 锁文件

旧实现 `CreateMutexW("Local\\RimeModelPredict.Sidecar")`，`ERROR_ALREADY_EXISTS` 时第二实例
静默退出（返回 0）。新实现写成应用目录下的锁文件 + 持有者存活检查
（`process.kill(pid, 0)`）：文件已被占用且持有者还活着 → 视为已在运行；持有者已死
（崩溃残留）→ 删除后重试一次。

代价：锁在进程被强杀后需要一次清理（已由存活检查覆盖）；好处是不依赖平台 API，
且行为可在测试里重放。

## 原生提示框：ctypes MessageBoxW → PowerShell 包装

设置入口在「起不来/打不开浏览器」时要弹一个系统提示框。新实现让
`powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden` 调
`[System.Windows.Forms.MessageBox]::Show(...)`，文案经环境变量
`RIME_MODEL_PREDICT_ALERT` 传递（避免引号注入）；失败或非 Windows 退回 stderr。

代价：多一次进程启动（只在错误路径上），且依赖 Windows 自带的 PowerShell。
