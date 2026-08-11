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

  // 加载 FTP 轮询状态
  loadFtpPollStatus();
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
      loadFtpPollStatus();
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

// ========== FTP 轮询控制 ==========

async function loadFtpPollStatus() {
  if (typeof currentUser !== 'undefined' && !currentUser) return;
  try {
    const res = await fetch('/api/ftp/poll-status');
    const json = await res.json();
    if (json.success && json.data) {
      const d = json.data;
      const el = document.getElementById('ftpPollStatusDisplay');
      const intervalInput = document.getElementById('ftpPollIntervalInput');

      if (intervalInput && d.poll_interval) {
        intervalInput.value = d.poll_interval;
      }

      if (el) {
        const statusColor = d.timer_active ? '#15803d' : '#b91c1c';
        const statusText = d.timer_active ? '✓ 运行中' : '✕ 已停止';
        const enabledText = d.enabled ? '已配置' : '未配置';

        let html = `<div style="display:flex; flex-direction:column; gap:0.35rem;">`;
        html += `<div><strong>FTP 配置:</strong> <span style="color:${d.enabled ? '#15803d' : '#b91c1c'}">${enabledText}</span></div>`;
        html += `<div><strong>轮询引擎:</strong> <span style="color:${statusColor}">${statusText}</span> (每 ${d.poll_interval || 0} 秒)</div>`;
        html += `<div><strong>累计拉取:</strong> ${d.downloadedTotal || 0} 个包</div>`;
        if (d.lastPollTime) {
          html += `<div><strong>上次轮询:</strong> ${new Date(d.lastPollTime).toLocaleString('zh-CN')}</div>`;
        }
        if (d.lastResult) {
          html += `<div><strong>最近结果:</strong> ${escapeHtml(d.lastResult)}</div>`;
        }
        if (d.errorCount > 0) {
          html += `<div style="color:#b91c1c;"><strong>累计异常:</strong> ${d.errorCount} 次</div>`;
        }
        html += `</div>`;
        el.innerHTML = html;
      }
    }
  } catch (e) {
    console.error('加载 FTP 轮询状态失败:', e);
  }
}

async function saveFtpPollInterval() {
  const interval = parseInt(document.getElementById('ftpPollIntervalInput').value) || 0;
  try {
    const res = await fetch('/api/ftp/poll-interval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interval })
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.message);
      loadFtpPollStatus();
    } else {
      showToast(json.error || '设置轮询间隔失败', 'error');
    }
  } catch (e) {
    showToast('网络交互错误', 'error');
  }
}

async function manualFtpPull() {
  const box = document.getElementById('ftpPullResultBox');
  if (box) {
    box.style.display = 'block';
    box.style.background = '#eff6ff';
    box.style.border = '1px solid #bfdbfe';
    box.style.color = '#1d4ed8';
    box.innerText = '正在连接远程 FTP 服务器并拉取数据包，请稍候...';
  }

  try {
    const res = await fetch('/api/ftp/pull', { method: 'POST' });
    const json = await res.json();
    if (json.success) {
      if (box) {
        box.style.background = '#f0fdf4';
        box.style.border = '1px solid #bbf7d0';
        box.style.color = '#15803d';
        box.innerText = `✓ ${json.message}`;
      }
      showToast(json.message);
      loadFtpPollStatus();
    } else {
      if (box) {
        box.style.background = '#fef2f2';
        box.style.border = '1px solid #fecaca';
        box.style.color = '#b91c1c';
        box.innerText = `✕ ${json.error}`;
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
    showToast('无法连接到服务端', 'error');
  }
}

// 定时刷新轮询状态 (每 5 秒)
setInterval(loadFtpPollStatus, 5000);
