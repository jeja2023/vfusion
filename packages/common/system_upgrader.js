const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');
const crypto = require('crypto');
const { resolveInside, isSafeFileName } = require('./security_utils');

const MAX_UPGRADE_BYTES = 200 * 1024 * 1024;
const MAX_UPGRADE_ENTRIES = 2000;

async function validateUpgradeArchive(zipFilePath) {
  const stat = fs.statSync(zipFilePath);
  if (!stat.isFile() || stat.size > MAX_UPGRADE_BYTES) throw new Error('升级补丁包超过 200MB 限制');
  const directory = await unzipper.Open.file(zipFilePath);
  if (directory.files.length > MAX_UPGRADE_ENTRIES) throw new Error('升级补丁包文件数量超限');
  let total = 0;
  let packageCount = 0;
  for (const entry of directory.files) {
    const name = String(entry.path || '').replace(/\\/g, '/');
    if (!name || name.startsWith('/') || name.includes('\0') || name.split('/').some(part => part === '..')) {
      throw new Error(`升级补丁包含非法路径: ${name}`);
    }
    if (entry.type && entry.type !== 'File' && entry.type !== 'Directory') throw new Error(`升级补丁包含不支持的链接: ${name}`);
    const parts = name.replace(/\/$/, '').split('/');
    const isPackageFile = name.startsWith('packages/') || name.includes('/packages/');
    const baseName = parts[parts.length - 1];
    const isTopLevelMetadata = (parts.length === 1 || parts.length === 2) && (baseName === 'package.json' || baseName.startsWith('README') || baseName.startsWith('更新日志') || baseName.toLowerCase().endsWith('.md'));
    const isRootDirectory = entry.type === 'Directory' && parts.length === 1;
    if (!isPackageFile && !isTopLevelMetadata && !isRootDirectory) {
      throw new Error(`升级补丁包含未授权文件: ${name}`);
    }
    if (entry.type === 'File') {
      total += Number(entry.uncompressedSize || 0);
      if (total > 500 * 1024 * 1024) throw new Error('升级补丁解压后超过 500MB 限制');
      if (name.startsWith('packages/') || name.includes('/packages/')) packageCount++;
    }
  }
  if (!packageCount) throw new Error('无效的升级补丁包: 未找到 packages 文件');
}

/**
 * 递归复制文件与目录
 */
function copyDirSync(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (!isSafeFileName(entry.name)) throw new Error(`升级补丁包含非法文件名: ${entry.name}`);
    const srcPath = resolveInside(src, entry.name);
    const destPath = resolveInside(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * 生产环境 Web 控制台在线无损热升级引擎
 * @param {string} zipFilePath 上传的 .zip 补丁文件路径
 * @param {string} storageRoot storage 物理存放路径
 * @param {string} appRootDir 应用程序根路径
 */
async function performOnlineUpgrade(zipFilePath, storageRoot, appRootDir) {
  const tempExtractDir = resolveInside(storageRoot, `_tmp_upgrade_${process.pid}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
  if (!fs.existsSync(tempExtractDir)) {
    fs.mkdirSync(tempExtractDir, { recursive: true });
  }

  try {
    await validateUpgradeArchive(zipFilePath);
    // 1. 解压补丁文件
    await fs.createReadStream(zipFilePath)
      .pipe(unzipper.Extract({ path: tempExtractDir }))
      .promise();

    // 尝试寻找 packages 目录（可能是压缩在根路径下，或者在子目录中）
    let sourcePackagesDir = path.join(tempExtractDir, 'packages');
    if (!fs.existsSync(sourcePackagesDir)) {
      const entries = fs.readdirSync(tempExtractDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subPackages = path.join(tempExtractDir, entry.name, 'packages');
          if (fs.existsSync(subPackages)) {
            sourcePackagesDir = subPackages;
            break;
          }
        }
      }
    }

    if (!fs.existsSync(sourcePackagesDir)) {
      throw new Error('无效的升级补丁包: 未能找到 packages 代码目录');
    }

    // 2. 自动备份当前生产环境数据库与关键 JSON 配置文件
    const backupDir = resolveInside(storageRoot, 'storage_backup', `backup_${Date.now()}`);
    fs.mkdirSync(backupDir, { recursive: true });
    
    if (fs.existsSync(storageRoot)) {
      const files = fs.readdirSync(storageRoot);
      for (const f of files) {
        if (f.endsWith('.db') || f.endsWith('.json')) {
        fs.copyFileSync(resolveInside(storageRoot, f), resolveInside(backupDir, f));
        }
      }
    }

    // 3. 覆盖升级代码 (packages/)
    const targetPackagesDir = resolveInside(appRootDir, 'packages');
    const rollbackDir = resolveInside(storageRoot, `_upgrade_rollback_${process.pid}_${Date.now()}`);
    copyDirSync(targetPackagesDir, rollbackDir);
    try {
      copyDirSync(sourcePackagesDir, targetPackagesDir);
    } catch (copyErr) {
      copyDirSync(rollbackDir, targetPackagesDir);
      throw copyErr;
    } finally {
      try { fs.rmSync(rollbackDir, { recursive: true, force: true }); } catch (e) {}
    }

    // 4. 清理临时解压目录与上传文件
    try { fs.rmSync(tempExtractDir, { recursive: true, force: true }); } catch (e) {}
    try { fs.unlinkSync(zipFilePath); } catch (e) {}

    // 5. 触发进程自动重启
    setTimeout(() => {
      console.log('[VFusion Upgrade] 热升级补丁替换完成，正在自动重新加载服务进程...');
      process.exit(0);
    }, 2000);

    return {
      success: true,
      message: '无损升级补丁安装成功！数据库与配置文件已自动备份，服务将在 3 秒内自动重启生效。',
      backupPath: backupDir
    };
  } catch (err) {
    try { fs.rmSync(tempExtractDir, { recursive: true, force: true }); } catch (e) {}
    try { fs.unlinkSync(zipFilePath); } catch (e) {}
    throw err;
  }
}

module.exports = {
  performOnlineUpgrade,
  validateUpgradeArchive
};
