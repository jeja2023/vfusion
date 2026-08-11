@echo off
cd /d "%~dp0"
set NODE_EXE=%~dp0node.exe
if not exist "%NODE_EXE%" set NODE_EXE=node

title 视汇 - 内网数据汇聚与管理中台 (v0.11.0)
echo ===================================================
echo   正在启动 [视汇 - 内网数据汇聚与管理中台] ...
echo   端口: 5002
echo ===================================================
"%NODE_EXE%" packages/core/server.js
pause
