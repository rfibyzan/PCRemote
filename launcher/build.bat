@echo off
rem Builds PCRemote.exe (the launcher) from source with the .NET Framework
rem csc.exe that ships with Windows. PC Remote may keep running: the old
rem PCRemote.exe is moved to PCRemote.old.exe. "build.bat run" also starts
rem the new one, which replaces the running PC Remote.
setlocal
cd /d "%~dp0"
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (echo csc.exe not found. & pause & exit /b 1)

"%CSC%" /nologo /noconfig /target:exe /r:System.dll /out:NetstatTest.exe NetstatTest.cs Netstat.cs || goto fail
NetstatTest.exe || goto fail
del NetstatTest.exe

rem A running PCRemote.exe cannot be overwritten, but it can be renamed:
rem move it aside so you can rebuild while remoting in through PC Remote.
if exist ..\PCRemote.old.exe del /q ..\PCRemote.old.exe >nul 2>&1
if exist ..\PCRemote.exe move /y ..\PCRemote.exe ..\PCRemote.old.exe >nul || goto fail

"%CSC%" /nologo /noconfig /target:winexe /platform:anycpu /optimize+ /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /win32icon:..\runtime\agent\icon.ico /win32manifest:app.manifest /out:..\PCRemote.exe PCRemote.cs Netstat.cs || goto fail
echo Built ..\PCRemote.exe
rem "build.bat run": start the new launcher now. It replaces the running
rem PC Remote (old launcher + agent) by itself; phones reconnect in seconds.
if /i "%~1"=="run" (start "" "..\PCRemote.exe" & exit /b 0)
pause
exit /b 0
:fail
if not exist ..\PCRemote.exe if exist ..\PCRemote.old.exe move /y ..\PCRemote.old.exe ..\PCRemote.exe >nul
echo Build failed.
pause
exit /b 1
