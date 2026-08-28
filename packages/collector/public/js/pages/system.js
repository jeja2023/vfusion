async function loadCollectorSystemConfig() {
  try {
    const res = await fetch('/api/config/ftp');
    const json = await res.json();
    if (json.success && json.data) {
      const keyEl = document.getElementById('collectorCurrentHmacKeyStr');
      if (keyEl) {
        keyEl.innerText = json.data.hmac_secret_masked || '未设置';
      }
    }
  } catch (e) {
    console.error('加载视频网系统配置失败:', e);
  }
  await loadMonitoringPointAdminTable();
}

Object.assign(window.VFusionActions = window.VFusionActions || {}, {
  loadCollectorSystemConfig, loadMonitoringPointAdminTable, scheduleMonitoringPointAdminSearch,
  exportMonitoringPoints, importMonitoringPoints, resetMonitoringPointForm, editMonitoringPoint,
  saveMonitoringPoint, toggleMonitoringPoint, saveCollectorHmacSecret, uploadCollectorWebPatchUpgrade,
  onUpgradeFileSelected
});

let adminMonitoringPoints = [];
let monitoringPointAdminPage = 1;
let monitoringPointAdminPages = 1;
let monitoringPointAdminSearchTimer = null;

async function loadMonitoringPointAdminTable(page = monitoringPointAdminPage) {
  const body = document.getElementById('monitoringPointsTableBody');
  if (!body) return;
  try {
    const query = document.getElementById('monitoringPointAdminQuery')?.value.trim() || '';
    const res = await fetch(`/api/monitoring-points?include_disabled=1&page=${page}&limit=50&query=${encodeURIComponent(query)}`);
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json.error || '点位表加载失败');
    adminMonitoringPoints = Array.isArray(json.data) ? json.data : [];
    monitoringPointAdminPage = json.pagination?.page || page;
    monitoringPointAdminPages = json.pagination?.pages || 1;
    if (!adminMonitoringPoints.length) {
      body.innerHTML = '<tr><td colspan="7" style="text-align:center; color:#64748b;">尚未维护监控点位</td></tr>';
      renderMonitoringPointAdminPagination(0);
      return;
    }
    body.innerHTML = adminMonitoringPoints.map((point, index) => `
      <tr>
        <td><code>${escapeHtml(point.point_id)}</code></td>
        <td>${escapeHtml(point.name)}</td>
        <td>${escapeHtml(point.longitude ?? '-')}</td>
        <td>${escapeHtml(point.latitude ?? '-')}</td>
        <td>${escapeHtml(point.description || '-')}</td>
        <td><span class="status-badge ${point.enabled === false ? 'status-disabled' : 'status-active'}">${point.enabled === false ? '已停用' : '启用'}</span></td>
        <td style="white-space:nowrap;">
          <button class="btn btn-sm" type="button" data-action="editMonitoringPoint(${index})">编辑</button>
          <button class="btn btn-sm" type="button" data-action="toggleMonitoringPoint(${index})">${point.enabled === false ? '启用' : '停用'}</button>
        </td>
      </tr>
    `).join('');
    renderMonitoringPointAdminPagination(json.pagination?.total || adminMonitoringPoints.length);
  } catch (e) {
    body.innerHTML = `<tr><td colspan="7" style="text-align:center; color:#b91c1c;">${escapeHtml(e.message)}</td></tr>`;
  }
}

function renderMonitoringPointAdminPagination(total) {
  const box = document.getElementById('monitoringPointAdminPagination');
  if (!box) return;
  box.innerHTML = `<span>共 ${total} 条，第 ${monitoringPointAdminPage}/${monitoringPointAdminPages} 页</span>
    <button class="btn btn-sm" ${monitoringPointAdminPage <= 1 ? 'disabled' : ''} data-action="loadMonitoringPointAdminTable(${monitoringPointAdminPage - 1})">上一页</button>
    <button class="btn btn-sm" ${monitoringPointAdminPage >= monitoringPointAdminPages ? 'disabled' : ''} data-action="loadMonitoringPointAdminTable(${monitoringPointAdminPage + 1})">下一页</button>`;
}

function scheduleMonitoringPointAdminSearch() {
  clearTimeout(monitoringPointAdminSearchTimer);
  monitoringPointAdminSearchTimer = setTimeout(() => loadMonitoringPointAdminTable(1), 250);
}

async function exportMonitoringPoints(format) {
  try {
    const res = await fetch(`/api/monitoring-points/export?format=${encodeURIComponent(format)}`);
    if (!res.ok) throw new Error('点位表导出失败');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = format === 'json' ? 'monitoring_points.json' : 'monitoring_points.csv';
    link.click();
    URL.revokeObjectURL(url);
  } catch (e) { showToast(e.message, 'error'); }
}

function parseMonitoringPointCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted && ch === '"' && text[i + 1] === '"') { cell += '"'; i++; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (!quoted && ch === ',') { row.push(cell); cell = ''; continue; }
    if (!quoted && (ch === '\n' || ch === '\r')) { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); if (row.some(value => value.trim())) rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows.shift().map(value => value.trim().toLowerCase());
  return rows.map(values => Object.fromEntries(headers.map((header, index) => [header, (values[index] || '').trim()]))).map(point => ({
    ...point,
    enabled: point.enabled === '' || !['false', '0', 'no', '停用', '禁用'].includes(String(point.enabled).toLowerCase())
  }));
}

async function importMonitoringPoints(input) {
  const file = input?.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = file.name.toLowerCase().endsWith('.json') ? JSON.parse(text) : parseMonitoringPointCsv(text.replace(/^\ufeff/, ''));
    const points = Array.isArray(parsed) ? parsed : parsed.points;
    if (!Array.isArray(points) || !points.length) throw new Error('文件中没有有效点位数据');
    const res = await fetch('/api/monitoring-points/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ points, mode: 'merge' }) });
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json.error || '点位表导入失败');
    showToast(`已导入 ${json.data.imported} 条点位`);
    input.value = '';
    await loadMonitoringPointAdminTable(1);
  } catch (e) { showToast(e.message, 'error'); input.value = ''; }
}

function resetMonitoringPointForm() {
  const form = document.getElementById('monitoringPointForm');
  if (form) form.reset();
  const editing = document.getElementById('monitoringPointEditingId');
  const idInput = document.getElementById('monitoringPointId');
  if (editing) editing.value = '';
  if (idInput) idInput.disabled = false;
}

function editMonitoringPoint(index) {
  const point = adminMonitoringPoints[index];
  if (!point) return;
  document.getElementById('monitoringPointEditingId').value = point.point_id;
  document.getElementById('monitoringPointId').value = point.point_id;
  document.getElementById('monitoringPointId').disabled = true;
  document.getElementById('monitoringPointName').value = point.name || '';
  document.getElementById('monitoringPointLongitude').value = point.longitude ?? '';
  document.getElementById('monitoringPointLatitude').value = point.latitude ?? '';
  document.getElementById('monitoringPointDescription').value = point.description || '';
  document.getElementById('monitoringPointForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function saveMonitoringPoint(event) {
  event.preventDefault();
  const pointId = document.getElementById('monitoringPointId').value.trim();
  const editingId = document.getElementById('monitoringPointEditingId').value.trim();
  const name = document.getElementById('monitoringPointName').value.trim();
  const payload = {
    point_id: pointId,
    name: name,
    location: name,
    longitude: document.getElementById('monitoringPointLongitude').value.trim(),
    latitude: document.getElementById('monitoringPointLatitude').value.trim(),
    description: document.getElementById('monitoringPointDescription').value.trim()
  };
  try {
    const url = editingId ? `/api/monitoring-points/${encodeURIComponent(editingId)}` : '/api/monitoring-points';
    const res = await fetch(url, { method: editingId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json.error || '保存点位失败');
    showToast(editingId ? '监控点位已更新' : '监控点位已新增');
    resetMonitoringPointForm();
    await loadMonitoringPointAdminTable();
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function toggleMonitoringPoint(index) {
  const point = adminMonitoringPoints[index];
  if (!point) return;
  try {
    const res = await fetch(`/api/monitoring-points/${encodeURIComponent(point.point_id)}/toggle`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: point.enabled === false })
    });
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json.error || '更新点位状态失败');
    await loadMonitoringPointAdminTable();
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

  try {
    const res = await fetch('/api/config/ftp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hmac_secret: secret })
    });
    const json = await res.json();
    if (json.success) {
      showToast('HMAC 签名秘钥更新成功！');
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

    if (titleEl) titleEl.innerText = `✓ 已选择: ${file.name}`;
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
