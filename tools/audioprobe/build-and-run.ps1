# Compile AudioProbe.cs with the csc.exe that ships with Windows (.NET 4.x)
# and run it. Play music/YouTube on the PC first.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { throw "csc.exe tidak ditemukan: $csc" }
& $csc /nologo /platform:x64 /optimize /out:AudioProbe.exe AudioProbe.cs
if ($LASTEXITCODE -ne 0) { throw "Kompilasi gagal" }
.\AudioProbe.exe
