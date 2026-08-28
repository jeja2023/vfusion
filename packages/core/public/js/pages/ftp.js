let cachedFtpServersData = [];

async function loadCoreFtpConfig() {
  await loadFtpServersList();
  await loadFtpPollStatus();
}

async function loadFtpServersList() {
  const tbody = document.getElementById('ftpServersTbody');
  const countBadge = document.getElementById('ftpNodeCountBadge');
  if (!tbody) return;

  try {
    const res = await fetch('/api/ftp/servers');
    const json = await res.json();
    if (json.success && Array.isArray(json.data)) {
      cachedFtpServersData = json.data;
      if (countBadge) countBadge.innerText = `${cachedFtpServersData.length} 个节点`;
      renderFtpServers();
    }
  } catch (e) {
    console.error('加载 FTP 服务器列表失败:', e);
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:#b91c1c;">加载节点列表异常</td></tr>`;
  }
}

function renderFtpServers() {
  const tbody = document.getElementById('ftpServersTbody');
  if (!tbody) return;

  if (cachedFtpServersData.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--text-muted);">暂无接入的 FTP 服务器通道节点，请点击右上角【+ 注册 FTP 服务器节点】添加</td></tr>`;
    return;
  }

  tbody.innerHTML = cachedFtpServersData.map((item, idx) => {
    const isEnabled = item.ftp_enabled !== false;
    let statusText = item.last_pull_status || '待轮询抓取';
    let statusBadgeColor = '#e0f2fe';
    let statusTextColor = '#0369a1';

    if (!isEnabled) {
      statusText = '已停用';
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
              <input type="checkbox" ${isEnabled ? 'checked' : ''} data-action-change="toggleFtpNode('${item.id}', this.checked)">
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
            <button class="btn btn-diode" style="padding:0.25rem 0.55rem; font-size:0.75rem; white-space:nowrap;" data-action="testFtpNode('${item.id}')" title="测试连通性">测试</button>
            <button class="btn btn-primary" style="padding:0.25rem 0.55rem; font-size:0.75rem; white-space:nowrap;" data-action="manualFtpPullNode('${item.id}')" title="立即拉取">拉取</button>
            <button class="btn btn-secondary" style="padding:0.25rem 0.55rem; font-size:0.75rem; white-space:nowrap;" data-action="openEditFtpModal('${item.id}')">编辑</button>
            <button class="btn btn-danger" style="padding:0.25rem 0.55rem; font-size:0.75rem; white-space:nowrap;" data-action="deleteFtpNode('${item.id}')">移除</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function openAddFtpModal() {
  document.getElementById('ftpNodeNameInput').value = '';
  document.getElementById('ftpNodeHostInput').value = '';
  document.getElementById('ftpNodePortInput').value = '21';
  document.getElementById('ftpNodeUserInput').value = '';
  document.getElementById('ftpNodePasswordInput').value = '';
  document.getElementById('ftpNodeRemoteDirInput').value = '/vfusion_packages';
  document.getElementById('ftpNodePrefixInput').value = 'vfusion_';
  document.getElementById('ftpNodeExtSelect').value = '.jpg';
  document.getElementById('ftpNodeDeleteToggle').checked = true;
  document.getElementById('ftpNodeEnableToggle').checked = true;

  const box = document.getElementById('ftpNodeFormStatus');
  if (box) box.style.display = 'none';

  const modal = document.getElementById('addFtpServerModal');
  if (modal) modal.style.display = 'flex';
}

function closeAddFtpModal() {
  const modal = document.getElementById('addFtpServerModal');
  if (modal) modal.style.display = 'none';
}

async function handleAddFtpServerSubmit(e) {
  if (e) e.preventDefault();
  const name = document.getElementById('ftpNodeNameInput').value.trim();
  const host = document.getElementById('ftpNodeHostInput').value.trim();
  const port = parseInt(document.getElementById('ftpNodePortInput').value) || 21;
  const user = document.getElementById('ftpNodeUserInput').value.trim();
  const password = document.getElementById('ftpNodePasswordInput').value;
  const remoteDir = document.getElementById('ftpNodeRemoteDirInput').value.trim() || '/vfusion_packages';
  const prefix = document.getElementById('ftpNodePrefixInput').value.trim() || 'vfusion_';
  const ext = document.getElementById('ftpNodeExtSelect').value;
  const deleteAfter = document.getElementById('ftpNodeDeleteToggle').checked;
  const enabled = document.getElementById('ftpNodeEnableToggle').checked;

  if (!host) {
    showToast('请输入 FTP 服务器 IP 地址或域名！', 'error');
    return;
  }

  try {
    const res = await fetch('/api/ftp/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name || `FTP_${host}`,
        ftp_host: host,
        ftp_port: port,
        ftp_user: user,
        ftp_password: password,
        ftp_remote_dir: remoteDir,
        pkg_prefix: prefix,
        ftp_file_ext: ext,
        ftp_delete_after_download: deleteAfter,
        ftp_enabled: enabled
      })
    });
    const json = await res.json();
    if (json.success) {
      showToast('FTP 通道节点注册并添加成功！');
      closeAddFtpModal();
      loadFtpServersList();
      loadFtpPollStatus();
    } else {
      showToast(json.error || '添加 FTP 节点失败', 'error');
    }
  } catch (e) {
    showToast('网络交互错误', 'error');
  }
}

async function toggleFtpNode(id, enabled) {
  try {
    const res = await fetch(`/api/ftp/servers/${id}/toggle`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.message);
      loadFtpServersList();
      loadFtpPollStatus();
    } else {
      showToast(json.error || '切换通道状态失败', 'error');
      loadFtpServersList();
    }
  } catch (e) {
    showToast('网络交互错误', 'error');
    loadFtpServersList();
  }
}

async function deleteFtpNode(id) {
  if (!confirm('确定要移除指定的 FTP 服务器通道节点吗？')) return;
  try {
    const res = await fetch(`/api/ftp/servers/${id}`, { method: 'DELETE' });
    const json = await res.json();
    if (json.success) {
      showToast('FTP 通道节点已移除');
      loadFtpServersList();
      loadFtpPollStatus();
    } else {
      showToast(json.error || '移除失败', 'error');
    }
  } catch (e) {
    showToast('网络交互错误', 'error');
  }
}

async function testFtpNode(id) {
  showToast('正在测试连通性，请稍候...');
  try {
    const res = await fetch(`/api/ftp/servers/${id}/test`, { method: 'POST' });
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

async function testNewFtpNodeForm() {
  const host = document.getElementById('ftpNodeHostInput').value.trim();
  const port = parseInt(document.getElementById('ftpNodePortInput').value) || 21;
  const user = document.getElementById('ftpNodeUserInput').value.trim();
  const password = document.getElementById('ftpNodePasswordInput').value;
  const remoteDir = document.getElementById('ftpNodeRemoteDirInput').value.trim() || '/vfusion_packages';

  const box = document.getElementById('ftpNodeFormStatus');
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
    const res = await fetch('/api/ftp/servers/new/test', {
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

async function manualFtpPullNode(id) {
  const box = document.getElementById('ftpPullResultBox');
  if (box) {
    box.style.display = 'block';
    box.style.background = '#eff6ff';
    box.style.border = '1px solid #bfdbfe';
    box.style.color = '#1d4ed8';
    box.innerText = '正在连接指定的 FTP 节点拉取数据包，请稍候...';
  }

  try {
    const res = await fetch('/api/ftp/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server_id: id })
    });
    const json = await res.json();
    if (json.success) {
      if (box) {
        box.style.background = '#f0fdf4';
        box.style.border = '1px solid #bbf7d0';
        box.style.color = '#15803d';
        box.innerText = `[成功] ${json.message}`;
      }
      showToast(json.message);
      loadFtpServersList();
      loadFtpPollStatus();
    } else {
      if (box) {
        box.style.background = '#fef2f2';
        box.style.border = '1px solid #fecaca';
        box.style.color = '#b91c1c';
        box.innerText = `[失败] ${json.error}`;
      }
      showToast(json.error, 'error');
    }
  } catch (e) {
    showToast('网络交互错误', 'error');
  }
}

async function manualFtpPullAll() {
  const box = document.getElementById('ftpPullResultBox');
  if (box) {
    box.style.display = 'block';
    box.style.background = '#eff6ff';
    box.style.border = '1px solid #bfdbfe';
    box.style.color = '#1d4ed8';
    box.innerText = '正在连接所有【已开启】的 FTP 服务器节点并拉取数据包，请稍候...';
  }

  try {
    const res = await fetch('/api/ftp/pull', { method: 'POST' });
    const json = await res.json();
    if (json.success) {
      if (box) {
        box.style.background = '#f0fdf4';
        box.style.border = '1px solid #bbf7d0';
        box.style.color = '#15803d';
        box.innerText = `[成功] ${json.message}`;
      }
      showToast(json.message);
      loadFtpServersList();
      loadFtpPollStatus();
    } else {
      if (box) {
        box.style.background = '#fef2f2';
        box.style.border = '1px solid #fecaca';
        box.style.color = '#b91c1c';
        box.innerText = `[失败] ${json.error}`;
      }
      showToast(json.error, 'error');
    }
  } catch (e) {
    showToast('网络交互错误', 'error');
  }
}

function openEditFtpModal(id) {
  const item = cachedFtpServersData.find(s => String(s.id) === String(id));
  if (!item) return;
  document.getElementById('editFtpId').value = item.id;
  document.getElementById('editFtpName').value = item.name || '';
  document.getElementById('editFtpHost').value = item.ftp_host || '';
  document.getElementById('editFtpPort').value = item.ftp_port || 21;
  document.getElementById('editFtpUser').value = item.ftp_user || '';
  document.getElementById('editFtpPassword').value = item.ftp_password || '';
  document.getElementById('editFtpRemoteDir').value = item.ftp_remote_dir || '/vfusion_packages';
  document.getElementById('editFtpPrefix').value = item.pkg_prefix || 'vfusion_';
  document.getElementById('editFtpExt').value = item.ftp_file_ext || '.jpg';
  document.getElementById('editFtpDelete').checked = item.ftp_delete_after_download !== false;
  document.getElementById('editFtpEnabled').checked = item.ftp_enabled !== false;

  const modal = document.getElementById('editFtpServerModal');
  if (modal) modal.style.display = 'flex';
}

function closeEditFtpModal() {
  const modal = document.getElementById('editFtpServerModal');
  if (modal) modal.style.display = 'none';
}

async function handleSaveFtpServer(e) {
  if (e) e.preventDefault();
  const id = document.getElementById('editFtpId').value;
  const name = document.getElementById('editFtpName').value.trim();
  const host = document.getElementById('editFtpHost').value.trim();
  const port = parseInt(document.getElementById('editFtpPort').value) || 21;
  const user = document.getElementById('editFtpUser').value.trim();
  const password = document.getElementById('editFtpPassword').value;
  const remoteDir = document.getElementById('editFtpRemoteDir').value.trim() || '/vfusion_packages';
  const prefix = document.getElementById('editFtpPrefix').value.trim() || 'vfusion_';
  const ext = document.getElementById('editFtpExt').value;
  const deleteAfter = document.getElementById('editFtpDelete').checked;
  const enabled = document.getElementById('editFtpEnabled').checked;

  if (!host) {
    showToast('请输入 IP 地址或域名！', 'error');
    return;
  }

  try {
    const res = await fetch(`/api/ftp/servers/${id}`, {
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
        ftp_delete_after_download: deleteAfter,
        ftp_enabled: enabled
      })
    });
    const json = await res.json();
    if (json.success) {
      showToast('FTP 节点更新成功！');
      closeEditFtpModal();
      loadFtpServersList();
      loadFtpPollStatus();
    } else {
      showToast(json.error || '更新 FTP 节点失败', 'error');
    }
  } catch (e) {
    showToast('网络交互错误', 'error');
  }
}

// ========== FTP 轮询引擎全局控制 ==========

async function loadFtpPollStatus() {
  if (typeof currentUser !== 'undefined' && !currentUser) return;
  try {
    const res = await fetch('/api/ftp/poll-status');
    const json = await res.json();
    if (json.success && json.data) {
      const d = json.data;
      const el = document.getElementById('ftpPollStatusDisplay');
      const intervalInput = document.getElementById('ftpPollIntervalInput');
      const toggleInput = document.getElementById('ftpPollEnableToggle');
      const toggleText = document.getElementById('ftpPollEnableText');

      if (toggleInput) {
        toggleInput.checked = !!d.timer_active;
      }
      if (toggleText) {
        toggleText.innerText = d.timer_active ? '已开启自动轮询' : '已停止自动轮询';
      }

      if (intervalInput && d.poll_interval !== undefined && d.poll_interval !== null) {
        intervalInput.value = d.poll_interval;
      }

      if (el) {
        const statusColor = d.timer_active ? '#15803d' : '#b91c1c';
        const statusText = d.timer_active ? '运行中' : '已停止';

        let html = `<div style="display:flex; flex-direction:column; gap:0.25rem;">`;
        html += `<div><strong>运行通道节点:</strong> <span style="color:${d.active_server_count > 0 ? '#15803d' : '#b91c1c'}">${d.active_server_count || 0} / ${d.total_server_count || 0} 个通道开启</span></div>`;
        html += `<div><strong>轮询引擎状态:</strong> <span style="color:${statusColor}">${statusText}</span> (周期 ${d.poll_interval || 0} 秒)</div>`;
        html += `<div><strong>累计拉取数据包:</strong> ${d.downloadedTotal || 0} 个包</div>`;
        if (d.lastPollTime) {
          html += `<div><strong>上次轮询时间:</strong> ${new Date(d.lastPollTime).toLocaleString('zh-CN')}</div>`;
        }
        if (d.lastResult) {
          html += `<div><strong>最近结果:</strong> ${escapeHtml(d.lastResult)}</div>`;
        }
        html += `</div>`;
        el.innerHTML = html;
      }
    }
  } catch (e) {
    console.error('加载 FTP 轮询状态失败:', e);
  }
}

async function onFtpPollToggleChange(enabled) {
  const toggleText = document.getElementById('ftpPollEnableText');
  if (toggleText) {
    toggleText.innerText = enabled ? '已开启自动轮询' : '已停止自动轮询';
  }

  let interval = 0;
  if (enabled) {
    const rawVal = document.getElementById('ftpPollIntervalInput') ? document.getElementById('ftpPollIntervalInput').value.trim() : '10';
    const parsed = parseInt(rawVal, 10);
    interval = (!parsed || parsed <= 0) ? 10 : parsed;
    if (document.getElementById('ftpPollIntervalInput')) {
      document.getElementById('ftpPollIntervalInput').value = interval;
    }
  } else {
    interval = 0;
  }

  await saveFtpPollInterval(interval);
}

async function saveFtpPollInterval(overrideInterval) {
  let interval;
  if (overrideInterval !== undefined) {
    interval = overrideInterval;
  } else {
    const rawVal = document.getElementById('ftpPollIntervalInput').value.trim();
    interval = rawVal === '' ? 0 : Math.max(0, parseInt(rawVal, 10) || 0);
  }
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

// 定时刷新轮询状态 (每 5 秒)
setInterval(loadFtpPollStatus, 5000);
