
$src = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
namespace ProtoD {
  public class U32 {
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr FindWindow(string c, string w);
    public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  }
}
'@
Add-Type -TypeDefinition $src
"tray: " + [ProtoD.U32]::FindWindow("Shell_TrayWnd", $null)
"weasel: " + [ProtoD.U32]::FindWindow("WeaselIPCWindow_1.0", $null)
$cb = [ProtoD.U32+EnumWindowsProc]{ param($h, $l)
  $sb = New-Object System.Text.StringBuilder 256
  [ProtoD.U32]::GetClassName($h, $sb, 256) | Out-Null
  $c = $sb.ToString()
  if ($c -like "*Weasel*") { $p = 0; [ProtoD.U32]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null; Write-Host ("ENUM-HIT: hwnd=$h class=[$c] pid=$p") }
  return $true
}
[ProtoD.U32]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
"enum-done"
