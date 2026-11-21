param(
  [int]$ParentPid,
  [string]$Icon,
  [string]$Dashboard = "http://127.0.0.1:18765/"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Send-Cmd([string]$cmd) {
  [Console]::Out.WriteLine($cmd)
  [Console]::Out.Flush()
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Text = "PC Remote"
if ($Icon -and (Test-Path -LiteralPath $Icon)) {
  $notify.Icon = New-Object System.Drawing.Icon($Icon)
} else {
  $notify.Icon = [System.Drawing.SystemIcons]::Application
}
$notify.Visible = $true

# Dashboard as its own app window (Chromium --app: no tabs / address bar):
# Edge first, then any Chromium browser registered in App Paths (Chrome,
# Helium, Brave...). A normal browser tab only when none is found.
$appPaths = foreach ($exe in 'msedge.exe', 'chrome.exe', 'brave.exe') {
  foreach ($hive in 'HKCU', 'HKLM') {
    try { (Get-ItemProperty "${hive}:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$exe" -ErrorAction Stop).'(default)' } catch {}
  }
}
$script:Edge = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
) + @($appPaths) + @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { $_ -and (Test-Path -LiteralPath ($_.Trim('"'))) } | ForEach-Object { $_.Trim('"') } | Select-Object -First 1
function Open-Dashboard {
  if ($script:Edge) {
    Start-Process -FilePath $script:Edge -ArgumentList @("--app=$Dashboard", "--window-size=1100,820")
  } else {
    Start-Process $Dashboard
  }
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add("Open dashboard")
$openItem.add_Click({ Open-Dashboard })
$ghItem = $menu.Items.Add("PCRemote di GitHub")
$ghItem.add_Click({ Start-Process "https://github.com/rfibyzan/PCRemote" })
[void]$menu.Items.Add("-")
$closeItem = $menu.Items.Add("Close PC Remote")
$closeItem.add_Click({
  Send-Cmd "EXIT"
  $notify.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})
$notify.ContextMenuStrip = $menu
$notify.add_MouseClick({
  param($src, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    Open-Dashboard
  }
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1500
$timer.add_Tick({
  if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
    $notify.Visible = $false
    [System.Windows.Forms.Application]::Exit()
  }
})
$timer.Start()

try {
  [System.Windows.Forms.Application]::Run()
} finally {
  $timer.Stop()
  $notify.Visible = $false
  $notify.Dispose()
}
