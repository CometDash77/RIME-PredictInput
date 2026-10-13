param([Parameter(Mandatory = $true)][string]$Root)
$ErrorActionPreference = 'Stop'
$expectedRoot = [IO.Path]::GetFullPath((Join-Path $env:ProgramData 'RimePredictInstaller'))
$resolvedRoot = [IO.Path]::GetFullPath($Root)
if (-not [string]::Equals($expectedRoot, $resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Unexpected installer cache location'
}
function Assert-Unlinked([string]$LiteralPath) {
    if (-not (Test-Path -LiteralPath $LiteralPath)) { return }
    $item = Get-Item -LiteralPath $LiteralPath -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Refusing linked installer cache'
    }
    if ($item.PSIsContainer) {
        foreach ($child in Get-ChildItem -LiteralPath $LiteralPath -Force) {
            Assert-Unlinked $child.FullName
        }
    }
}
# Verify ancestors without enumerating ProgramData or the system drive.
$ancestor = [IO.Path]::GetDirectoryName($resolvedRoot)
while ($ancestor) {
    if (Test-Path -LiteralPath $ancestor) {
        $item = Get-Item -LiteralPath $ancestor -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked cache ancestor' }
    }
    $nextAncestor = [IO.Path]::GetDirectoryName($ancestor)
    if ($nextAncestor -eq $ancestor) { break }
    $ancestor = $nextAncestor
}
Assert-Unlinked $resolvedRoot
exit 0
