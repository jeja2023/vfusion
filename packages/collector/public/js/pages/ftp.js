async function loadCollectorFtpConfig() {
  try {
    const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const res = await fetchFn('/api/config/ftp');
    const json = await res.json();
    if (json.success && json.data) {
      const d = json.data;
      if (document.getElementById('collFtpEnableToggle')) {
        const isEnable = !!d.ftp_enabled;
        document.getElementById('collFtpEnableToggle').checked = isEnable;
        if (document.getElementById('collFtpEnableText')) document.getElementById('collFtpEnableText').innerText = isEnable ? '开启远程 FTP' : '关闭远程 FTP';
      }
      if (document.getElementById('collFtpHostInput')) document.getElementById('collFtpHostInput').value = d.ftp_host || '';
      if (document.getElementById('collFtpPortInput')) document.getElementById('collFtpPortInput').value = d.ftp_port || 21;
      if (document.getElementById('collFtpUserInput')) document.getElementById('collFtpUserInput').value = d.ftp_user || '';
      if (document.getElementById('collFtpPasswordInput')) document.getElementById('collFtpPasswordInput').value = d.ftp_password || '';
      if (document.getElementById('collFtpRemoteDirInput')) document.getElementById('collFtpRemoteDirInput').value = d.ftp_remote_dir || '/vfusion_packages';
      if (document.getElementById('collPkgPrefixInput')) document.getElementById('collPkgPrefixInput').value = d.pkg_prefix || 'vfusion_';
      if (document.getElementById('collFtpExtSelect')) document.getElementById('collFtpExtSelect').value = d.ftp_file_ext || '.jpg';
      if (document.getElementById('collHmacSecretInput')) document.getElementById('collHmacSecretInput').value = d.hmac_secret || '';
    }
  } catch (e) {
    console.error('加载视频网端 FTP 配置失败:', e);
  }
}

function getCollectorFtpFormValues() {
  return {
    ftp_enabled: document.getElementById('collFtpEnableToggle') ? document.getElementById('collFtpEnableToggle').checked : false,
    ftp_host: document.getElementById('collFtpHostInput').value.trim(),
    ftp_port: parseInt(document.getElementById('collFtpPortInput').value) || 21,
    ftp_user: document.getElementById('collFtpUserInput').value.trim(),
    ftp_password: document.getElementById('collFtpPasswordInput').value,
    ftp_remote_dir: document.getElementById('collFtpRemoteDirInput').value.trim() || '/vfusion_packages',
    pkg_prefix: document.getElementById('collPkgPrefixInput').value.trim() || 'vfusion_',
    ftp_file_ext: document.getElementById('collFtpExtSelect') ? document.getElementById('collFtpExtSelect').value : '.jpg',
    hmac_secret: document.getElementById('collHmacSecretInput') ? document.getElementById('collHmacSecretInput').value.trim() : ''
  };
}

async function saveCollectorFtpConfig() {
  const configData = getCollectorFtpFormValues();
  try {
    const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const res = await fetchFn('/api/config/ftp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(configData)
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.message);
    } else {
      showToast(json.error || '保存视频网端 FTP 配置失败', 'error');
    }
  } catch (e) {
    showToast('网络交互错误', 'error');
  }
}

async function testCollectorFtpConnection() {
  const configData = getCollectorFtpFormValues();
  const box = document.getElementById('collFtpTestStatusBox');
  if (!configData.ftp_host) {
    showToast('请填写 FTP 服务器 IP 地址或域名！', 'error');
    return;
  }

  if (box) {
    box.style.display = 'block';
    box.style.background = '#eff6ff';
    box.style.border = '1px solid #bfdbfe';
    box.style.color = '#1d4ed8';
    box.innerText = `正在连接 FTP 服务器 [${configData.ftp_host}:${configData.ftp_port}] 并验证上传权限，请稍候...`;
  }

  try {
    const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const res = await fetchFn('/api/config/ftp/test', {
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
      showToast('视频网端 FTP 连通性测试通过！');
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
