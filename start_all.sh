#!/bin/bash
# 视汇 (VFusion) Linux / 国产信创环境一键启动脚本 (v0.25.0)

echo "==================================================="
echo " 视汇 (VFusion) 通用跨隔离网数据交换与汇聚中台"
echo "==================================================="

echo "[1/2] 启动视频网数据采集/发布终端 (Port 5001)..."
nohup npm run start:collector > logs_collector.log 2>&1 &

echo "[2/2] 启动内网数据汇聚与管理中台 (Port 5002)..."
nohup npm run start:core > logs_core.log 2>&1 &

sleep 2
echo "==================================================="
echo " ✅ 视汇 (VFusion) 服务启动完成！"
echo "  视频网发布终端: http://localhost:5001"
echo "  内网汇聚中台: http://localhost:5002"
echo "==================================================="
