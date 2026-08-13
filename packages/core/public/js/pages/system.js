async function loadSystemHealth() {
  try {
    const [healthRes, secRes] = await Promise.all([fetch('/api/system/health'), fetch('/api/config/security')]);
    const json = await healthRes.json();
    const secJson = await secRes.json();

    if (secJson.success) {
      const currentKeyEl = document.getElementById('currentKeyMasked');
      if (currentKeyEl) currentKeyEl.innerText = secJson.data.hmac_secret || secJson.data.hmac_secret_masked || '未设置';

      const d = secJson.data;
      if (document.getElementById('ftpEnableSelect')) document.getElementById('ftpEnableSelect').value = String(d.ftp_enabled || false);
      if (document.getElementById('ftpHostInput')) document.getElementById('ftpHostInput').value = d.ftp_host || '';
      if (document.getElementById('ftpPortInput')) document.getElementById('ftpPortInput').value = d.ftp_port || 21;
      if (document.getElementById('ftpUserInput')) document.getElementById('ftpUserInput').value = d.ftp_user || '';
      if (document.getElementById('ftpPasswordInput')) document.getElementById('ftpPasswordInput').value = d.ftp_password || '';
      if (document.getElementById('ftpRemoteDirInput')) document.getElementById('ftpRemoteDirInput').value = d.ftp_remote_dir || '/vfusion_packages';
      if (document.getElementById('pkgPrefixInput')) document.getElementById('pkgPrefixInput').value = d.pkg_prefix || 'vfusion_';
      if (document.getElementById('ftpDeleteSelect')) document.getElementById('ftpDeleteSelect').value = String(d.ftp_delete_after_download !== false);
    }

    if (json.success) {
      const d = json.data;
      if (document.getElementById('archiveSizeStr')) document.getElementById('archiveSizeStr').innerText = (d.archive_size_bytes / (1024 * 1024)).toFixed(2) + ' MB';
      if (document.getElementById('assetsSizeStr')) document.getElementById('assetsSizeStr').innerText = (d.assets_size_bytes / (1024 * 1024)).toFixed(2) + ' MB';

      const healthDetails = document.getElementById('systemHealthDetails');
      if (healthDetails) {
        healthDetails.innerHTML = `
          <div style="display:flex; flex-direction:column; gap:0.5rem;">
            <div style="display:flex; justify-content:space-between; border-bottom:1px solid #e2e8f0; padding-bottom:0.4rem;">
              <span style="color:var(--text-sub);">节点部署角色:</span>
              <strong style="color:var(--primary);">${escapeHtml(d.role || 'CORE (数据中台)')}</strong>
            </div>
            <div style="display:flex; justify-content:space-between; border-bottom:1px solid #e2e8f0; padding-bottom:0.4rem;">
              <span style="color:var(--text-sub);">运行环境版本:</span>
              <span><code>${escapeHtml(d.node_version)}</code> (运行 <code>${escapeHtml(d.uptime_seconds)}</code> 秒)</span>
            </div>
            <div style="display:flex; justify-content:space-between; border-bottom:1px solid #e2e8f0; padding-bottom:0.4rem;">
              <span style="color:var(--text-sub);">内存堆使用 (RSS):</span>
              <span><code>${escapeHtml(d.memory_heap_mb)} MB</code> (常驻内存: <code>${escapeHtml(d.memory_rss_mb)} MB</code>)</span>
            </div>
            <div style="display:flex; justify-content:space-between; border-bottom:1px solid #e2e8f0; padding-bottom:0.4rem;">
              <span style="color:var(--text-sub);">服务器操作系统:</span>
              <span><code>${escapeHtml(d.system_os)}</code></span>
            </div>
            <div style="display:flex; justify-content:space-between;">
              <span style="color:var(--text-sub);">存储健康状态:</span>
              <span style="color:var(--success); font-weight:700;">${escapeHtml(d.storage_status)} (HEALTHY)</span>
            </div>
          </div>
        `;
      }
    }
  } catch (e) {
    console.error('加载系统健康度失败:', e);
  }
}

function updateDiodeStatusUi(seconds) {
  const pulseDot = document.getElementById('diodePulseDot');
  const statusText = document.getElementById('diodeStatusText');
  if (seconds > 0) {
    if (pulseDot) pulseDot.classList.remove('disabled');
    if (statusText) statusText.innerText = `自动摆渡中 (${seconds}秒轮询)`;
  } else {
    if (pulseDot) pulseDot.classList.add('disabled');
    if (statusText) statusText.innerText = `手动摆渡模式`;
  }
}

async function rotateHmacSecret() {
  const newSec = document.getElementById('newHmacSecretInput').value.trim();
  if (!newSec) { showToast('请输入新秘钥！', 'error'); return; }

  const res = await fetch('/api/config/security', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hmac_secret: newSec })
  });
  const json = await res.json();
  if (json.success) {
    showToast('HMAC 签名秘钥在线轮换更新成功！');
    document.getElementById('newHmacSecretInput').value = '';
    loadSystemHealth();
  }
}

async function updateAutoDiodeConfig() {
  const val = parseInt(document.getElementById('autoDiodeSelect').value);
  updateDiodeStatusUi(val);
  const res = await fetch('/api/config/security', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ auto_diode_interval: val })
  });
  const json = await res.json();
  if (json.success) {
    showToast(val === 0 ? '已切换为手动摆渡模式' : `自动摆渡频率已设为: ${val}秒`);
  }
}

async function cleanupArchives() {
  const res = await fetch('/api/storage/cleanup', { method: 'POST' });
  const json = await res.json();
  showToast(json.message);
  loadSystemHealth();
}

async function runOnlineDiagnostics() {
  const res = await fetch('/api/system/diagnose');
  const json = await res.json();
  if (json.success) {
    const box = document.getElementById('diagnoseResultsBox');
    const container = document.getElementById('diagnoseItemsContainer');
    if (box) box.style.display = 'block';
    if (container) {
      container.innerHTML = json.data.map(item => `
        <div style="margin-bottom:0.4rem; font-size:0.825rem;">
          <strong>[${escapeHtml(item.category)}]</strong>: <span style="color:var(--success); font-weight:700;">${escapeHtml(item.status)}</span> - ${escapeHtml(item.detail)}
        </div>
      `).join('');
    }
    showToast('系统在线自检与拓扑诊断完成');
  }
}

function getFtpFormValues() {
  return {
    ftp_enabled: document.getElementById('ftpEnableSelect').value === 'true',
    ftp_host: document.getElementById('ftpHostInput').value.trim(),
    ftp_port: parseInt(document.getElementById('ftpPortInput').value) || 21,
    ftp_user: document.getElementById('ftpUserInput').value.trim(),
    ftp_password: document.getElementById('ftpPasswordInput').value,
    ftp_remote_dir: document.getElementById('ftpRemoteDirInput').value.trim() || '/vfusion_packages',
    pkg_prefix: document.getElementById('pkgPrefixInput').value.trim() || 'vfusion_',
    ftp_delete_after_download: document.getElementById('ftpDeleteSelect').value === 'true'
  };
}

async function saveFtpChannelConfig() {
  const configData = getFtpFormValues();
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
}

async function testFtpServerConnection() {
  const configData = getFtpFormValues();
  const box = document.getElementById('ftpTestStatusBox');
  if (!configData.ftp_host) {
    showToast('请填写 FTP 服务器 IP 地址或域名！', 'error');
    return;
  }

  if (box) {
    box.style.display = 'block';
    box.style.background = '#eff6ff';
    box.style.border = '1px solid #bfdbfe';
    box.style.color = '#1d4ed8';
    box.innerText = `正在连接 FTP 服务器 [${configData.ftp_host}:${configData.ftp_port}] 并验证权限，请稍候...`;
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
        box.innerText = `[成功] ${json.message}`;
      }
      showToast('FTP 远程服务器连通性测试通过！');
    } else {
      if (box) {
        box.style.background = '#fef2f2';
        box.style.border = '1px solid #fecaca';
        box.style.color = '#b91c1c';
        box.innerText = `[失败] 测试失败: ${json.error}`;
      }
      showToast(json.error, 'error');
    }
  } catch (e) {
    if (box) {
      box.style.background = '#fef2f2';
      box.style.border = '1px solid #fecaca';
      box.style.color = '#b91c1c';
      box.innerText = `[失败] 网络错误: ${e.message}`;
    }
    showToast('无法连接到服务端校验接口', 'error');
  }
}

async function uploadWebPatchUpgrade() {
  const fileInput = document.getElementById('webUpgradeFileInput');
  const statusBox = document.getElementById('webUpgradeStatusBox');
  if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
    showToast('请选择 .zip 升级补丁包文件！', 'error');
    return;
  }

  const patchFile = fileInput.files[0];
  if (!patchFile.name.endsWith('.zip')) {
    showToast('升级文件格式必须为 .zip 压缩包！', 'error');
    return;
  }

  if (statusBox) {
    statusBox.style.display = 'block';
    statusBox.style.background = '#eff6ff';
    statusBox.style.border = '1px solid #bfdbfe';
    statusBox.style.color = '#1d4ed8';
    statusBox.innerText = `正在上传升级补丁包 [${patchFile.name}] 并校验解压，请稍候...`;
  }

  const formData = new FormData();
  formData.append('patchFile', patchFile);

  try {
    const res = await fetch('/api/system/upgrade', {
      method: 'POST',
      body: formData
    });
    const json = await res.json();
    if (json.success) {
      if (statusBox) {
        statusBox.style.background = '#f0fdf4';
        statusBox.style.border = '1px solid #bbf7d0';
        statusBox.style.color = '#15803d';
        statusBox.innerText = `[成功] ${json.message}`;
      }
      showToast('补丁更新成功！服务将在 3 秒内自动平滑重载。');
      setTimeout(() => {
        location.reload();
      }, 4000);
    } else {
      if (statusBox) {
        statusBox.style.background = '#fef2f2';
        statusBox.style.border = '1px solid #fecaca';
        statusBox.style.color = '#b91c1c';
        statusBox.innerText = `[失败] 升级失败: ${json.error}`;
      }
      showToast(json.error || '在线平滑升级失败', 'error');
    }
  } catch (e) {
    if (statusBox) {
      statusBox.style.background = '#fef2f2';
      statusBox.style.border = '1px solid #fecaca';
      statusBox.style.color = '#b91c1c';
      statusBox.innerText = `[失败] 传输网络异常: ${e.message}`;
    }
    showToast('上传补丁包发生网络错误', 'error');
  }
}

function onUpgradeFileSelected(input) {
  const titleEl = document.getElementById('patchFileSelectTitle') || document.getElementById('collPatchFileSelectTitle');
  const subEl = document.getElementById('patchFileSelectSub') || document.getElementById('collPatchFileSelectSub');
  const dropzone = document.getElementById('patchDropzone') || document.getElementById('collPatchDropzone');

  if (input.files && input.files.length > 0) {
    const file = input.files[0];
    const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
    const sizeKB = (file.size / 1024).toFixed(1);
    const sizeStr = file.size > 1024 * 1024 ? `${sizeMB} MB` : `${sizeKB} KB`;

    if (titleEl) titleEl.innerText = `[已选择]: ${file.name}`;
    if (subEl) subEl.innerText = `文件体积: ${sizeStr} (点击更换文件)`;
    if (dropzone) {
      dropzone.style.background = '#f0fdf4';
      dropzone.style.borderColor = '#4ade80';
    }
  } else {
    if (titleEl) titleEl.innerText = '点击或拖拽上传补丁包 (.zip)';
    if (subEl) subEl.innerText = '支持选择 vfusion-patch-v*.zip 增量升级文件';
    if (dropzone) {
      dropzone.style.background = '#ffffff';
      dropzone.style.borderColor = '#7dd3fc';
    }
  }
}
