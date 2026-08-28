async function loadCollectorSystemConfig() {
  try {
    const [ftpRes, mapRes] = await Promise.all([fetch('/api/config/ftp'), fetch('/api/config/map')]);
    const json = await ftpRes.json();
    const mapJson = await mapRes.json();
    if (json.success && json.data) {
      const keyEl = document.getElementById('collectorCurrentHmacKeyStr');
      if (keyEl) {
        keyEl.innerText = json.data.hmac_secret_masked || '未设置';
      }
      const upgradeKeyEl = document.getElementById('collectorCurrentUpgradeKeyStr');
      if (upgradeKeyEl) {
        upgradeKeyEl.innerText = json.data.upgrade_signing_key_masked || '未设置';
      }
      const syncBadgeEl = document.getElementById('collectorSyncUpgradeKeyBadge');
      if (syncBadgeEl) {
        if (json.data.upgrade_signing_key_synced) {
          syncBadgeEl.innerText = '与升级密钥已对齐';
          syncBadgeEl.style.color = '#0284c7';
          syncBadgeEl.style.background = '#e0f2fe';
        } else {
          syncBadgeEl.innerText = '与升级密钥独立';
          syncBadgeEl.style.color = '#d97706';
          syncBadgeEl.style.background = '#fef3c7';
        }
      }
    }
    if (mapJson.success && mapJson.data) {
      const d = mapJson.data;
      if (document.getElementById('collectorMapTileUrl')) document.getElementById('collectorMapTileUrl').value = d.tile_url_template || '/api/map/tiles/{z}/{x}/{y}.png';
      if (document.getElementById('collectorMapDefaultCenter')) {
        const center = d.default_center || [120.305456, 31.570037];
        document.getElementById('collectorMapDefaultCenter').value = Array.isArray(center) ? center.join(', ') : center;
      }
      if (document.getElementById('collectorMapDefaultZoom')) document.getElementById('collectorMapDefaultZoom').value = d.default_zoom || 12;
    }
  } catch (e) {
    console.error('加载视频网系统配置失败:', e);
  }
}

async function saveCollectorMapConfig() {
  const tileUrl = document.getElementById('collectorMapTileUrl')?.value.trim();
  const rawCenter = document.getElementById('collectorMapDefaultCenter')?.value.trim();
  const zoom = parseInt(document.getElementById('collectorMapDefaultZoom')?.value, 10) || 12;

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

async function saveCollectorHmacSecret() {
  const inputEl = document.getElementById('collectorHmacSecretInput');
  const secret = inputEl ? inputEl.value.trim() : '';
  if (!secret) {
    showToast('请输入新的 HMAC 签名秘钥！', 'error');
    return;
  }
  if (secret.length < 32 || secret.length > 256) {
    showToast('签名秘钥长度必须在 32 ~ 256 个字符之间！', 'error');
    return;
  }

  const syncUpgrade = !!document.getElementById('collectorSyncUpgradeKeyCheckbox')?.checked;

  try {
    const res = await fetch('/api/config/ftp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hmac_secret: secret,
        sync_upgrade_signing_key: syncUpgrade
      })
    });
    const json = await res.json();
    if (json.success) {
      showToast(syncUpgrade ? 'HMAC 与升级签名秘钥已同步保存！' : 'HMAC 签名秘钥更新成功！');
      if (inputEl) inputEl.value = '';
      loadCollectorSystemConfig();
    } else {
      showToast(json.error || '保存 HMAC 秘钥失败', 'error');
    }
  } catch (e) {
    showToast('更新 HMAC 秘钥发生网络错误', 'error');
  }
}

async function uploadCollectorWebPatchUpgrade() {
  const fileInput = document.getElementById('collWebUpgradeFileInput');
  const statusBox = document.getElementById('collWebUpgradeStatusBox');
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
      showToast(json.error || '视频网端在线平滑升级失败', 'error');
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
  const titleEl = document.getElementById('collPatchFileSelectTitle') || document.getElementById('patchFileSelectTitle');
  const subEl = document.getElementById('collPatchFileSelectSub') || document.getElementById('patchFileSelectSub');
  const dropzone = document.getElementById('collPatchDropzone') || document.getElementById('patchDropzone');

  if (input.files && input.files.length > 0) {
    const file = input.files[0];
    const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
    const sizeKB = (file.size / 1024).toFixed(1);
    const sizeStr = file.size > 1024 * 1024 ? `${sizeMB} MB` : `${sizeKB} KB`;

    if (titleEl) titleEl.innerText = `[已选择] ${file.name}`;
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

window.saveCollectorMapConfig = saveCollectorMapConfig;
window.saveCollectorHmacSecret = saveCollectorHmacSecret;
window.uploadCollectorWebPatchUpgrade = uploadCollectorWebPatchUpgrade;
window.onUpgradeFileSelected = onUpgradeFileSelected;

Object.assign(window.VFusionActions = window.VFusionActions || {}, {
  loadCollectorSystemConfig, saveCollectorHmacSecret, uploadCollectorWebPatchUpgrade,
  onUpgradeFileSelected, saveCollectorMapConfig
});
