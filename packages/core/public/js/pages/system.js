async function loadSystemHealth() {
  try {
    const [healthRes, secRes, mapRes] = await Promise.all([
      fetch('/api/system/health'),
      fetch('/api/config/security'),
      fetch('/api/config/map')
    ]);
    const json = await healthRes.json();
    const secJson = await secRes.json();
    const mapJson = await mapRes.json();

    if (secJson.success) {
      const currentKeyEl = document.getElementById('currentKeyMasked');
      if (currentKeyEl) currentKeyEl.innerText = secJson.data.hmac_secret || secJson.data.hmac_secret_masked || '未设置';
    }

    if (mapJson.success && mapJson.data) {
      const d = mapJson.data;
      if (document.getElementById('coreMapTileUrl')) document.getElementById('coreMapTileUrl').value = d.tile_url_template || '/api/map/tiles/{z}/{x}/{y}.png';
      if (document.getElementById('coreMapDefaultCenter')) {
        const center = d.default_center || [120.305456, 31.570037];
        document.getElementById('coreMapDefaultCenter').value = Array.isArray(center) ? center.join(', ') : center;
      }
      if (document.getElementById('coreMapDefaultZoom')) document.getElementById('coreMapDefaultZoom').value = d.default_zoom || 12;
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

async function rotateHmacSecret() {
  const newSec = document.getElementById('newHmacSecretInput')?.value.trim();
  if (!newSec) { showToast('请输入新秘钥！', 'error'); return; }

  const res = await fetch('/api/config/security', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hmac_secret: newSec })
  });
  const json = await res.json();
  if (json.success) {
    showToast('HMAC 签名秘钥在线轮换更新成功！');
    if (document.getElementById('newHmacSecretInput')) document.getElementById('newHmacSecretInput').value = '';
    loadSystemHealth();
  }
}

async function saveCoreMapConfig() {
  const tileUrl = document.getElementById('coreMapTileUrl')?.value.trim();
  const rawCenter = document.getElementById('coreMapDefaultCenter')?.value.trim();
  const zoom = parseInt(document.getElementById('coreMapDefaultZoom')?.value, 10) || 12;

  let center = [120.305456, 31.570037];
  if (rawCenter) {
    const parts = rawCenter.split(/[,，\s]+/).filter(Boolean);
    if (parts.length >= 2) {
      const lng = parseFloat(parts[0]);
      const lat = parseFloat(parts[1]);
      if (!isNaN(lng) && !isNaN(lat)) center = [lng, lat];
    }
  }

  try {
    const res = await fetch('/api/config/map', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tile_url_template: tileUrl,
        default_center: center,
        default_zoom: zoom
      })
    });
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json.error || '保存地图参数失败');
    showToast('高德离线地图配置已成功保存！');
  } catch (e) {
    showToast(e.message, 'error');
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
        statusBox.style.border = '#fecaca';
        statusBox.style.color = '#b91c1c';
        statusBox.innerText = `[失败] 升级失败: ${json.error}`;
      }
      showToast(json.error || '在线平滑升级失败', 'error');
    }
  } catch (e) {
    if (statusBox) {
      statusBox.style.background = '#fef2f2';
      statusBox.style.border = '#fecaca';
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

window.saveCoreMapConfig = saveCoreMapConfig;
window.rotateHmacSecret = rotateHmacSecret;
window.uploadWebPatchUpgrade = uploadWebPatchUpgrade;
window.onUpgradeFileSelected = onUpgradeFileSelected;

Object.assign(window.VFusionActions = window.VFusionActions || {}, {
  loadSystemHealth, rotateHmacSecret, uploadWebPatchUpgrade,
  onUpgradeFileSelected, saveCoreMapConfig
});
