/**
 * koffi 完成通知发送端（ADR 0001 端口）的实机对照测试。
 *
 * 接收端是测试进程自己用 koffi 注册的窗口类（#9 P7 的 mock receiver 方法）：
 * SendMessageTimeoutW 对同线程窗口是重入直调，因此不需要消息泵。与真实 Weasel
 * 窗口的互操作属真机验收（prototype REPORT §11 遗留项），不进自动化套件——
 * 所以 mock receiver 用真实类名 WeaselIPCWindow_1.0 顶替时，先枚举确认真
 * Weasel 不在场，在场就让 e2e 用例跳过，绝不往真窗口里灌测试载荷。
 *
 * 这里锁住的契约：COPYDATA_ID、载荷三段 ID、cbData 计入终止 NUL、找不到窗口
 * 安静返回 false、非法通知不发出。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import koffi from "koffi";

import {
  WEASEL_COPYDATA_ID,
  WEASEL_WINDOW_CLASS,
  messengerCompletionNotifier,
  type NativeWindowMessenger,
} from "../src/runtime/completion-notify.js";
import { createWeaselWindowMessenger } from "../src/runtime/weasel-messenger-koffi.js";

const WM_COPYDATA = 0x004a;

/** 独享类名挂 pid：窗口类注册是进程级全局，重复注册会撞 ERROR_CLASS_ALREADY_EXISTS。 */
const privateClass = "WeaselIPCWindow_1.0.test-" + String(process.pid);

interface CopyDataHit {
  dwData: bigint;
  cbData: number;
  bytes: Buffer;
}
const received: CopyDataHit[] = [];

koffi.proto("TestWeaselReceiverWndProc", "int64", ["uint64", "uint32", "uint64", "void *"]);
const wndProcPtr = koffi.pointer("TestWeaselReceiverWndProc");
const WNDCLASS = koffi.struct("TestWeaselReceiverWNDCLASSW", {
  style: "uint32",
  lpfnWndProc: wndProcPtr,
  cbClsExtra: "int32",
  cbWndExtra: "int32",
  hInstance: "uint64",
  hIcon: "uint64",
  hCursor: "uint64",
  hbrBackground: "uint64",
  lpszMenuName: "uint64",
  lpszClassName: "str16",
});

const user32 = koffi.load("user32.dll");
const kernel32 = koffi.load("kernel32.dll");
const defWindowProcW = user32.func("DefWindowProcW", "int64", ["uint64", "uint32", "uint64", "void *"]);
const getModuleHandleW = kernel32.func("GetModuleHandleW", "uint64", ["uint64"]);
const registerClassW = user32.func("RegisterClassW", "uint16", [koffi.pointer(WNDCLASS)]);
const createWindowExW = user32.func("CreateWindowExW", "uint64", [
  "uint32",
  "str16",
  "str16",
  "uint32",
  "int32",
  "int32",
  "int32",
  "int32",
  "uint64",
  "uint64",
  "uint64",
  "uint64",
]);
const destroyWindow = user32.func("DestroyWindow", "bool", ["uint64"]);
// koffi 解码结构体指针字段一律得 undefined，抄载荷走 RtlMoveMemory。
const rtlMoveMemory = kernel32.func("RtlMoveMemory", "void", ["void *", "void *", "uint64"]);
const enumWindows = user32.func("EnumWindows", "bool", [wndProcPtr, "uint64"]);
const getClassNameW = user32.func("GetClassNameW", "int32", ["uint64", "void *", "int32"]);

function findAnyWindowOfClass(windowClass: string): bigint {
  let found = 0n;
  const nameBuf = Buffer.alloc(512);
  const visit = (hwnd: bigint): number => {
    const written = getClassNameW(hwnd, nameBuf, 256);
    if (written > 0 && nameBuf.toString("utf16le", 0, written * 2) === windowClass) {
      found = hwnd;
      return 0;
    }
    return 1;
  };
  enumWindows(visit, 0n);
  return found;
}

function wndProc(hwnd: bigint, msg: number, wParam: bigint, lParam: unknown): bigint {
  if (msg === WM_COPYDATA) {
    const cds = Buffer.from(koffi.decode(lParam, koffi.types.uint8, 24));
    const cbData = cds.readUInt32LE(8);
    const bytes = Buffer.alloc(cbData);
    rtlMoveMemory(bytes, cds.readBigUInt64LE(16), BigInt(cbData));
    received.push({ dwData: cds.readBigUInt64LE(0), cbData, bytes });
    return 1n; // TRUE：与真实 Weasel fork 的接收侧一致
  }
  return defWindowProcW(hwnd, msg, wParam, lParam);
}

function mustMessenger(): NativeWindowMessenger {
  const messenger = createWeaselWindowMessenger();
  if (messenger === null) throw new Error("win32 上 koffi messenger 必须可用");
  return messenger;
}

describe.skipIf(process.platform !== "win32")("koffi Weasel messenger", () => {
  let registeredCb: ReturnType<typeof koffi.register>;
  let privateHwnd = 0n;
  let weaselSlotHwnd = 0n;
  /** 真 Weasel 在场时不顶替真类名，e2e 用例跳过。 */
  let realWeaselPresent = false;

  beforeAll(() => {
    received.length = 0;
    registeredCb = koffi.register(wndProc, wndProcPtr);
    const makeWindow = (className: string): bigint => {
      const atom = registerClassW({
        style: 0,
        lpfnWndProc: registeredCb,
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: getModuleHandleW(0n),
        hIcon: 0n,
        hCursor: 0n,
        hbrBackground: 0n,
        lpszMenuName: 0n,
        lpszClassName: className,
      });
      expect(atom).toBeTruthy();
      const hwnd = createWindowExW(
        0,
        className,
        "vitest mock receiver",
        0,
        0,
        0,
        0,
        0,
        0n,
        0n,
        getModuleHandleW(0n),
        0n,
      );
      expect(hwnd).not.toBe(0n);
      return hwnd;
    };
    privateHwnd = makeWindow(privateClass);
    realWeaselPresent = findAnyWindowOfClass(WEASEL_WINDOW_CLASS) !== 0n;
    if (!realWeaselPresent) weaselSlotHwnd = makeWindow(WEASEL_WINDOW_CLASS);
  });

  afterAll(() => {
    if (privateHwnd !== 0n) destroyWindow(privateHwnd);
    if (weaselSlotHwnd !== 0n) destroyWindow(weaselSlotHwnd);
    koffi.unregister(registeredCb);
  });

  it("找不到目标窗口类时安静返回 false", () => {
    expect(mustMessenger().send("NoSuchWindowClass_" + String(process.pid), WEASEL_COPYDATA_ID, "a\nb\n1", 50)).toBe(false);
    expect(received).toHaveLength(0);
  });

  it("把三段 ID 载荷投递给同名窗口（同线程重入）", () => {
    received.length = 0;
    const engineId = "e".repeat(40);
    const requestId = "r".repeat(32);
    const payload = engineId + "\n" + requestId + "\n7";
    expect(mustMessenger().send(privateClass, WEASEL_COPYDATA_ID, payload, 300)).toBe(true);
    expect(received).toHaveLength(1);
    const hit = received[0];
    expect(hit).toBeDefined();
    expect(hit?.dwData).toBe(BigInt(WEASEL_COPYDATA_ID));
    expect(hit?.cbData).toBe(Buffer.byteLength(payload, "utf8") + 1);
    expect(hit?.bytes.toString("utf8")).toBe(payload + "\u0000");
  });

  it("messengerCompletionNotifier 只放行合法通知，载荷逐字一致", (ctx) => {
    if (realWeaselPresent) {
      ctx.skip();
      return;
    }
    const notifier = messengerCompletionNotifier(mustMessenger());
    received.length = 0;
    expect(notifier({ engineId: "a".repeat(40), requestId: "b".repeat(32), sequence: 9 })).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]?.bytes.toString("utf8")).toBe("a".repeat(40) + "\n" + "b".repeat(32) + "\n9\u0000");

    // 非法载荷不出门（40/32 位 hex 门控 + 正整数 seq）。
    received.length = 0;
    expect(notifier({ engineId: "short", requestId: "r".repeat(32), sequence: 9 })).toBe(false);
    expect(notifier({ engineId: "e".repeat(40), requestId: "nothex", sequence: 9 })).toBe(false);
    expect(notifier({ engineId: "e".repeat(40), requestId: "r".repeat(32), sequence: 0 })).toBe(false);
    expect(received).toHaveLength(0);
  });
});
