const fs = require('fs');
const path = require('path');

/**
 * 零依赖轻量级 .env 配置文件加载器
 * 优先保留已有 process.env，支持 .env 及 .env.local 覆盖
 */
function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return false;
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        // 处理双引号或单引号包裹的值
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        // 如果当前系统环境变量未设置，则注入 .env 中的配置
        if (process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
    }
    return true;
  } catch (e) {
    console.warn(`[VFusion Env] 读取 ${envPath} 配置文件失败:`, e.message);
    return false;
  }
}

function initEnv() {
  const rootDir = path.resolve(__dirname, '../../');
  const cwdDir = process.cwd();

  const candidates = [
    path.join(rootDir, '.env.local'),
    path.join(rootDir, '.env'),
    path.join(cwdDir, '.env.local'),
    path.join(cwdDir, '.env')
  ];

  const loaded = [];
  for (const envPath of candidates) {
    if (fs.existsSync(envPath) && !loaded.includes(envPath)) {
      if (loadEnvFile(envPath)) {
        loaded.push(envPath);
      }
    }
  }

  if (loaded.length > 0) {
    console.log(`[VFusion Env] 已成功加载环境变量配置文件: ${loaded.map(p => path.basename(p)).join(', ')}`);
  }
}

module.exports = {
  initEnv,
  loadEnvFile
};
