const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const ROOT_DIR = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT_DIR, 'release');
const PORTABLE_DIR = path.join(RELEASE_DIR, 'vfusion-v0.10.0-portable');
const ZIP_OUTPUT_PATH = path.join(RELEASE_DIR, 'vfusion-v0.10.0-portable-windows.zip');

console.log('=== 开始构建 视汇 (VFusion v0.10.0) 绿色免安装部署包 ===\n');

// 1. 清理并新建 release 目录
if (fs.existsSync(RELEASE_DIR)) {
  fs.rmSync(RELEASE_DIR, { recursive: true, force: true });
}
fs.mkdirSync(PORTABLE_DIR, { recursive: true });

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

const { execSync } = require('child_process');

// 2. 复制依赖与主程序源码
console.log('[1/4] 正在复制 node_modules 与核心代码包...');
copyDirSync(path.join(ROOT_DIR, 'packages'), path.join(PORTABLE_DIR, 'packages'));
copyDirSync(path.join(ROOT_DIR, 'storage'), path.join(PORTABLE_DIR, 'storage'));

try {
  if (process.platform === 'win32') {
    execSync(`xcopy "${path.join(ROOT_DIR, 'node_modules')}" "${path.join(PORTABLE_DIR, 'node_modules')}" /E /I /Q /Y /K /R`, { stdio: 'ignore' });
  } else {
    execSync(`cp -R "${path.join(ROOT_DIR, 'node_modules')}" "${path.join(PORTABLE_DIR, 'node_modules')}"`, { stdio: 'ignore' });
  }
} catch (e) {
  console.warn('复制 node_modules 注意事项:', e.message);
}

// 复制 Node.js 绿色二进制文件 (保证目标电脑未安装 Node 也能零配置秒级双击启动)
console.log('[1.5/4] 正在内置 Node.js 绿色运行引擎 (node.exe)...');
try {
  fs.copyFileSync(process.execPath, path.join(PORTABLE_DIR, 'node.exe'));
  console.log('✓ 成功嵌入独立 Node.exe 运行引擎');
} catch (e) {
  console.warn('警告: 嵌入 node.exe 失败:', e.message);
}

fs.copyFileSync(path.join(ROOT_DIR, 'package.json'), path.join(PORTABLE_DIR, 'package.json'));
fs.copyFileSync(path.join(ROOT_DIR, 'README.md'), path.join(PORTABLE_DIR, 'README.md'));
fs.copyFileSync(path.join(ROOT_DIR, '更新日志.md'), path.join(PORTABLE_DIR, '更新日志.md'));

// 3. 生成一键双击批处理脚本 (.bat)
console.log('[2/4] 正在生成 Windows 一键启动双击批处理脚本 (.bat)...');

const batCollector = `\uFEFF@echo off
@chcp 65001 >nul
setlocal enabledelayedexpansion
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
"!NODE_BIN!" packages/collector/server.js
pause
`;

const batCore = `\uFEFF@echo off
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
`;

const batAll = `\uFEFF@echo off
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
`;

fs.writeFileSync(path.join(PORTABLE_DIR, '启动视频网发布终端(4001).bat'), batCollector, 'utf8');
fs.writeFileSync(path.join(PORTABLE_DIR, '启动内网数据中台(4002).bat'), batCore, 'utf8');
fs.writeFileSync(path.join(PORTABLE_DIR, '一键双端双开启动.bat'), batAll, 'utf8');

// 在根目录也留一份快捷启动脚本方便开发与部署
fs.writeFileSync(path.join(ROOT_DIR, '启动视频网发布终端(4001).bat'), batCollector, 'utf8');
fs.writeFileSync(path.join(ROOT_DIR, '启动内网数据中台(4002).bat'), batCore, 'utf8');
fs.writeFileSync(path.join(ROOT_DIR, '一键双端双开启动.bat'), batAll, 'utf8');

// 4. 压缩打包为绿色 ZIP 压缩文件
console.log('[3/4] 正在将绿色免安装包打包压缩为 Zip ...');
const output = fs.createWriteStream(ZIP_OUTPUT_PATH);
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', function () {
  const sizeMB = (archive.pointer() / (1024 * 1024)).toFixed(2);
  console.log(`\n=== 绿色免安装包构建完全成功！===`);
  console.log(`- 绿色包目录: ${PORTABLE_DIR}`);
  console.log(`- 免安装 Zip 包: ${ZIP_OUTPUT_PATH} (${sizeMB} MB)`);
  console.log(`\n使用说明: 将 Zip 文件解压到目标电脑的任意文件夹，双击 [一键双端双开启动.bat] 即可运行！`);
});

archive.on('error', function (err) {
  throw err;
});

archive.pipe(output);
archive.directory(PORTABLE_DIR, 'vfusion-v0.10.0-portable');
archive.finalize();
