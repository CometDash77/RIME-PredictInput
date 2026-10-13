# PROTOTYPE — powershell WM_COPYDATA bridge (fallback channel for node forms without FFI). Throwaway.
param(
  [string]$Class = "WeaselIPCWindow_1.0",
  [long]$Id = 0x52504D31,
  [Parameter(Mandatory=$true)][string]$Payload
)
$sig = @'
[StructLayout(LayoutKind.Sequential)] public struct COPYDATASTRUCT { public UIntPtr dwData; public uint cbData; public IntPtr lpData; }
[DllImport("user32.dll", EntryPoint="SendMessageTimeoutW")] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder name, int max);
'@
Add-Type -MemberDefinition $sig -Name U32 -Namespace Proto | Out-Null
# NOTE: FindWindowW returns 0 for the mock receiver window from inside powershell
# (measured; bun:ffi/node find it fine), so locate the window by enumerating and
# matching the class name exactly.
$script:hwnd = [IntPtr]::Zero
$cb = [Proto.U32+EnumWindowsProc]{ param($h, $l)
  $sb = New-Object System.Text.StringBuilder 256
  [Proto.U32]::GetClassName($h, $sb, 256) | Out-Null
  if ($sb.ToString() -eq $Class) { $script:hwnd = $h; return $false }
  return $true
}
[Proto.U32]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
$hwnd = $script:hwnd
if ($hwnd -eq [IntPtr]::Zero) { Write-Output ('{"found":false}'); exit 0 }
$bytes = [System.Text.Encoding]::UTF8.GetBytes($Payload + [char]0)
$payloadPtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
[System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $payloadPtr, $bytes.Length)
$cds = New-Object Proto.U32+COPYDATASTRUCT
$cds.dwData = [UIntPtr][uint64]$Id
$cds.cbData = $bytes.Length
$cds.lpData = $payloadPtr
$cdsPtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal([System.Runtime.InteropServices.Marshal]::SizeOf($cds))
[System.Runtime.InteropServices.Marshal]::StructureToPtr($cds, $cdsPtr, $false)
$result = [UIntPtr]::Zero
$ok = [Proto.U32]::SendMessageTimeout($hwnd, 0x004A, [UIntPtr]::Zero, $cdsPtr, 3, 300, [ref]$result)
[System.Runtime.InteropServices.Marshal]::FreeHGlobal($payloadPtr)
[System.Runtime.InteropServices.Marshal]::FreeHGlobal($cdsPtr)
Write-Output ('{"found":true,"sent":' + ($ok -ne [IntPtr]::Zero).ToString().ToLower() + ',"delivered":' + $result.ToUInt64() + '}')
