/**
 * Weasel 完成通知：告诉前端「这一轮的响应已经落盘」，让候选窗不必等下一次按键。
 *
 * 旧实现用 ctypes 直接调 Win32：
 * ```text
 * hwnd = FindWindowW("WeaselIPCWindow_1.0", None)
 * SendMessageTimeoutW(hwnd, WM_COPYDATA(0x004A), 0, &COPYDATASTRUCT{0x52504D31, payload}, SMTO_ABORTIFHUNG(0x0003), 300)
 * payload = "<engine_id>\n<request_id>\n<seq>"
 * ```
 * 纯 Node 没有 FFI，发不出这条窗口消息。因此这里把「该不该发、发什么」做成
 * 可测试的纯逻辑，把「怎么发」留给 `NativeWindowMessenger` 端口：接上原生助手
 * 或常驻桥接进程后，注入对应实现即可恢复旧行为。默认实现是显式空实现。
 */
import { HEX_32 } from "../json/digest.js";
import { isNotifiableEngineId } from "../domain/ids.js";

export const WEASEL_WINDOW_CLASS = "WeaselIPCWindow_1.0";
export const WEASEL_COPYDATA_ID = 0x5250_4d31;
export const WM_COPYDATA = 0x004a;
export const SMTO_ABORTIFHUNG = 0x0003;
export const WEASEL_SEND_TIMEOUT_MS = 300;

export interface CompletionNotice {
  readonly engineId: string;
  readonly requestId: string;
  readonly sequence: number;
}

export type CompletionNotifier = (notice: CompletionNotice) => boolean;

/** 旧实现的载荷：三段以换行分隔，不含任何用户文本或候选。 */
export function completionPayload(notice: CompletionNotice): string {
  return `${notice.engineId}\n${notice.requestId}\n${notice.sequence}`;
}

/**
 * 旧实现要求 40 位 hex engine id、32 位 hex request id、`0 < seq <= 2**64-1`。
 * JS 数字只能精确表示到 2**53-1，而 IPC 层同样把更大序号判为非法，所以上限取安全整数。
 */
export function isNotifiableNotice(notice: CompletionNotice): boolean {
  return (
    isNotifiableEngineId(notice.engineId) &&
    HEX_32.test(notice.requestId) &&
    Number.isInteger(notice.sequence) &&
    notice.sequence > 0 &&
    notice.sequence <= Number.MAX_SAFE_INTEGER
  );
}

/** 真正发窗口消息的那一层；由原生助手或桥接进程实现。 */
export interface NativeWindowMessenger {
  send(windowClass: string, messageId: number, payload: string, timeoutMs: number): boolean;
}

export function messengerCompletionNotifier(messenger: NativeWindowMessenger): CompletionNotifier {
  return (notice) => {
    if (!isNotifiableNotice(notice)) return false;
    try {
      return messenger.send(WEASEL_WINDOW_CLASS, WEASEL_COPYDATA_ID, completionPayload(notice), WEASEL_SEND_TIMEOUT_MS);
    } catch {
      return false;
    }
  };
}

/**
 * 默认通知器：认下契约但不发送，也不假装成功。
 * 接上原生助手之前的降级表现是「预测结果要等下一次按键才出现」。
 */
export const unsupportedCompletionNotifier: CompletionNotifier = () => false;
