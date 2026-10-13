
$sig = @'
[DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr FindWindow(string c, string w);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr c, string cls, string w);
'@
Add-Type -MemberDefinition $sig -Name U32D -Namespace ProtoD | Out-Null
$h1 = [ProtoD.U32D]::FindWindow("WeaselIPCWindow_1.0", $null)
"FindWindowW: $h1 err=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
$h2 = [ProtoD.U32D]::FindWindowEx([IntPtr]::Zero, [IntPtr]::Zero, "WeaselIPCWindow_1.0", $null)
"FindWindowExW: $h2 err=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
Add-Type -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(System.EnumWindowsProc cb, IntPtr l);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
'@ -Name U32E -Namespace ProtoD | Out-Null
$cb = [ProtoD.U32E+EnumWindowsProc]{ param($h, $l) $sb = New-Object System.Text.StringBuilder 256; [ProtoD.U32E]::GetClassName($h, $sb, 256) | Out-Null; $cls = $sb.ToString(); if ($cls -like "*Weasel*") { $p = 0; [ProtoD.U32E]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null; Write-Host ("ENUM-HIT: hwnd=$h class=[$cls] pid=$p") }; return $true }
[ProtoD.U32E]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
"enum-done"
