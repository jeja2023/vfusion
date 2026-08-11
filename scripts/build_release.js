const fs = require('fs');
const path = require('path');

console.log('===================================================');
console.log(' 视汇 (VFusion) 离线物理隔离网部署包编译工具 (v0.9.0)');
console.log('===================================================');

const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist_vfusion_v0.9.0');

if (fs.existsSync(DIST_DIR)) {
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
}
fs.mkdirSync(DIST_DIR, { recursive: true });

function copyRecursiveSync(src, dest) {
  const exists = fs.existsSync(src);
  const stats = exists && fs.statSync(src);
  const isDirectory = exists && stats.isDirectory();
  if (isDirectory) {
    fs.mkdirSync(dest, { recursive: true });
    fs.readdirSync(src).forEach(childItemName => {
      copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
    });
  } else {
    fs.copyFileSync(src, dest);
  }
}

console.log('[1/4] 拷贝核心代码库 (packages/)...');
copyRecursiveSync(path.join(ROOT_DIR, 'packages'), path.join(DIST_DIR, 'packages'));

console.log('[2/4] 拷贝配置文件与启动器 (package.json, start_all.bat, start_all.sh)...');
fs.copyFileSync(path.join(ROOT_DIR, 'package.json'), path.join(DIST_DIR, 'package.json'));
fs.copyFileSync(path.join(ROOT_DIR, 'start_all.bat'), path.join(DIST_DIR, 'start_all.bat'));
fs.copyFileSync(path.join(ROOT_DIR, 'start_all.sh'), path.join(DIST_DIR, 'start_all.sh'));
fs.copyFileSync(path.join(ROOT_DIR, 'README.md'), path.join(DIST_DIR, 'README.md'));
fs.copyFileSync(path.join(ROOT_DIR, '更新日志.md'), path.join(DIST_DIR, '更新日志.md'));

console.log('[3/4] 创建初始化隔离存储拓扑 (storage/)...');
const storageDir = path.join(DIST_DIR, 'storage');
['ftp_out', 'ftp_in', 'archive', 'error', 'assets'].forEach(sub => {
  fs.mkdirSync(path.join(storageDir, sub), { recursive: true });
});

console.log('===================================================');
console.log(` 编译完成！部署包输出位置: ${DIST_DIR}`);
console.log('===================================================');
