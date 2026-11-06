@echo off
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b 1
cd /d "%~dp0"
if not exist bin mkdir bin
cl /nologo /std:c++17 /EHsc /O2 /MT /utf-8 /DUNICODE /D_UNICODE /Fo:bin\ /Fe:bin\Instalar-pdLink.exe installer.cpp /link /SUBSYSTEM:WINDOWS urlmon.lib shell32.lib user32.lib
exit /b %errorlevel%
