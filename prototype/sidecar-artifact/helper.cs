// PROTOTYPE helper for issue #9 sidecar-artifact measurements (throwaway).
// Build: csc /nologo /target:exe /out:helper.exe helper.cs
// Modes: report <outFile> | consoles <outFile> | spawn <outFile> <flags> <exe> [args...]
//        recv <outFile> <ms> | sleep <ms>
// flags: none | no-window | detached | none-nowait | no-window-nowait | detached-nowait
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class Helper
{
    [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
    const uint CREATE_NO_WINDOW = 0x08000000;
    const uint DETACHED_PROCESS = 0x00000008;
    const uint WM_COPYDATA = 0x004A;
    const uint WM_TIMER = 0x0113;

    delegate IntPtr WndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    delegate bool EnumProc(IntPtr h, IntPtr l);
    static WndProc _wndProc; // GC root
    static string _recvFile = "";

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WNDCLASSW
    {
        public uint style; public WndProc lpfnWndProc; public int cbClsExtra; public int cbWndExtra;
        public IntPtr hInstance; public IntPtr hIcon; public IntPtr hCursor; public IntPtr hbrBackground;
        public string lpszMenuName; public string lpszClassName;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct COPYDATASTRUCT { public IntPtr dwData; public uint cbData; public IntPtr lpData; }

    [StructLayout(LayoutKind.Sequential)]
    struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int ptX; public int ptY; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public uint cb; public string reserved; public string desktop; public string title;
        public uint x, y, xs, ys, xcs, ycs; public uint flags; public ushort show; public ushort reserved2;
        public IntPtr reserved3; public IntPtr stdIn, stdOut, stdErr;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public uint pid; public uint tid; }

    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandleW(string name);
    [DllImport("kernel32.dll")] static extern void Sleep(uint ms);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeConsole();
    [DllImport("user32.dll", SetLastError = true)] static extern ushort RegisterClassW(ref WNDCLASSW wc);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateWindowExW(uint exStyle, string cls, string name, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
    [DllImport("user32.dll")] static extern IntPtr DefWindowProcW(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool PostQuitMessage(int code);
    [DllImport("user32.dll")] static extern int GetMessageW(out MSG m, IntPtr h, uint min, uint max);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessageW(ref MSG m);
    [DllImport("user32.dll")] static extern IntPtr SetTimer(IntPtr h, IntPtr id, uint ms, IntPtr cb);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();

    static string J(string s) { var sb = new StringBuilder("\""); foreach (char c in s) { if (c == '"') sb.Append("\\\""); else if (c == '\\') sb.Append("\\\\"); else if (c < 0x20) sb.Append("\\u" + ((int)c).ToString("x4")); else sb.Append(c); } sb.Append("\""); return sb.ToString(); }

    static int Main(string[] args)
    {
        if (args.Length == 0) { Console.Error.WriteLine("usage: report|consoles|spawn|recv|sleep"); return 2; }
        switch (args[0])
        {
            case "report": return CmdReport(args[1]);
            case "consoles": return CmdConsoles(args[1]);
            case "spawn": return CmdSpawn(args);
            case "recv": return CmdRecv(args[1], uint.Parse(args[2]));
            case "sleep": Sleep(uint.Parse(args[1])); return 0;
            default: return 2;
        }
    }

    static int CmdReport(string outFile)
    {
        try
        {
            var h = GetConsoleWindow();
            bool attached = h != IntPtr.Zero;
            bool visible = attached && IsWindowVisible(h);
            File.WriteAllText(outFile, "{\"pid\":" + GetCurrentProcessId() + ",\"attached\":" + (attached ? "true" : "false") + ",\"visible\":" + (visible ? "true" : "false") + "}");
            return 0;
        }
        catch (Exception ex)
        {
            try { File.WriteAllText(outFile + ".err", ex.ToString()); } catch {}
            return 3;
        }
    }

    static int CmdConsoles(string outFile)
    {
        var sb = new StringBuilder();
        int count = 0;
        EnumWindows((h, l) =>
        {
            if (!IsWindowVisible(h)) return true;
            var cn = new StringBuilder(256); GetClassNameW(h, cn, 256);
            string cls = cn.ToString();
            if (cls == "ConsoleWindowClass" || cls == "CASCADIA_HOSTING_WINDOW_CLASS" || cls == "PseudoConsoleWindow")
            {
                var tt = new StringBuilder(256); GetWindowTextW(h, tt, 256);
                if (count > 0) sb.Append(",");
                sb.Append("{\"class\":" + J(cls) + ",\"title\":" + J(tt.ToString()) + "}");
                count++;
            }
            return true;
        }, IntPtr.Zero);
        File.WriteAllText(outFile, "{\"count\":" + count + ",\"windows\":[" + sb.ToString() + "]}");
        return 0;
    }

    static int CmdSpawn(string[] args)
    {
        // spawn <outFile> <flags> <exe> [args...]
        string outFile = args[1]; string flags = args[2]; string exe = args[3];
        bool nowait = flags.EndsWith("-nowait");
        string baseFlags = nowait ? flags.Substring(0, flags.Length - 7) : flags;
        uint cf = 0;
        if (baseFlags == "no-window") cf = CREATE_NO_WINDOW;
        else if (baseFlags == "detached") cf = DETACHED_PROCESS;
        FreeConsole();
        var sb = new StringBuilder(2048);
        sb.Append('"').Append(exe).Append('"');
        for (int i = 4; i < args.Length; i++) { sb.Append(' ').Append('"').Append(args[i]).Append('"'); }
        var si = new STARTUPINFO(); si.cb = (uint)Marshal.SizeOf(si);
        PROCESS_INFORMATION pi;
        if (!CreateProcessW(null, sb, IntPtr.Zero, IntPtr.Zero, false, cf, IntPtr.Zero, null, ref si, out pi))
        {
            File.WriteAllText(outFile, "{\"spawned\":false,\"winError\":" + Marshal.GetLastWin32Error() + "}");
            return 1;
        }
        if (nowait)
        {
            File.WriteAllText(outFile, "{\"spawned\":true,\"pid\":" + pi.pid + ",\"flags\":" + J(flags) + "}");
            CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
            return 0;
        }
        WaitForSingleObject(pi.hProcess, 60000);
        uint code; GetExitCodeProcess(pi.hProcess, out code);
        CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
        File.WriteAllText(outFile, "{\"spawned\":true,\"exitCode\":" + code + ",\"flags\":" + J(flags) + "}");
        return 0;
    }

    static int CmdRecv(string outFile, uint ms)
    {
        _recvFile = outFile;
        _wndProc = WndProcImpl;
        var wc = new WNDCLASSW();
        wc.lpfnWndProc = _wndProc;
        wc.hInstance = GetModuleHandleW(null);
        wc.lpszClassName = "WeaselIPCWindow_1.0";
        ushort atom = RegisterClassW(ref wc);
        if (atom == 0) { File.WriteAllText(outFile, "{\"error\":\"RegisterClassW failed " + Marshal.GetLastWin32Error() + "\"}"); return 1; }
        IntPtr hwnd = CreateWindowExW(0, "WeaselIPCWindow_1.0", "PROTO mock receiver", 0, 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, wc.hInstance, IntPtr.Zero);
        if (hwnd == IntPtr.Zero) { File.WriteAllText(outFile, "{\"error\":\"CreateWindowExW failed " + Marshal.GetLastWin32Error() + "\"}"); return 1; }
        File.WriteAllText(outFile, "{\"ready\":true,\"hwnd\":" + hwnd.ToInt64() + "}\n");
        SetTimer(hwnd, (IntPtr)1, ms, IntPtr.Zero);
        MSG msg;
        while (GetMessageW(out msg, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref msg); DispatchMessageW(ref msg); }
        return 0;
    }

    static IntPtr WndProcImpl(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        if (msg == WM_COPYDATA)
        {
            var cds = (COPYDATASTRUCT)Marshal.PtrToStructure(lParam, typeof(COPYDATASTRUCT));
            byte[] data = new byte[cds.cbData];
            Marshal.Copy(cds.lpData, data, 0, (int)cds.cbData);
            string utf8 = Encoding.UTF8.GetString(data);
            string utf16 = Encoding.Unicode.GetString(data);
            string line = "{\"dwData\":" + cds.dwData.ToInt64() + ",\"cbData\":" + cds.cbData + ",\"utf8\":" + J(utf8) + ",\"utf16\":" + J(utf16) + "}\n";
            File.AppendAllText(_recvFile, line);
            return (IntPtr)1; // TRUE: mirrors the real Weasel fork returning success
        }
        if (msg == WM_TIMER) { DestroyWindow(hwnd); PostQuitMessage(0); return IntPtr.Zero; }
        return DefWindowProcW(hwnd, msg, wParam, lParam);
    }
}
