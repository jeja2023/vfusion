async function loadSystemHealth() {
  try {
    const [healthRes, secRes] = await Promise.all([fetch('/api/system/health'), fetch('/api/config/security')]);
    const json = await healthRes.json();
    const secJson = await secRes.json();

    if (secJson.success) {
      const currentKeyEl = document.getElementById('currentKeyMasked');
      if (currentKeyEl) currentKeyEl.innerText = secJson.data.hmac_secret_masked;
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
              <strong style="color:var(--primary);">${d.role || 'CORE (数据中台)'}</strong>
            </div>
            <div style="display:flex; justify-content:space-between; border-bottom:1px solid #e2e8f0; padding-bottom:0.4rem;">
              <span style="color:var(--text-sub);">运行环境版本:</span>
              <span><code>${d.node_version}</code> (运行 <code>${d.uptime_seconds}</code> 秒)</span>
            </div>
            <div style="display:flex; justify-content:space-between; border-bottom:1px solid #e2e8f0; padding-bottom:0.4rem;">
              <span style="color:var(--text-sub);">内存堆使用 (RSS):</span>
              <span><code>${d.memory_heap_mb} MB</code> (常驻内存: <code>${d.memory_rss_mb} MB</code>)</span>
            </div>
            <div style="display:flex; justify-content:space-between; border-bottom:1px solid #e2e8f0; padding-bottom:0.4rem;">
              <span style="color:var(--text-sub);">服务器操作系统:</span>
              <span><code>${d.system_os}</code></span>
            </div>
            <div style="display:flex; justify-content:space-between;">
              <span style="color:var(--text-sub);">存储健康状态:</span>
              <span style="color:var(--success); font-weight:700;">${d.storage_status} (HEALTHY)</span>
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
          <strong>[${item.category}]</strong>: <span style="color:var(--success); font-weight:700;">${item.status}</span> - ${item.detail}
        </div>
      `).join('');
    }
    showToast('系统在线自检与拓扑诊断完成');
  }
}
