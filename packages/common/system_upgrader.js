const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');

/**
 * 递归复制文件与目录
 */
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

/**
 * 生产环境 Web 控制台在线无损热升级引擎
 * @param {string} zipFilePath 上传的 .zip 补丁文件路径
 * @param {string} storageRoot storage 物理存放路径
 * @param {string} appRootDir 应用程序根路径
 */
async function performOnlineUpgrade(zipFilePath, storageRoot, appRootDir) {
  const tempExtractDir = path.join(storageRoot, `_tmp_upgrade_${Date.now()}`);
  if (!fs.existsSync(tempExtractDir)) {
    fs.mkdirSync(tempExtractDir, { recursive: true });
  }

  try {
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
    const backupDir = path.join(storageRoot, 'storage_backup', `backup_${Date.now()}`);
    fs.mkdirSync(backupDir, { recursive: true });
    
    if (fs.existsSync(storageRoot)) {
      const files = fs.readdirSync(storageRoot);
      for (const f of files) {
        if (f.endsWith('.db') || f.endsWith('.json')) {
          fs.copyFileSync(path.join(storageRoot, f), path.join(backupDir, f));
        }
      }
    }

    // 3. 覆盖升级代码 (packages/)
    const targetPackagesDir = path.join(appRootDir, 'packages');
    copyDirSync(sourcePackagesDir, targetPackagesDir);

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
  performOnlineUpgrade
};
