const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
const VERSION = pkg.version || '0.18.0';

const RELEASE_DIR = path.join(ROOT_DIR, 'release');
const PATCH_DIR_NAME = `vfusion-patch-v${VERSION}`;
const PATCH_DIR = path.join(RELEASE_DIR, PATCH_DIR_NAME);
const PATCH_ZIP_PATH = path.join(RELEASE_DIR, `vfusion-patch-v${VERSION}.zip`);

console.log(`=== 开始构建 视汇 (VFusion v${VERSION}) 轻量级 Web 补丁包 ===\n`);

if (!fs.existsSync(RELEASE_DIR)) fs.mkdirSync(RELEASE_DIR, { recursive: true });
if (fs.existsSync(PATCH_DIR)) fs.rmSync(PATCH_DIR, { recursive: true, force: true });
fs.mkdirSync(PATCH_DIR, { recursive: true });

function copyDirSync(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// 1. 仅复制源码与必要清单
copyDirSync(path.join(ROOT_DIR, 'packages'), path.join(PATCH_DIR, 'packages'));
fs.copyFileSync(path.join(ROOT_DIR, 'package.json'), path.join(PATCH_DIR, 'package.json'));
fs.copyFileSync(path.join(ROOT_DIR, 'README.md'), path.join(PATCH_DIR, 'README.md'));
fs.copyFileSync(path.join(ROOT_DIR, '更新日志.md'), path.join(PATCH_DIR, '更新日志.md'));

// 2. 打包成轻量 Zip 补丁
try {
  if (fs.existsSync(PATCH_ZIP_PATH)) fs.unlinkSync(PATCH_ZIP_PATH);
  execSync(`tar -a -c -f "${PATCH_ZIP_PATH}" -C "${RELEASE_DIR}" "${PATCH_DIR_NAME}"`, { stdio: 'ignore' });
  
  // 清理临时目录
  fs.rmSync(PATCH_DIR, { recursive: true, force: true });
  
  const stat = fs.statSync(PATCH_ZIP_PATH);
  const sizeKB = (stat.size / 1024).toFixed(1);
  const sizeMB = (stat.size / (1024 * 1024)).toFixed(2);
  
  console.log(`===================================================`);
  console.log(`🎉 视汇 Web 热升级补丁包构建成功！`);
  console.log(`- 补丁包路径: ${PATCH_ZIP_PATH}`);
  console.log(`- 补丁包体积: ${sizeKB} KB (${sizeMB} MB)`);
  console.log(`===================================================`);
  console.log(`\n使用方式: 登录视频网发布终端或内网数据中台的 Web 控制台，在【系统设置与维护】页面上传此文件即可实现一键无损热升级！`);
} catch (e) {
  console.error('构建补丁包失败:', e.message);
}
