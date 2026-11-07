@echo off
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b 1
cd /d "%~dp0"
if not exist bin mkdir bin
cl /nologo /std:c++17 /EHsc /O2 /permissive- /utf-8 /DUNICODE /D_UNICODE /Fo:bin\ /Fe:bin\golive-helper-p15.exe main.cpp guids.cpp /link windowsapp.lib d3d11.lib dxgi.lib mfplat.lib mfreadwrite.lib mfuuid.lib mmdevapi.lib ole32.lib user32.lib dwmapi.lib windowscodecs.lib shell32.lib
exit /b %errorlevel%
