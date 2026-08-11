@echo off
@chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
if exist "%~dp0node.exe" (
  set "NODE_BIN=%~dp0node.exe"
) else (
  set "NODE_BIN=node"
)

title 视汇 (VFusion v0.10.0) - 一键双端服务启动器
echo ===================================================
echo   视汇通用跨隔离网数据交换与汇聚中台 (v0.10.0)
echo ===================================================
echo 1. 正在启动 [视频网数据采集/发布终端] (Port 4001)...
start "视汇-视频网发布终端(4001)" cmd /k ""!NODE_BIN!" packages/collector/server.js"
echo 2. 正在启动 [内网数据汇聚与管理中台] (Port 4002)...
start "视汇-内网数据汇聚与管理中台(4002)" cmd /k ""!NODE_BIN!" packages/core/server.js"
echo.
echo 双端服务已在后台启动完成！
echo - 本机视频网终端: http://localhost:4001
echo - 本机内网中台: http://localhost:4002
echo.
pause
