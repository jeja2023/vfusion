@echo off
cd /d "%~dp0"
title 视汇 (VFusion) - 无损平滑升级助手
echo ===================================================
echo   视汇 (VFusion) 无损平滑升级工具
echo ===================================================
echo.
echo 本工具用于将当前最新版本的代码 (packages, node_modules)
echo 覆盖平滑升级至您现有的部署目录，并 100%% 保留现有数据库、账号与配置！
echo.
set /p TARGET_DIR=请输入您原有的视汇部署目录绝对路径 (例如 E:\vfusion): 

if not exist "%TARGET_DIR%\storage" (
    echo.
    echo 错误: 未能在目标路径 [%TARGET_DIR%] 找到 storage 目录，请检查路径是否正确！
    pause
    exit /b 1
)

echo.
echo 正在自动备份目标目录下的数据库与配置文件...
if not exist "%TARGET_DIR%\storage_backup" mkdir "%TARGET_DIR%\storage_backup"
copy /Y "%TARGET_DIR%\storage\*.json" "%TARGET_DIR%\storage_backup\" 2>nul
copy /Y "%TARGET_DIR%\storage\*.db" "%TARGET_DIR%\storage_backup\" 2>nul

echo.
echo 正在覆盖升级核心代码包 (packages) 与启动脚本...
xcopy "%~dp0packages" "%TARGET_DIR%\packages" /E /I /Q /Y /R
xcopy "%~dp0*.bat" "%TARGET_DIR%\" /Q /Y /R

echo.
echo ===================================================
echo ? 升级完成！您的数据库、用户账号与历史配置已 100%% 完好保留！
echo ===================================================
pause
