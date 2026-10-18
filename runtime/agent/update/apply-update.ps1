# apply-update.ps1: second half of the dashboard's "Perbarui sekarang".
# src/updater.js downloads and unpacks the release into -Stage, copies this
# script next to it, starts it detached and then exits with code 0 (so
# PCRemote.exe / start.bat close instead of restarting the agent).
#
# Here, with nothing of PC Remote running any more:
#   1. wait for the agent (and the launcher of this folder) to exit
#   2. runtime\agent -> runtime\agent.old, PCRemote.exe -> PCRemote.old.exe
#   3. copy the new files in (runtime\*.exe only when the zip has them)
#   4. any error: put the old files back (rollback)
#   5. start PC Remote again the way it was started (PCRemote.exe or start.bat)
# Settings, pairing and devices live in %APPDATA%\PCRemote and are untouched.
# Log: <folder>\update.log
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][string]$Stage,
  [int]$AgentPid = 0,
  [string]$Tag = "",
  [ValidateSet("exe", "bat")][string]$Relaunch = "exe"
)
$ErrorActionPreference = "Stop"
$log = Join-Path $Root "update.log"
function Log([string]$m) {
  try { Add-Content -LiteralPath $log -Value ("[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $m) } catch { }
}
function Retry([scriptblock]$what, [string]$label) {
  for ($i = 1; $i -le 20; $i++) {
    try { & $what; return } catch {
      if ($i -eq 20) { throw "$label gagal: $($_.Exception.Message)" }
      Start-Sleep -Milliseconds 500
    }
  }
}
function SamePath([string]$a, [string]$b) {
  return [string]::Equals([IO.Path]::GetFullPath($a), [IO.Path]::GetFullPath($b), [StringComparison]::OrdinalIgnoreCase)
}

Log "Memperbarui ke $Tag (folder $Root)"
$exe = Join-Path $Root "PCRemote.exe"
$oldExe = Join-Path $Root "PCRemote.old.exe"
$runtime = Join-Path $Root "runtime"
$agent = Join-Path $runtime "agent"
$bak = Join-Path $runtime "agent.old"
$newAgent = Join-Path $Stage "runtime\agent"

# 1. Wait for PC Remote of THIS folder to stop (exit 0 closes the launcher too).
if ($AgentPid -gt 0) { try { Wait-Process -Id $AgentPid -Timeout 30 -ErrorAction SilentlyContinue } catch { } }
$deadline = (Get-Date).AddSeconds(20)
while ($true) {
  $mine = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $p = $null; try { $p = $_.Path } catch { }
    $p -and ((SamePath $p $exe) -or $p.StartsWith($runtime + "\", [StringComparison]::OrdinalIgnoreCase))
  })
  if ($mine.Count -eq 0) { break }
  if ((Get-Date) -gt $deadline) {
    Log ("Menghentikan paksa: " + (($mine | ForEach-Object { "$($_.ProcessName)#$($_.Id)" }) -join ", "))
    $mine | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    break
  }
  Start-Sleep -Milliseconds 500
}

$movedAgent = $false
$movedExe = $false
$ok = $false
try {
  if (-not (Test-Path -LiteralPath (Join-Path $newAgent "src\index.js"))) { throw "Paket pembaruan tidak lengkap" }
  # 2. Keep the current version as a backup (one level).
  if (Test-Path -LiteralPath $bak) { Retry { Remove-Item -LiteralPath $bak -Recurse -Force } "Hapus agent.old" }
  Retry { Move-Item -LiteralPath $agent -Destination $bak } "Pindah runtime\agent"
  $movedAgent = $true
  $newExe = Join-Path $Stage "PCRemote.exe"
  if ((Test-Path -LiteralPath $newExe) -and (Test-Path -LiteralPath $exe)) {
    if (Test-Path -LiteralPath $oldExe) { Retry { Remove-Item -LiteralPath $oldExe -Force } "Hapus PCRemote.old.exe" }
    Retry { Move-Item -LiteralPath $exe -Destination $oldExe } "Pindah PCRemote.exe"
    $movedExe = $true
  }
  # 3. New files.
  Retry { Copy-Item -LiteralPath $newAgent -Destination $agent -Recurse -Force } "Salin runtime\agent"
  if (Test-Path -LiteralPath $newExe) { Retry { Copy-Item -LiteralPath $newExe -Destination $exe -Force } "Salin PCRemote.exe" }
  foreach ($f in @("HOW-TO.txt", "PCRemote.apk")) {
    $src = Join-Path $Stage $f
    if (Test-Path -LiteralPath $src) { try { Copy-Item -LiteralPath $src -Destination (Join-Path $Root $f) -Force } catch { Log "Lewati ${f}: $($_.Exception.Message)" } }
  }
  foreach ($f in @("node.exe", "cloudflared.exe", "ffmpeg.exe")) {
    $src = Join-Path $Stage "runtime\$f"
    if (Test-Path -LiteralPath $src) { Retry { Copy-Item -LiteralPath $src -Destination (Join-Path $runtime $f) -Force } "Salin $f" }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $agent "src\index.js"))) { throw "index.js tidak ada setelah disalin" }
  $ok = $true
  Log "Berhasil diperbarui ke $Tag"
} catch {
  Log "GAGAL: $($_.Exception.Message) - mengembalikan versi lama"
  # 4. Rollback.
  try {
    if ($movedAgent) {
      if (Test-Path -LiteralPath $agent) { Remove-Item -LiteralPath $agent -Recurse -Force -ErrorAction SilentlyContinue }
      Move-Item -LiteralPath $bak -Destination $agent
    }
    if ($movedExe) {
      if (Test-Path -LiteralPath $exe) { Remove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue }
      Move-Item -LiteralPath $oldExe -Destination $exe
    }
    Log "Versi lama dikembalikan"
  } catch { Log "Rollback gagal: $($_.Exception.Message)" }
}

# Remember the result for the dashboard of the next start.
try {
  $state = @{ tag = $Tag; ok = $ok; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress
  $dir = Join-Path $env:APPDATA "PCRemote"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Set-Content -LiteralPath (Join-Path $dir "update-result.json") -Value $state -Encoding UTF8
} catch { }

# 5. Start PC Remote again.
try {
  if ($Relaunch -eq "exe" -and (Test-Path -LiteralPath $exe)) {
    Start-Process -FilePath $exe -WorkingDirectory $Root
  } else {
    Start-Process -FilePath (Join-Path $agent "start.bat") -WorkingDirectory $agent
  }
  Log "PC Remote dijalankan lagi"
} catch { Log "Gagal menjalankan PC Remote: $($_.Exception.Message)" }

try { Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue } catch { }
