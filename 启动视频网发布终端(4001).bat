@echo off
setlocal
cd /d "%~dp0"

if exist "%~dp0node.exe" (
  set "NODE_BIN=%~dp0node.exe"
) else (
  set "NODE_BIN=node"
)

title 视汇 - 视频网数据采集与发布终端 (v0.10.0)
echo ===================================================
echo   正在启动 [视汇 - 视频网数据采集/发布终端] ...
echo   端口: 4001
echo ===================================================
"%NODE_BIN%" packages/collector/server.js
pause
