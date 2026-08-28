@echo off
chcp 65001 >nul
echo ===================================================
echo  视汇 (VFusion) Windows 系统服务开机自启安装工具
echo ===================================================
echo.
echo [1/2] 正在注册 VFusion Collector (端口 5001) 服务...
sc create VFusionCollector binPath= "\"%~dp0..\node.exe\" \"%~dp0..\packages\collector\server.js\"" start= auto displayname= "VFusion Collector Service"

echo [2/2] 正在注册 VFusion Core (端口 5002) 服务...
sc create VFusionCore binPath= "\"%~dp0..\node.exe\" \"%~dp0..\packages\core\server.js\"" start= auto displayname= "VFusion Core Service"

echo.
echo ===================================================
echo  ✅ VFusion 开机自启系统服务注册成功！
echo  可通过 Windows "服务" 控制台 (services.msc) 进行管理。
echo ===================================================
pause
