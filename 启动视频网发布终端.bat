@echo off
cd /d "%~dp0"
set NODE_EXE=%~dp0node.exe
if not exist "%NODE_EXE%" set NODE_EXE=node

title 视汇 - 视频网数据采集与发布终端 (v0.22.0)
:loop
echo ===================================================
echo   正在启动 [视汇 - 视频网数据采集/发布终端] ...
echo   服务端口: 5001
echo ===================================================
"%NODE_EXE%" packages/collector/server.js
echo.
echo 服务正在自动重启/重新加载...
timeout /t 3 /nobreak >nul
goto loop
