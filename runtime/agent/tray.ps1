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
$notify.Text = "PC Remote · Asphalt Cake"
if ($Icon -and (Test-Path -LiteralPath $Icon)) {
  $notify.Icon = New-Object System.Drawing.Icon($Icon)
} else {
  $notify.Icon = [System.Drawing.SystemIcons]::Application
}
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add("Open dashboard")
$openItem.add_Click({ Start-Process $Dashboard })
$ytItem = $menu.Items.Add("YouTube · Asphalt Cake")
$ytItem.add_Click({ Start-Process "https://www.youtube.com/@AsphaltCake" })
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
    Start-Process $Dashboard
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
