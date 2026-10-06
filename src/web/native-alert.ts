/**
 * 面向用户的原生提示框。
 *
 * 旧实现直接调 `ctypes.windll.user32.MessageBoxW`。Node 没有 FFI，这里退一步用一次性
 * 的 PowerShell 调用现出一个 MessageBox：只有出错路径才会走到，代价可以接受；消息通过
 * 环境变量传递，避免拼命令行时的引号注入。任何失败都退回 stderr。
 */
import { spawnSync } from "node:child_process";

export const ALERT_TITLE = "模型预测设置";

const POWERSHELL_SCRIPT =
  "$null=[System.Windows.Forms.MessageBox]::Show($env:RIME_MODEL_PREDICT_ALERT,'" +
  ALERT_TITLE +
  "','OK','Error')";

export function showNativeAlert(message: string): void {
  if (process.platform === "win32") {
    try {
      const result = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", POWERSHELL_SCRIPT],
        {
          env: { ...process.env, RIME_MODEL_PREDICT_ALERT: message },
          stdio: "ignore",
          windowsHide: true,
        },
      );
      if (result.error === undefined && result.status === 0) return;
    } catch {
      // 落到下面的 stderr 分支。
    }
  }
  process.stderr.write(message + "\n");
}
