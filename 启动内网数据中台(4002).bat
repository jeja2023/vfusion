@echo off
@chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
if exist "%~dp0node.exe" (
  set "NODE_BIN=%~dp0node.exe"
) else (
  set "NODE_BIN=node"
)

title 视汇 - 内网数据汇聚与管理中台 (v0.10.0)
echo ===================================================
echo   正在启动 [视汇 - 内网数据汇聚与管理中台] ...
echo   端口: 4002
echo ===================================================
"!NODE_BIN!" packages/core/server.js
pause
