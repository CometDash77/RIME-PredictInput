$src = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
namespace ProtoD {
  public class U32 {
[DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="FindWindowW", SetLastError=true)] public static extern IntPtr FindWindowExplicitW(string c, string w);
[DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr FindWindowPlain(string c, string w);
public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
[StructLayout(LayoutKind.Sequential)] public struct COPYDATASTRUCT { public UIntPtr dwData; public uint cbData; public IntPtr lpData; }
[DllImport("user32.dll", EntryPoint="SendMessageTimeoutW")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr wp, IntPtr lp, uint f, uint t, out UIntPtr r);
  }
}
'@
Add-Type -TypeDefinition $src
"plain:     " + [ProtoD.U32]::FindWindowPlain("WeaselIPCWindow_1.0", $null)
"explicitW: " + [ProtoD.U32]::FindWindowExplicitW("WeaselIPCWindow_1.0", $null)
$script:hit = [IntPtr]::Zero
$cb = [ProtoD.U32+EnumWindowsProc]{ param($h, $l)
  $sb = New-Object System.Text.StringBuilder 256
  [ProtoD.U32]::GetClassName($h, $sb, 256) | Out-Null
  if ($sb.ToString() -eq "WeaselIPCWindow_1.0") { $script:hit = $h; return $false }
  return $true
}
[ProtoD.U32]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
"enum hwnd: " + $script:hit
if ($script:hit -ne [IntPtr]::Zero) {
  $payload = "ps-enum" + [char]10 + "req-1" + [char]10 + "1"
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload + [char]0)
  $pp = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
  [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $pp, $bytes.Length)
  $cds = New-Object ProtoD.U32+COPYDATASTRUCT
  $cds.dwData = [UIntPtr][uint64]0x52504D31
  $cds.cbData = $bytes.Length
  $cds.lpData = $pp
  $cp = [System.Runtime.InteropServices.Marshal]::AllocHGlobal([System.Runtime.InteropServices.Marshal]::SizeOf($cds))
  [System.Runtime.InteropServices.Marshal]::StructureToPtr($cds, $cp, $false)
  $res = [UIntPtr]::Zero
  $ok = [ProtoD.U32]::SendMessageTimeout($script:hit, 0x004A, [UIntPtr]::Zero, $cp, 3, 300, [ref]$res)
  "enum-send: ok=" + ($ok -ne [IntPtr]::Zero) + " delivered=" + $res.ToUInt64()
  [System.Runtime.InteropServices.Marshal]::FreeHGlobal($pp); [System.Runtime.InteropServices.Marshal]::FreeHGlobal($cp)
}