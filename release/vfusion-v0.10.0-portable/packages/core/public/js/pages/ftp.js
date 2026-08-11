async function loadCoreFtpConfig() {
  try {
    const res = await fetch('/api/config/security');
    const secJson = await res.json();
    if (secJson.success && secJson.data) {
      const d = secJson.data;
      if (document.getElementById('coreFtpEnableSelect')) document.getElementById('coreFtpEnableSelect').value = String(d.ftp_enabled || false);
      if (document.getElementById('coreFtpHostInput')) document.getElementById('coreFtpHostInput').value = d.ftp_host || '';
      if (document.getElementById('coreFtpPortInput')) document.getElementById('coreFtpPortInput').value = d.ftp_port || 21;
      if (document.getElementById('coreFtpUserInput')) document.getElementById('coreFtpUserInput').value = d.ftp_user || '';
      if (document.getElementById('coreFtpPasswordInput')) document.getElementById('coreFtpPasswordInput').value = d.ftp_password || '';
      if (document.getElementById('coreFtpRemoteDirInput')) document.getElementById('coreFtpRemoteDirInput').value = d.ftp_remote_dir || '/vfusion_packages';
      if (document.getElementById('corePkgPrefixInput')) document.getElementById('corePkgPrefixInput').value = d.pkg_prefix || 'vfusion_';
      if (document.getElementById('coreFtpDeleteSelect')) document.getElementById('coreFtpDeleteSelect').value = String(d.ftp_delete_after_download !== false);
    }
  } catch (e) {
    console.error('加载内网端 FTP 配置失败:', e);
  }
}

function getCoreFtpFormValues() {
  return {
    ftp_enabled: document.getElementById('coreFtpEnableSelect').value === 'true',
    ftp_host: document.getElementById('coreFtpHostInput').value.trim(),
    ftp_port: parseInt(document.getElementById('coreFtpPortInput').value) || 21,
    ftp_user: document.getElementById('coreFtpUserInput').value.trim(),
    ftp_password: document.getElementById('coreFtpPasswordInput').value,
    ftp_remote_dir: document.getElementById('coreFtpRemoteDirInput').value.trim() || '/vfusion_packages',
    pkg_prefix: document.getElementById('corePkgPrefixInput').value.trim() || 'vfusion_',
    ftp_delete_after_download: document.getElementById('coreFtpDeleteSelect').value === 'true'
  };
}

async function saveCoreFtpChannelConfig() {
  const configData = getCoreFtpFormValues();
  try {
    const res = await fetch('/api/config/security', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(configData)
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.message);
    } else {
      showToast(json.error || '保存 FTP 配置失败', 'error');
    }
  } catch (e) {
    showToast('网络交互错误', 'error');
  }
}

async function testCoreFtpServerConnection() {
  const configData = getCoreFtpFormValues();
  const box = document.getElementById('coreFtpTestStatusBox');
  if (!configData.ftp_host) {
    showToast('请填写 FTP 服务器 IP 地址或域名！', 'error');
    return;
  }

  if (box) {
    box.style.display = 'block';
    box.style.background = '#eff6ff';
    box.style.border = '1px solid #bfdbfe';
    box.style.color = '#1d4ed8';
    box.innerText = `正在连接 FTP 服务器 [${configData.ftp_host}:${configData.ftp_port}] 并验证抓取权限，请稍候...`;
  }

  try {
    const res = await fetch('/api/config/ftp/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(configData)
    });
    const json = await res.json();
    if (json.success) {
      if (box) {
        box.style.background = '#f0fdf4';
        box.style.border = '1px solid #bbf7d0';
        box.style.color = '#15803d';
        box.innerText = `✓ ${json.message}`;
      }
      showToast('FTP 远程服务器连通性测试通过！');
    } else {
      if (box) {
        box.style.background = '#fef2f2';
        box.style.border = '1px solid #fecaca';
        box.style.color = '#b91c1c';
        box.innerText = `✕ 测试失败: ${json.error}`;
      }
      showToast(json.error, 'error');
    }
  } catch (e) {
    if (box) {
      box.style.background = '#fef2f2';
      box.style.border = '1px solid #fecaca';
      box.style.color = '#b91c1c';
      box.innerText = `✕ 网络错误: ${e.message}`;
    }
    showToast('无法连接到服务端测试接口', 'error');
  }
}
