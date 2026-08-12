const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const iconv = require('iconv-lite');

const ROOT_DIR = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
const VERSION = pkg.version || '0.16.0';

const RELEASE_DIR = path.join(ROOT_DIR, 'release');

console.log(`=== 开始按部署场景模块化构建 视汇 (VFusion v${VERSION}) 专属发布包 ===\n`);

// 1. 清理并新建 release 目录
try {
  if (fs.existsSync(RELEASE_DIR)) {
    fs.rmSync(RELEASE_DIR, { recursive: true, force: true });
  }
} catch (e) {}
fs.mkdirSync(RELEASE_DIR, { recursive: true });

// Helper: 递归复制目录
function copyDirSync(src, dest, ignoreDirs = []) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (ignoreDirs.includes(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    try {
      const stat = fs.lstatSync(srcPath);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        copyDirSync(srcPath, destPath, ignoreDirs);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    } catch (e) {}
  }
}

// Helper: 复制 node_modules (尝试 xcopy/cp，失败退回到 copyDirSync)
function copyNodeModulesSync(destDir) {
  const destModules = path.join(destDir, 'node_modules');
  try {
    if (process.platform === 'win32') {
      execSync(`xcopy "${path.join(ROOT_DIR, 'node_modules')}" "${destModules}" /E /I /Q /Y /K /R`, { stdio: 'ignore' });
    } else {
      execSync(`cp -R "${path.join(ROOT_DIR, 'node_modules')}" "${destModules}"`, { stdio: 'ignore' });
    }
  } catch (e) {
    copyDirSync(path.join(ROOT_DIR, 'node_modules'), destModules);
  }
}

// Helper: 仅复制 Storage 下的 Schema 模板文件
function copyStorageTemplatesSync(srcStorage, destStorage) {
  if (!fs.existsSync(destStorage)) fs.mkdirSync(destStorage, { recursive: true });
  const subDirs = ['ftp_in', 'ftp_out', 'archive', 'error', 'assets', 'collector_assets'];
  for (const dir of subDirs) {
    fs.mkdirSync(path.join(destStorage, dir), { recursive: true });
  }
  if (fs.existsSync(srcStorage)) {
    const entries = fs.readdirSync(srcStorage, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.startsWith('schema')) {
        fs.copyFileSync(path.join(srcStorage, entry.name), path.join(destStorage, entry.name));
      }
    }
  }
}

function writeBatFileSync(filePath, content) {
  const crlfContent = content.replace(/\r?\n/g, '\r\n');
  const gbkBuffer = iconv.encode(crlfContent, 'gbk');
  fs.writeFileSync(filePath, gbkBuffer);
}

function createZipArchive(sourceDir, zipPath) {
  try {
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    const parentDir = path.dirname(sourceDir);
    const dirName = path.basename(sourceDir);
    execSync(`tar -a -c -f "${zipPath}" -C "${parentDir}" "${dirName}"`, { stdio: 'ignore' });
    const stat = fs.statSync(zipPath);
    return (stat.size / (1024 * 1024)).toFixed(2);
  } catch (e) {
    console.error(`压缩 ${zipPath} 失败:`, e.message);
    return '0';
  }
}

// 共通脚本定义
const batCollectorRun = `@echo off
cd /d "%~dp0"
set NODE_EXE=%~dp0node.exe
if not exist "%NODE_EXE%" set NODE_EXE=node

title 视汇 - 视频网数据采集与发布终端 (v${VERSION})
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
`;

const batCollectorUpgrade = `@echo off
cd /d "%~dp0"
title 视汇 (VFusion) - 视频网采集端无损平滑升级工具
echo ===================================================
echo   视汇 (VFusion) 视频网采集端无损平滑升级工具
echo ===================================================
echo.
echo 本工具用于平滑升级【视频网采集端】最新代码，并 100%% 保留本地数据库与配置！
echo.
set TARGET_DIR=
set /p TARGET_DIR=请输入视汇视频网采集端部署路径 (直接回车默认升级当前目录): 
if "%TARGET_DIR%"=="" set TARGET_DIR=%~dp0
if "%TARGET_DIR:~-1%"=="\\" set TARGET_DIR=%TARGET_DIR:~0,-1%

if not exist "%TARGET_DIR%\\storage" (
    echo.
    echo 错误: 未能在目标路径 [%TARGET_DIR%] 找到 storage 目录，请检查路径是否正确！
    pause
    exit /b 1
)

echo.
echo [1/2] 正在自动备份视频网本地数据库与配置文件...
if not exist "%TARGET_DIR%\\storage_backup" mkdir "%TARGET_DIR%\\storage_backup"
copy /Y "%TARGET_DIR%\\storage\\*.json" "%TARGET_DIR%\\storage_backup\\" 2>nul
copy /Y "%TARGET_DIR%\\storage\\*.db" "%TARGET_DIR%\\storage_backup\\" 2>nul

echo.
echo [2/2] 正在覆盖升级视频网采集端代码...
xcopy "%~dp0packages\\collector" "%TARGET_DIR%\\packages\\collector" /E /I /Q /Y /R
xcopy "%~dp0packages\\common" "%TARGET_DIR%\\packages\\common" /E /I /Q /Y /R
xcopy "%~dp0*.bat" "%TARGET_DIR%\\" /Q /Y /R

echo.
echo ===================================================
echo 🎉 升级完成！您的数据库与提交历史 100%% 完好保留！
echo 请运行 [启动视频网发布终端.bat] 重新启动服务。
echo ===================================================
pause
`;

const batCoreRun = `@echo off
cd /d "%~dp0"
set NODE_EXE=%~dp0node.exe
if not exist "%NODE_EXE%" set NODE_EXE=node

title 视汇 - 内网数据汇聚与管理中台 (v${VERSION})
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
`;

const batCoreUpgrade = `@echo off
cd /d "%~dp0"
title 视汇 (VFusion) - 内网数据中台无损平滑升级工具
echo ===================================================
echo   视汇 (VFusion) 内网数据中台无损平滑升级工具
echo ===================================================
echo.
echo 本工具用于平滑升级【内网数据中台】最新代码，并 100%% 保留本地数据库与配置！
echo.
set TARGET_DIR=
set /p TARGET_DIR=请输入视汇内网数据中台部署路径 (直接回车默认升级当前目录): 
if "%TARGET_DIR%"=="" set TARGET_DIR=%~dp0
if "%TARGET_DIR:~-1%"=="\\" set TARGET_DIR=%TARGET_DIR:~0,-1%

if not exist "%TARGET_DIR%\\storage" (
    echo.
    echo 错误: 未能在目标路径 [%TARGET_DIR%] 找到 storage 目录，请检查路径是否正确！
    pause
    exit /b 1
)

echo.
echo [1/2] 正在自动备份内网中台本地数据库与配置文件...
if not exist "%TARGET_DIR%\\storage_backup" mkdir "%TARGET_DIR%\\storage_backup"
copy /Y "%TARGET_DIR%\\storage\\*.json" "%TARGET_DIR%\\storage_backup\\" 2>nul
copy /Y "%TARGET_DIR%\\storage\\*.db" "%TARGET_DIR%\\storage_backup\\" 2>nul

echo.
echo [2/2] 正在覆盖升级内网数据中台代码...
xcopy "%~dp0packages\\core" "%TARGET_DIR%\\packages\\core" /E /I /Q /Y /R
xcopy "%~dp0packages\\common" "%TARGET_DIR%\\packages\\common" /E /I /Q /Y /R
xcopy "%~dp0*.bat" "%TARGET_DIR%\\" /Q /Y /R

echo.
echo ===================================================
echo 🎉 升级完成！您的数据库与中台配置 100%% 完好保留！
echo 请运行 [启动内网数据中台.bat] 重新启动服务。
echo ===================================================
pause
`;

const batAllRun = `@echo off
cd /d "%~dp0"

title 视汇 (VFusion v${VERSION}) - 一键双端服务启动器
echo ===================================================
echo   视汇通用跨隔离网数据交换与汇聚中台 (v${VERSION})
echo ===================================================
echo 1. 正在启动 [视频网数据采集/发布终端] (Port 5001)...
start "视汇-视频网发布终端" "%~dp0启动视频网发布终端.bat"

echo 2. 正在启动 [内网数据汇聚与管理中台] (Port 5002)...
start "视汇-内网数据中台" "%~dp0启动内网数据中台.bat"

echo.
echo 双端服务已成功启动！
echo - 视频网终端: http://localhost:5001
echo - 内网中台: http://localhost:5002
echo.
pause
`;

const batAllUpgrade = `@echo off
cd /d "%~dp0"
title 视汇 (VFusion) - 双端联合无损升级工具
echo ===================================================
echo   视汇 (VFusion) 双端联合无损升级工具
echo ===================================================
echo.
echo 本工具用于同时升级【视频网采集端】与【内网数据中台】最新代码！
echo.
set TARGET_DIR=
set /p TARGET_DIR=请输入视汇部署目录绝对路径 (直接回车默认升级当前目录): 
if "%TARGET_DIR%"=="" set TARGET_DIR=%~dp0
if "%TARGET_DIR:~-1%"=="\\" set TARGET_DIR=%TARGET_DIR:~0,-1%

if not exist "%TARGET_DIR%\\storage" (
    echo.
    echo 错误: 未能在目标路径 [%TARGET_DIR%] 找到 storage 目录，请检查路径是否正确！
    pause
    exit /b 1
)

echo.
echo [1/2] 正在自动备份数据库与配置文件...
if not exist "%TARGET_DIR%\\storage_backup" mkdir "%TARGET_DIR%\\storage_backup"
copy /Y "%TARGET_DIR%\\storage\\*.json" "%TARGET_DIR%\\storage_backup\\" 2>nul
copy /Y "%TARGET_DIR%\\storage\\*.db" "%TARGET_DIR%\\storage_backup\\" 2>nul

echo.
echo [2/2] 正在覆盖升级双端代码 (packages)...
xcopy "%~dp0packages" "%TARGET_DIR%\\packages" /E /I /Q /Y /R
xcopy "%~dp0*.bat" "%TARGET_DIR%\\" /Q /Y /R

echo.
echo ===================================================
echo 🎉 双端升级完成！数据库与配置 100%% 完好保留！
echo ===================================================
pause
`;

// -------------------------------------------------------------
// 构建 1：视频网采集端专属独立部署包 (vfusion-collector-vX.Y.Z-windows.zip)
// -------------------------------------------------------------
console.log('[1/3] 正在构建【视频网采集端专属包】(vfusion-collector)...');
const collectorDirName = `vfusion-collector-v${VERSION}-windows`;
const collectorDir = path.join(RELEASE_DIR, collectorDirName);
fs.mkdirSync(collectorDir, { recursive: true });

copyDirSync(path.join(ROOT_DIR, 'packages', 'collector'), path.join(collectorDir, 'packages', 'collector'));
copyDirSync(path.join(ROOT_DIR, 'packages', 'common'), path.join(collectorDir, 'packages', 'common'));
copyStorageTemplatesSync(path.join(ROOT_DIR, 'storage'), path.join(collectorDir, 'storage'));
copyNodeModulesSync(collectorDir);

try { fs.copyFileSync(process.execPath, path.join(collectorDir, 'node.exe')); } catch (e) {}
fs.copyFileSync(path.join(ROOT_DIR, 'package.json'), path.join(collectorDir, 'package.json'));
fs.copyFileSync(path.join(ROOT_DIR, 'README.md'), path.join(collectorDir, 'README.md'));
fs.copyFileSync(path.join(ROOT_DIR, '更新日志.md'), path.join(collectorDir, '更新日志.md'));

writeBatFileSync(path.join(collectorDir, '启动视频网发布终端.bat'), batCollectorRun);
writeBatFileSync(path.join(collectorDir, '一键无损升级-视频网发布终端.bat'), batCollectorUpgrade);

const collectorZipPath = path.join(RELEASE_DIR, `${collectorDirName}.zip`);
const collectorSizeMB = createZipArchive(collectorDir, collectorZipPath);

console.log(`✓ 视频网采集端专属包构建完成: ${collectorZipPath} (${collectorSizeMB} MB)\n`);

// -------------------------------------------------------------
// 构建 2：内网数据中台专属独立部署包 (vfusion-core-vX.Y.Z-windows.zip)
// -------------------------------------------------------------
console.log('[2/3] 正在构建【内网数据中台专属包】(vfusion-core)...');
const coreDirName = `vfusion-core-v${VERSION}-windows`;
const coreDir = path.join(RELEASE_DIR, coreDirName);
fs.mkdirSync(coreDir, { recursive: true });

copyDirSync(path.join(ROOT_DIR, 'packages', 'core'), path.join(coreDir, 'packages', 'core'));
copyDirSync(path.join(ROOT_DIR, 'packages', 'common'), path.join(coreDir, 'packages', 'common'));
copyStorageTemplatesSync(path.join(ROOT_DIR, 'storage'), path.join(coreDir, 'storage'));
copyNodeModulesSync(coreDir);

try { fs.copyFileSync(process.execPath, path.join(coreDir, 'node.exe')); } catch (e) {}
fs.copyFileSync(path.join(ROOT_DIR, 'package.json'), path.join(coreDir, 'package.json'));
fs.copyFileSync(path.join(ROOT_DIR, 'README.md'), path.join(coreDir, 'README.md'));
fs.copyFileSync(path.join(ROOT_DIR, '更新日志.md'), path.join(coreDir, '更新日志.md'));

writeBatFileSync(path.join(coreDir, '启动内网数据中台.bat'), batCoreRun);
writeBatFileSync(path.join(coreDir, '一键无损升级-内网数据中台.bat'), batCoreUpgrade);

const coreZipPath = path.join(RELEASE_DIR, `${coreDirName}.zip`);
const coreSizeMB = createZipArchive(coreDir, coreZipPath);

console.log(`✓ 内网数据中台专属包构建完成: ${coreZipPath} (${coreSizeMB} MB)\n`);

// -------------------------------------------------------------
// 构建 3：单机双端集成开发测试包 (vfusion-all-in-one-vX.Y.Z-windows.zip)
// -------------------------------------------------------------
console.log('[3/3] 正在构建【单机双端集成开发测试包】(vfusion-all-in-one)...');
const allDirName = `vfusion-all-in-one-v${VERSION}-windows`;
const allDir = path.join(RELEASE_DIR, allDirName);
fs.mkdirSync(allDir, { recursive: true });

copyDirSync(path.join(ROOT_DIR, 'packages'), path.join(allDir, 'packages'));
copyStorageTemplatesSync(path.join(ROOT_DIR, 'storage'), path.join(allDir, 'storage'));
copyNodeModulesSync(allDir);

try { fs.copyFileSync(process.execPath, path.join(allDir, 'node.exe')); } catch (e) {}
fs.copyFileSync(path.join(ROOT_DIR, 'package.json'), path.join(allDir, 'package.json'));
fs.copyFileSync(path.join(ROOT_DIR, 'README.md'), path.join(allDir, 'README.md'));
fs.copyFileSync(path.join(ROOT_DIR, '更新日志.md'), path.join(allDir, '更新日志.md'));

writeBatFileSync(path.join(allDir, '一键双端双开启动.bat'), batAllRun);
writeBatFileSync(path.join(allDir, '启动视频网发布终端.bat'), batCollectorRun);
writeBatFileSync(path.join(allDir, '启动内网数据中台.bat'), batCoreRun);
writeBatFileSync(path.join(allDir, '一键双端无损升级.bat'), batAllUpgrade);

// 在根目录同步写入简化的快捷批处理脚本
writeBatFileSync(path.join(ROOT_DIR, '启动视频网发布终端.bat'), batCollectorRun);
writeBatFileSync(path.join(ROOT_DIR, '启动内网数据中台.bat'), batCoreRun);
writeBatFileSync(path.join(ROOT_DIR, '一键双端双开启动.bat'), batAllRun);

const allZipPath = path.join(RELEASE_DIR, `${allDirName}.zip`);
const allSizeMB = createZipArchive(allDir, allZipPath);

console.log(`✓ 单机双端集成测试包构建完成: ${allZipPath} (${allSizeMB} MB)\n`);

console.log(`===================================================`);
console.log(`🎉 视汇 (VFusion v${VERSION}) 专属场景部署包构建成功！`);
console.log(`1. 视频网专属包: ${collectorZipPath}`);
console.log(`2. 内网中台专属包: ${coreZipPath}`);
console.log(`3. 双端集成开发包: ${allZipPath}`);
console.log(`===================================================\n`);
