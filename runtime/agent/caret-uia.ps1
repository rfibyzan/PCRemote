# Caret position through UI Automation, for apps without a Win32 caret
# (Chrome, Edge, Office, VS Code / Electron). Started by src/caretread.js.
# Protocol: read one line ("q <n>") on stdin, answer one JSON line on stdout:
# {"n":<n>,"x":..,"y":..,"w":..,"h":..} in screen pixels, or {"n":<n>}.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;
public static class CaretDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(System.IntPtr value);
}
"@
# Physical pixels, per monitor, like the agent (PER_MONITOR_AWARE_V2 = -4);
# older Windows falls back to system-aware.
try {
  if (-not [CaretDpi]::SetProcessDpiAwarenessContext([System.IntPtr](-4))) { [void][CaretDpi]::SetProcessDPIAware() }
} catch { [void][CaretDpi]::SetProcessDPIAware() }

$TextPat = [System.Windows.Automation.TextPattern]::Pattern
$Char = [System.Windows.Automation.Text.TextUnit]::Character

function Get-CaretJson($n) {
  $none = '{"n":' + $n + '}'
  try {
    $el = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($null -eq $el) { return $none }
    $pat = $null
    if (-not $el.TryGetCurrentPattern($TextPat, [ref]$pat)) { return $none }
    $sel = $pat.GetSelection()
    if ($null -eq $sel -or $sel.Length -lt 1) { return $none }
    $range = $sel[0]
    $rects = $range.GetBoundingRectangles()
    $useLeft = $false
    if ($null -eq $rects -or $rects.Length -lt 1) {
      # Empty selection (a plain caret) has no box: take the next character's.
      $range = $range.Clone()
      [void]$range.ExpandToEnclosingUnit($Char)
      $rects = $range.GetBoundingRectangles()
      $useLeft = $true
    }
    if ($null -eq $rects -or $rects.Length -lt 1) { return $none }
    $r = $rects[$rects.Length - 1]
    if ($r.Height -le 0) { return $none }
    $x = if ($useLeft) { $r.Left } else { $r.Right }
    return ('{{"n":{3},"x":{0},"y":{1},"w":1,"h":{2}}}' -f [int]$x, [int]$r.Top, [int]$r.Height, $n)
  } catch {
    return $none
  }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $n = 0
  if ($line -match '^q\s+(\d+)') { $n = [int]$Matches[1] }
  [Console]::Out.WriteLine((Get-CaretJson $n))
  [Console]::Out.Flush()
}
