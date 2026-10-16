@echo off
rem Builds PCRemote.exe (the launcher) from source with the .NET Framework
rem csc.exe that ships with Windows. Close PC Remote first: a running
rem PCRemote.exe cannot be overwritten.
setlocal
cd /d "%~dp0"
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (echo csc.exe not found. & pause & exit /b 1)

"%CSC%" /nologo /noconfig /target:exe /r:System.dll /out:NetstatTest.exe NetstatTest.cs Netstat.cs || goto fail
NetstatTest.exe || goto fail
del NetstatTest.exe

"%CSC%" /nologo /noconfig /target:winexe /platform:anycpu /optimize+ /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /win32icon:..\runtime\agent\icon.ico /win32manifest:app.manifest /out:..\PCRemote.exe PCRemote.cs Netstat.cs || goto fail
echo Built ..\PCRemote.exe
pause
exit /b 0
:fail
echo Build failed. If PCRemote.exe is running, close it from the tray and try again.
pause
exit /b 1
