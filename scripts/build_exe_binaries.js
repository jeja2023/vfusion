const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const EXE_DIR = path.join(ROOT_DIR, 'release', 'binaries');

if (!fs.existsSync(EXE_DIR)) {
  fs.mkdirSync(EXE_DIR, { recursive: true });
}

console.log('=== 开始编译 生成单文件 Windows .exe 二进制程序 ===\n');

try {
  console.log('[1/2] 正在编译 视频网数据采集/发布终端 -> vfusion-collector-4001.exe ...');
  execSync(`npx @yao-pkg/pkg -t node20-win-x64 --out-path "${EXE_DIR}" packages/collector/server.js`, { stdio: 'inherit', cwd: ROOT_DIR });
  const oldCollectorExe = path.join(EXE_DIR, 'server.exe');
  const newCollectorExe = path.join(EXE_DIR, 'vfusion-collector-4001.exe');
  if (fs.existsSync(oldCollectorExe)) {
    if (fs.existsSync(newCollectorExe)) fs.unlinkSync(newCollectorExe);
    fs.renameSync(oldCollectorExe, newCollectorExe);
  }

  console.log('\n[2/2] 正在编译 内网数据汇聚与管理中台 -> vfusion-core-4002.exe ...');
  execSync(`npx @yao-pkg/pkg -t node20-win-x64 --out-path "${EXE_DIR}" packages/core/server.js`, { stdio: 'inherit', cwd: ROOT_DIR });
  const oldCoreExe = path.join(EXE_DIR, 'server.exe');
  const newCoreExe = path.join(EXE_DIR, 'vfusion-core-4002.exe');
  if (fs.existsSync(oldCoreExe)) {
    if (fs.existsSync(newCoreExe)) fs.unlinkSync(newCoreExe);
    fs.renameSync(oldCoreExe, newCoreExe);
  }

  console.log('\n=== 单文件 .exe 编译完成！===');
  console.log(`- 视频网采集端 EXE: ${newCollectorExe}`);
  console.log(`- 内网中台端 EXE: ${newCoreExe}`);
} catch (err) {
  console.error('编译 EXE 出现异常:', err.message);
}
