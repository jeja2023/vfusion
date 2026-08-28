@echo off
cd /d "%~dp0"
set NODE_EXE=%~dp0node.exe
if not exist "%NODE_EXE%" set NODE_EXE=node

title 视汇 - 内网数据汇聚与管理中台 (v0.25.0)
:loop
echo ===================================================
echo   正在启动 [视汇 - 内网数据汇聚与管理中台] ...
echo   服务端口: 5002
echo ===================================================
"%NODE_EXE%" packages/core/server.js
echo.
echo 服务正在自动重启/重新加载...
timeout /t 3 /nobreak >nul
goto loop
