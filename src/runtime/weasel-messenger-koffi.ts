/**
 * koffi 实现的 NativeWindowMessenger（ADR 0001 端口的 Windows 落地）。
 *
 * 与旧 ctypes 行为对齐的字节契约：
 * - 找窗一律 EnumWindows + GetClassNameW 枚举式（FindWindowW 在部分宿主恒 0，
 *   #9 的教训已存档）。
 * - SendMessageTimeoutW(hwnd, WM_COPYDATA(0x004A), 0, &COPYDATASTRUCT{messageId,
 *   cbData, lpData}, SMTO_ABORTIFHUNG(0x0003), timeoutMs)；COPYDATASTRUCT 在 x64
 *   上是 24 字节：u64 dwData、u32 cbData、u64 lpData。
 * - 载荷 = UTF-8 字节 + 一个终止 NUL，cbData 计入 NUL：C 字符串与定长解码两种
 *   接收端都安全。这是 fork 侧契约的一部分（spec #10 用户故事 28）。
 * - koffi 指针尺寸实参必须传 BigInt，传 Number 会以 0xC0000005 崩进程。
 *
 * 任何失败（无窗、被拒、超时）都返回 false：通知只影响刷新时延，绝不影响已
 * 落盘的响应。非 Windows 或 koffi 不可用时 createWeaselWindowMessenger 返回
 * null，宿主保持 unsupportedCompletionNotifier 的降级表现。
 */
import koffi from "koffi";

import type { NativeWindowMessenger } from "./completion-notify.js";

/** COPYDATASTRUCT（x64）：ULONG_PTR dwData、DWORD cbData、PVOID lpData。 */
const CDS_SIZE = 24;
const WM_COPYDATA = 0x004a;
const SMTO_ABORTIFHUNG = 0x0003;

let cached: NativeWindowMessenger | null | undefined;

/**
 * 进程内只初始化一次：user32 加载与 FFI 原型注册都不是可重入操作。
 * 返回 null 表示环境不支持，调用方降级到空实现。
 */
export function createWeaselWindowMessenger(): NativeWindowMessenger | null {
  if (process.platform !== "win32") return null;
  if (cached !== undefined) return cached;
  try {
    cached = buildMessenger();
  } catch {
    cached = null;
  }
  return cached;
}

function buildMessenger(): NativeWindowMessenger {
  const user32 = koffi.load("user32.dll");
  koffi.proto("RimeEnumWindowsProc", "int64", ["uint64", "uint64"]);
  const enumWindows = user32.func("EnumWindows", "bool", [koffi.pointer("RimeEnumWindowsProc"), "uint64"]);
  const getClassNameW = user32.func("GetClassNameW", "int32", ["uint64", "void *", "int32"]);
  const sendMessageTimeoutW = user32.func("SendMessageTimeoutW", "uint64", [
    "uint64",
    "uint32",
    "uint64",
    "void *",
    "uint32",
    "uint32",
    "void *",
  ]);

  /** 按窗口类名枚举顶层窗口，命中即停；找不到返回 0n。 */
  function findWindowByClass(windowClass: string): bigint {
    let found = 0n;
    // 256 个 UTF-16 码元足够容纳真实窗口类名；GetClassNameW 返回写入的码元数。
    const nameBuf = Buffer.alloc(512);
    const visit = (hwnd: bigint): number => {
      const written = getClassNameW(hwnd, nameBuf, 256);
      if (written > 0 && nameBuf.toString("utf16le", 0, written * 2) === windowClass) {
        found = hwnd;
        return 0; // FALSE：停止枚举
      }
      return 1; // TRUE：继续
    };
    enumWindows(visit, 0n);
    return found;
  }

  return {
    send(windowClass: string, messageId: number, payload: string, timeoutMs: number): boolean {
      const hwnd = findWindowByClass(windowClass);
      if (hwnd === 0n) return false;
      // 载荷带终止 NUL，cbData 计入 NUL（fork 侧契约，见模块头注释）。
      const payloadBuf = Buffer.from(payload + "\u0000", "utf8");
      const cds = Buffer.alloc(CDS_SIZE);
      cds.writeBigUInt64LE(BigInt(messageId), 0);
      cds.writeUInt32LE(payloadBuf.length, 8);
      cds.writeBigUInt64LE(koffi.address(payloadBuf), 16);
      const result = Buffer.alloc(8);
      return Boolean(sendMessageTimeoutW(hwnd, WM_COPYDATA, 0n, cds, SMTO_ABORTIFHUNG, timeoutMs, result));
    },
  };
}
