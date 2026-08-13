let cachedCollectorFtpServersData = [];

async function loadCollectorFtpConfig() {
  await loadCollectorFtpServersList();
}

async function loadCollectorFtpServersList() {
  const tbody = document.getElementById('collFtpServersTbody');
  const countBadge = document.getElementById('collFtpNodeCountBadge');
  if (!tbody) return;

  try {
    const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const res = await fetchFn('/api/ftp/servers');
    const json = await res.json();
    if (json.success && Array.isArray(json.data)) {
      cachedCollectorFtpServersData = json.data;
      if (countBadge) countBadge.innerText = `${cachedCollectorFtpServersData.length} 个节点`;
      renderCollectorFtpServers();
    }
  } catch (e) {
    console.error('加载视频网 FTP 列表失败:', e);
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:#b91c1c;">加载节点列表异常</td></tr>`;
  }
}

function renderCollectorFtpServers() {
  const tbody = document.getElementById('collFtpServersTbody');
  if (!tbody) return;

  if (cachedCollectorFtpServersData.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--text-muted);">暂无接入的第三方 FTP 服务器节点，请点击右上角【+ 注册 FTP 服务器节点】添加</td></tr>`;
    return;
  }

  tbody.innerHTML = cachedCollectorFtpServersData.map((item, idx) => {
    const isEnabled = item.ftp_enabled !== false;
    let statusText = item.last_push_status || '待单据推送';
    let statusBadgeColor = '#e0f2fe';
    let statusTextColor = '#0369a1';

    if (!isEnabled) {
      statusText = '已停用通道';
      statusBadgeColor = '#f1f5f9';
      statusTextColor = '#94a3b8';
    } else if (statusText.includes('成功')) {
      statusBadgeColor = '#dcfce7';
      statusTextColor = '#15803d';
    } else if (statusText.includes('异常') || statusText.includes('失败')) {
      statusBadgeColor = '#fee2e2';
      statusTextColor = '#b91c1c';
    }

    return `
      <tr>
        <td class="col-idx" style="text-align:center;">${idx + 1}</td>
        <td><strong style="color:var(--text-main); font-weight:600;">${escapeHtml(item.name || '未命名')}</strong></td>
        <td><code style="font-family:monospace; font-weight:600; color:#1e293b;">${escapeHtml(item.ftp_host)}:${item.ftp_port || 21}</code></td>
        <td>
          <div style="font-size:0.75rem;"><code style="color:var(--primary); font-family:monospace;">${escapeHtml(item.ftp_remote_dir || '/')}</code></div>
          <div style="font-size:0.7rem; color:var(--text-muted); margin-top:2px;">前缀: ${escapeHtml(item.pkg_prefix || 'vfusion_')} | 后缀: ${escapeHtml(item.ftp_file_ext || '.jpg')}</div>
        </td>
        <td>
          <div style="display:flex; align-items:center; gap:0.4rem;">
            <label class="toggle-switch" style="width:32px; height:16px; margin:0;" title="${isEnabled ? '点击关闭通道' : '点击开启通道'}">
              <input type="checkbox" ${isEnabled ? 'checked' : ''} onchange="toggleCollectorFtpNode('${item.id}', this.checked)">
              <span class="toggle-slider"></span>
            </label>
            <span style="font-size:0.75rem; color:${isEnabled ? '#15803d' : '#94a3b8'}; font-weight:600;">
              ${isEnabled ? '开启' : '关闭'}
            </span>
          </div>
        </td>
        <td>
          <span class="badge" style="background:${statusBadgeColor}; color:${statusTextColor}; padding:2px 8px; border-radius:4px; font-size:0.725rem; display:inline-block; max-width:280px; word-break:break-all;" title="${escapeHtml(statusText)}">
            ${escapeHtml(statusText)}
          </span>
        </td>
        <td style="text-align:center;">
          <div style="display:inline-flex; gap:0.35rem; align-items:center; justify-content:center;">
            <button class="btn btn-diode" style="padding:0.25rem 0.55rem; font-size:0.75rem; white-space:nowrap;" onclick="testCollectorFtpNode('${item.id}')" title="测试连通性">测试</button>
            <button class="btn btn-secondary" style="padding:0.25rem 0.55rem; font-size:0.75rem; white-space:nowrap;" onclick="openEditCollectorFtpModal('${item.id}')">编辑</button>
            <button class="btn btn-danger" style="padding:0.25rem 0.55rem; font-size:0.75rem; white-space:nowrap;" onclick="deleteCollectorFtpNode('${item.id}')">移除</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function openAddCollectorFtpModal() {
  document.getElementById('collFtpNodeNameInput').value = '';
  document.getElementById('collFtpNodeHostInput').value = '';
  document.getElementById('collFtpNodePortInput').value = '21';
  document.getElementById('collFtpNodeUserInput').value = '';
  document.getElementById('collFtpNodePasswordInput').value = '';
  document.getElementById('collFtpNodeRemoteDirInput').value = '/vfusion_packages';
  document.getElementById('collFtpNodePrefixInput').value = 'vfusion_';
  document.getElementById('collFtpNodeExtSelect').value = '.jpg';
  document.getElementById('collFtpNodeEnableToggle').checked = true;

  const box = document.getElementById('collFtpNodeFormStatus');
  if (box) box.style.display = 'none';

  const modal = document.getElementById('addCollectorFtpModal');
  if (modal) modal.style.display = 'flex';
}

function closeAddCollectorFtpModal() {
  const modal = document.getElementById('addCollectorFtpModal');
  if (modal) modal.style.display = 'none';
}

async function handleAddCollectorFtpSubmit(e) {
  if (e) e.preventDefault();
  const name = document.getElementById('collFtpNodeNameInput').value.trim();
  const host = document.getElementById('collFtpNodeHostInput').value.trim();
  const port = parseInt(document.getElementById('collFtpNodePortInput').value) || 21;
  const user = document.getElementById('collFtpNodeUserInput').value.trim();
  const password = document.getElementById('collFtpNodePasswordInput').value;
  const remoteDir = document.getElementById('collFtpNodeRemoteDirInput').value.trim() || '/vfusion_packages';
  const prefix = document.getElementById('collFtpNodePrefixInput').value.trim() || 'vfusion_';
  const ext = document.getElementById('collFtpNodeExtSelect').value;
  const enabled = document.getElementById('collFtpNodeEnableToggle').checked;

  if (!host) {
    showToast('请输入 FTP 服务器 IP 地址或域名！', 'error');
    return;
  }

  try {
    const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const res = await fetchFn('/api/ftp/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name || `视频网 FTP_${host}`,
        ftp_host: host,
        ftp_port: port,
        ftp_user: user,
        ftp_password: password,
        ftp_remote_dir: remoteDir,
        pkg_prefix: prefix,
        ftp_file_ext: ext,
        ftp_enabled: enabled
      })
    });
    const json = await res.json();
    if (json.success) {
      showToast('视频网 FTP 通道节点注册成功！');
      closeAddCollectorFtpModal();
      loadCollectorFtpServersList();
    } else {
      showToast(json.error || '添加 FTP 节点失败', 'error');
    }
  } catch (e) {
    showToast('网络交互错误', 'error');
  }
}

async function toggleCollectorFtpNode(id, enabled) {
  try {
    const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const res = await fetchFn(`/api/ftp/servers/${id}/toggle`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.message);
      loadCollectorFtpServersList();
    } else {
      showToast(json.error || '切换通道状态失败', 'error');
      loadCollectorFtpServersList();
    }
  } catch (e) {
    showToast('网络交互错误', 'error');
    loadCollectorFtpServersList();
  }
}

async function deleteCollectorFtpNode(id) {
  if (!confirm('确定要移除指定的 FTP 服务器通道节点吗？')) return;
  try {
    const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const res = await fetchFn(`/api/ftp/servers/${id}`, { method: 'DELETE' });
    const json = await res.json();
    if (json.success) {
      showToast('FTP 通道节点已移除');
      loadCollectorFtpServersList();
    } else {
      showToast(json.error || '移除失败', 'error');
    }
  } catch (e) {
    showToast('网络交互错误', 'error');
  }
}

async function testCollectorFtpNode(id) {
  showToast('正在测试连通性，请稍候...');
  try {
    const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const res = await fetchFn(`/api/ftp/servers/${id}/test`, { method: 'POST' });
    const json = await res.json();
    if (json.success) {
      showToast(json.message);
    } else {
      showToast(json.error || '测试失败', 'error');
    }
  } catch (e) {
    showToast('网络交互错误', 'error');
  }
}

async function testNewCollectorFtpNodeForm() {
  const host = document.getElementById('collFtpNodeHostInput').value.trim();
  const port = parseInt(document.getElementById('collFtpNodePortInput').value) || 21;
  const user = document.getElementById('collFtpNodeUserInput').value.trim();
  const password = document.getElementById('collFtpNodePasswordInput').value;
  const remoteDir = document.getElementById('collFtpNodeRemoteDirInput').value.trim() || '/vfusion_packages';

  const box = document.getElementById('collFtpNodeFormStatus');
  if (!host) {
    showToast('请填写 IP 地址或域名！', 'error');
    return;
  }

  if (box) {
    box.style.display = 'block';
    box.style.background = '#eff6ff';
    box.style.border = '1px solid #bfdbfe';
    box.style.color = '#1d4ed8';
    box.innerText = `连接 [${host}:${port}] 测试中...`;
  }

  try {
    const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const res = await fetchFn('/api/ftp/servers/new/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ftp_host: host, ftp_port: port, ftp_user: user, ftp_password: password, ftp_remote_dir: remoteDir })
    });
    const json = await res.json();
    if (json.success) {
      if (box) {
        box.style.background = '#f0fdf4';
        box.style.border = '1px solid #bbf7d0';
        box.style.color = '#15803d';
        box.innerText = `[成功] ${json.message}`;
      }
      showToast('FTP 节点测试通过！');
    } else {
      if (box) {
        box.style.background = '#fef2f2';
        box.style.border = '1px solid #fecaca';
        box.style.color = '#b91c1c';
        box.innerText = `[失败] 测试失败: ${json.error}`;
      }
      showToast(json.error || '连通性测试失败', 'error');
    }
  } catch (e) {
    if (box) {
      box.style.background = '#fef2f2';
      box.style.border = '1px solid #fecaca';
      box.style.color = '#b91c1c';
      box.innerText = `[失败] 网络错误: ${e.message}`;
    }
    showToast('无法连接服务端测试接口', 'error');
  }
}

function openEditCollectorFtpModal(id) {
  const item = cachedCollectorFtpServersData.find(s => String(s.id) === String(id));
  if (!item) return;
  document.getElementById('editCollFtpId').value = item.id;
  document.getElementById('editCollFtpName').value = item.name || '';
  document.getElementById('editCollFtpHost').value = item.ftp_host || '';
  document.getElementById('editCollFtpPort').value = item.ftp_port || 21;
  document.getElementById('editCollFtpUser').value = item.ftp_user || '';
  document.getElementById('editCollFtpPassword').value = item.ftp_password || '';
  document.getElementById('editCollFtpRemoteDir').value = item.ftp_remote_dir || '/vfusion_packages';
  document.getElementById('editCollFtpPrefix').value = item.pkg_prefix || 'vfusion_';
  document.getElementById('editCollFtpExt').value = item.ftp_file_ext || '.jpg';
  document.getElementById('editCollFtpEnabled').checked = item.ftp_enabled !== false;

  const modal = document.getElementById('editCollectorFtpModal');
  if (modal) modal.style.display = 'flex';
}

function closeEditCollectorFtpModal() {
  const modal = document.getElementById('editCollectorFtpModal');
  if (modal) modal.style.display = 'none';
}

async function handleSaveCollectorFtpServer(e) {
  if (e) e.preventDefault();
  const id = document.getElementById('editCollFtpId').value;
  const name = document.getElementById('editCollFtpName').value.trim();
  const host = document.getElementById('editCollFtpHost').value.trim();
  const port = parseInt(document.getElementById('editCollFtpPort').value) || 21;
  const user = document.getElementById('editCollFtpUser').value.trim();
  const password = document.getElementById('editCollFtpPassword').value;
  const remoteDir = document.getElementById('editCollFtpRemoteDir').value.trim() || '/vfusion_packages';
  const prefix = document.getElementById('editCollFtpPrefix').value.trim() || 'vfusion_';
  const ext = document.getElementById('editCollFtpExt').value;
  const enabled = document.getElementById('editCollFtpEnabled').checked;

  if (!host) {
    showToast('请输入 IP 地址或域名！', 'error');
    return;
  }

  try {
    const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const res = await fetchFn(`/api/ftp/servers/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        ftp_host: host,
        ftp_port: port,
        ftp_user: user,
        ftp_password: password,
        ftp_remote_dir: remoteDir,
        pkg_prefix: prefix,
        ftp_file_ext: ext,
        ftp_enabled: enabled
      })
    });
    const json = await res.json();
    if (json.success) {
      showToast('FTP 节点更新成功！');
      closeEditCollectorFtpModal();
      loadCollectorFtpServersList();
    } else {
      showToast(json.error || '更新 FTP 节点失败', 'error');
    }
  } catch (e) {
    showToast('网络交互错误', 'error');
  }
}

// 兼容函数保留
async function testCollectorFtpConnection() {
  await testNewCollectorFtpNodeForm();
}
async function saveCollectorFtpConfig() {
  showToast('提示：请使用列表中单个节点的 Toggle 开关或编辑弹窗进行配置保存');
}
