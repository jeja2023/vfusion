const ftp = require('basic-ftp');
const path = require('path');
const fs = require('fs');

/**
 * 创建并建立 FTP 客户端连接
 */
async function getFtpClient(config) {
  const client = new ftp.Client(config.timeout || 10000);
  client.ftp.verbose = false;
  await client.access({
    host: config.ftp_host || '127.0.0.1',
    port: parseInt(config.ftp_port || 21),
    user: config.ftp_user || 'anonymous',
    password: config.ftp_password || '',
    secure: config.ftp_secure || false
  });
  return client;
}

/**
 * 测试远程 FTP 服务器连接与目录权限
 */
async function testFtpConnection(config) {
  const client = await getFtpClient(config);
  try {
    const remoteDir = config.ftp_remote_dir || '/';
    await client.ensureDir(remoteDir);
    const list = await client.list();
    client.close();
    return {
      success: true,
      message: `第三方 FTP 服务器连接成功！目标目录 [${remoteDir}] 可读写，发现 ${list.length} 个文件/子目录。`
    };
  } catch (err) {
    client.close();
    throw new Error(`FTP 连接或授权校验失败: ${err.message}`);
  }
}

/**
 * 视频网端：自动推送打包好的 Zip 文件到远程第三方 FTP 服务器
 */
async function uploadToRemoteFtp(localFilePath, remoteFileName, config) {
  if (!config || !config.ftp_enabled || !config.ftp_host) return null;
  const client = await getFtpClient(config);
  try {
    const remoteDir = config.ftp_remote_dir || '/';
    await client.ensureDir(remoteDir);
    const remotePath = path.posix.join(remoteDir, remoteFileName);
    const tmpRemotePath = `${remotePath}.tmp`;

    // 采用原子写入方式：先上传 .tmp，再重命名为 .zip，规避内网并发未传完即被抓取
    await client.uploadFrom(localFilePath, tmpRemotePath);
    await client.rename(tmpRemotePath, remotePath);
    client.close();
    return { success: true, remotePath };
  } catch (err) {
    client.close();
    throw err;
  }
}

/**
 * 内网端：自动连远程第三方 FTP 服务器，拉取匹配前缀的数据包下载到本地，并进行清理归档
 */
async function downloadFromRemoteFtp(localDownloadDir, config, prefix = 'vfusion_') {
  if (!config || !config.ftp_enabled || !config.ftp_host) return [];
  const client = await getFtpClient(config);
  const downloadedFiles = [];
  try {
    const remoteDir = config.ftp_remote_dir || '/';
    await client.ensureDir(remoteDir);
    const list = await client.list();

    // 只过滤符合视汇前缀 (如 vfusion_) 且为 .zip 的文件，忽略第三方其他无关系文件
    const targetFiles = list.filter(item =>
      (item.isFile || item.type === 1) &&
      item.name.startsWith(prefix) &&
      item.name.endsWith('.zip') &&
      !item.name.endsWith('.tmp')
    );

    for (const item of targetFiles) {
      const remoteFilePath = path.posix.join(remoteDir, item.name);
      const localFilePath = path.join(localDownloadDir, item.name);
      const localTmpPath = `${localFilePath}.tmp_${Date.now()}`;

      // 下载到本地临时 .tmp 文件
      await client.downloadTo(localTmpPath, remoteFilePath);
      // 原子重命名为本地 .zip
      fs.renameSync(localTmpPath, localFilePath);

      // 下载完成后删除远程 FTP 上的文件，避免重复拉取
      if (config.ftp_delete_after_download !== false) {
        try {
          await client.remove(remoteFilePath);
        } catch (e) {
          console.warn(`[VFusion FTP] 清理远程文件 ${remoteFilePath} 提示:`, e.message);
        }
      }

      downloadedFiles.push(item.name);
    }
    client.close();
    return downloadedFiles;
  } catch (err) {
    client.close();
    throw err;
  }
}

module.exports = {
  testFtpConnection,
  uploadToRemoteFtp,
  downloadFromRemoteFtp
};
