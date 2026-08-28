@echo off
chcp 65001 > nul
title 视汇 (VFusion) 物理隔离网服务一键启动器 (v0.26.0)

echo ===================================================
echo  视汇 (VFusion) 通用跨隔离网数据交换与汇聚中台
echo ===================================================
echo.
echo 正在启动 视频网数据采集/发布终端 (Port 5001)...
start "VFusion Collector" cmd /k "npm run start:collector"

echo 正在启动 内网数据汇聚与管理中台 (Port 5002)...
start "VFusion Core" cmd /k "npm run start:core"

echo.
echo ===================================================
echo  ✅ 视汇 (VFusion) 所有服务节点已启动！
echo  - 视频网采集端: http://localhost:5001
echo  - 内网数据中台: http://localhost:5002
echo ===================================================
pause
