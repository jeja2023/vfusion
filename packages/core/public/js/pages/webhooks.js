let webhookCurrentPage = 1, webhookPageSize = 10;
let cachedWebhooksData = [];
let filteredWebhooksData = [];
let currentNewWebhookSecret = '';
let currentSyncTokenValue = '';
let isSyncTokenVisible = false;

async function loadWebhooks() {
  loadSyncTokenConfig();
  try {
    const res = await fetch('/api/webhooks');
    const json = await res.json();
    if (json.success) {
      cachedWebhooksData = json.data || [];
      updateWebhookStatistics();
      filterWebhooks();
    }
  } catch (e) {
    console.error('加载 Webhooks 失败:', e);
    showToast('加载第三方分发节点失败: ' + e.message, 'error');
  }
}

function refreshWebhooksList() {
  loadWebhooks();
  showToast('已刷新第三方分发节点列表');
}

function updateWebhookStatistics() {
  const total = cachedWebhooksData.length;
  let active = 0, disabled = 0, errors = 0;

  cachedWebhooksData.forEach(item => {
    if (item.enabled === false) {
      disabled++;
    } else {
      active++;
      if (item.last_status === 'FAILED') errors++;
    }
  });

  const totalEl = document.getElementById('statWebhookTotal');
  const activeEl = document.getElementById('statWebhookActive');
  const disabledEl = document.getElementById('statWebhookDisabled');
  const errorsEl = document.getElementById('statWebhookErrors');

  if (totalEl) totalEl.innerText = total;
  if (activeEl) activeEl.innerText = active;
  if (disabledEl) disabledEl.innerText = disabled;
  if (errorsEl) errorsEl.innerText = errors;
}

function filterWebhooks() {
  const keywordEl = document.getElementById('webhookSearchKeyword');
  const filterEl = document.getElementById('webhookStatusFilter');

  const keyword = keywordEl ? keywordEl.value.trim().toLowerCase() : '';
  const statusFilter = filterEl ? filterEl.value : 'ALL';

  filteredWebhooksData = cachedWebhooksData.filter(item => {
    const matchKeyword = !keyword ||
      String(item.name || '').toLowerCase().includes(keyword) ||
      String(item.url || '').toLowerCase().includes(keyword) ||
      String(item.id || '').includes(keyword);

    if (!matchKeyword) return false;

    if (statusFilter === 'ENABLED') return item.enabled !== false;
    if (statusFilter === 'DISABLED') return item.enabled === false;
    if (statusFilter === 'FAILED') return item.enabled !== false && item.last_status === 'FAILED';

    return true;
  });

  renderWebhooks();
}

function renderWebhooks() {
  const tbody = document.getElementById('webhookTableBody');
  if (!tbody) return;

  const totalCount = filteredWebhooksData.length;
  const totalPages = Math.ceil(totalCount / webhookPageSize) || 1;
  if (webhookCurrentPage > totalPages) webhookCurrentPage = totalPages;
  if (webhookCurrentPage < 1) webhookCurrentPage = 1;

  if (document.getElementById('webhookTotalCount')) document.getElementById('webhookTotalCount').innerText = totalCount;
  if (document.getElementById('webhookCurrentPageText')) document.getElementById('webhookCurrentPageText').innerText = webhookCurrentPage;
  if (document.getElementById('webhookTotalPagesText')) document.getElementById('webhookTotalPagesText').innerText = totalPages;
  if (document.getElementById('webhookPrevBtn')) document.getElementById('webhookPrevBtn').disabled = webhookCurrentPage <= 1;
  if (document.getElementById('webhookNextBtn')) document.getElementById('webhookNextBtn').disabled = webhookCurrentPage >= totalPages;

  if (totalCount === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align:center; padding:2rem; color:var(--text-muted);">
          <div style="display:flex; flex-direction:column; align-items:center; gap:0.5rem;">
            <svg class="icon-svg" viewBox="0 0 24 24" style="width:28px; height:28px; color:#94a3b8;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <span>暂无符合条件的第三方订阅节点</span>
          </div>
        </td>
      </tr>`;
    return;
  }

  const paged = filteredWebhooksData.slice((webhookCurrentPage - 1) * webhookPageSize, webhookCurrentPage * webhookPageSize);
  tbody.innerHTML = paged.map((item, idx) => {
    const globalIdx = (webhookCurrentPage - 1) * webhookPageSize + idx + 1;
    const isEnabled = item.enabled !== false;
    
    let statusBadge = `<span class="webhook-status-badge disabled">已停用</span>`;
    if (isEnabled) {
      if (item.last_status === 'SUCCESS') {
        statusBadge = `<span class="webhook-status-badge success">推送正常</span>`;
      } else if (item.last_status === 'FAILED') {
        statusBadge = `<span class="webhook-status-badge failed">推送异常${item.fail_count ? ` (${item.fail_count}次)` : ''}</span>`;
      } else {
        statusBadge = `<span class="webhook-status-badge pending">待推送</span>`;
      }
    }

    const maskedSecret = item.secret_masked || '******';

    return `
      <tr>
        <td class="col-idx" style="text-align:center;">${globalIdx}</td>
        <td>
          <div class="webhook-node-name">
            <strong>${escapeHtml(item.name)}</strong>
          </div>
        </td>
        <td>
          <div class="webhook-url-box">
            <span class="webhook-method-tag">POST</span>
            <span class="webhook-url-code" title="${escapeHtml(item.url)}">${escapeHtml(item.url)}</span>
            <button type="button" class="webhook-copy-btn" title="复制完整回调 URL" data-action="copyWebhookText('${escapeHtml(item.url)}')">
              <svg class="icon-svg" viewBox="0 0 24 24" style="width:11px; height:11px;"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
          </div>
        </td>
        <td>
          <div class="webhook-secret-box" title="独立 HMAC-SHA256 签名鉴权密钥">
            <span class="webhook-secret-tag">HMAC</span>
            <code>${escapeHtml(maskedSecret)}</code>
          </div>
        </td>
        <td style="text-align:center;">
          <div style="display:inline-flex; align-items:center; gap:0.35rem;">
            <label class="toggle-switch" style="width:32px; height:16px; margin:0;" title="${isEnabled ? '点击暂停分发' : '点击开启分发'}">
              <input type="checkbox" ${isEnabled ? 'checked' : ''} data-action-change="toggleWebhookNode(${item.id}, this.checked)">
              <span class="toggle-slider"></span>
            </label>
            <span style="font-size:0.75rem; color:${isEnabled ? '#15803d' : '#94a3b8'}; font-weight:600;">
              ${isEnabled ? '开启' : '关闭'}
            </span>
          </div>
        </td>
        <td style="text-align:center;">${statusBadge}</td>
        <td>
          <div class="webhook-action-group">
            <button class="webhook-act-btn test" id="btn-test-hook-${item.id}" data-action="testWebhook(${item.id})" title="连通性测试：模拟推送一条测试单据报文">测试</button>
            <button class="webhook-act-btn replay" data-action="openBatchReplayModal(${item.id})" title="数据补推：对该节点批量补推历史单据">补推</button>
            <button class="webhook-act-btn edit" data-action="openEditWebhookModal(${item.id})" title="编辑节点：修改系统名称与接口地址">编辑</button>
            <button class="webhook-act-btn secret" data-action="rotateWebhookSecret(${item.id})" title="签名凭证：重置或查看独立签名密钥">密钥</button>
            <button class="webhook-act-btn delete" data-action="deleteWebhook(${item.id})" title="删除节点：移除此第三方订阅配置">删除</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function changeWebhookPageSize(val) {
  webhookPageSize = parseInt(val, 10) || 10;
  webhookCurrentPage = 1;
  renderWebhooks();
}

function prevWebhookPage() {
  if (webhookCurrentPage > 1) {
    webhookCurrentPage--;
    renderWebhooks();
  }
}

function nextWebhookPage() {
  webhookCurrentPage++;
  renderWebhooks();
}

function copyWebhookText(text) {
  if (!text) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showToast('已复制到剪贴板！');
    }).catch(() => {
      fallbackCopyText(text);
    });
  } else {
    fallbackCopyText(text);
  }
}

function fallbackCopyText(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    showToast('已复制到剪贴板！');
  } catch (e) {
    showToast('复制失败，请手动选择复制', 'error');
  }
  document.body.removeChild(ta);
}

function openWebhookSecretModal(secret, name = '') {
  currentNewWebhookSecret = secret;
  const box = document.getElementById('webhookSecretCodeBox');
  if (box) {
    box.textContent = secret;
  }
  const modal = document.getElementById('webhookSecretModal');
  if (modal) modal.style.display = 'flex';
}

function closeWebhookSecretModal() {
  const modal = document.getElementById('webhookSecretModal');
  if (modal) modal.style.display = 'none';
  currentNewWebhookSecret = '';
}

function copyWebhookSecretFromModal() {
  if (currentNewWebhookSecret) {
    copyWebhookText(currentNewWebhookSecret);
  }
}

async function toggleWebhookNode(id, enabled) {
  try {
    const res = await fetch(`/api/webhooks/${id}/toggle`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.message);
      loadWebhooks();
    } else {
      showToast(json.error || '切换状态失败', 'error');
      loadWebhooks();
    }
  } catch (e) {
    showToast('网络交互错误', 'error');
    loadWebhooks();
  }
}

function openAddWebhookModal() {
  const nameEl = document.getElementById('hookName');
  const urlEl = document.getElementById('hookUrl');
  if (nameEl) nameEl.value = '';
  if (urlEl) urlEl.value = '';
  const modal = document.getElementById('addWebhookModal');
  if (modal) modal.style.display = 'flex';
}

function closeAddWebhookModal() {
  const modal = document.getElementById('addWebhookModal');
  if (modal) modal.style.display = 'none';
}

async function handleAddWebhookSubmit(e) {
  if (e) e.preventDefault();
  const name = document.getElementById('hookName').value.trim();
  const url = document.getElementById('hookUrl').value.trim();
  if (!name || !url) {
    showToast('请输入系统名称和回调地址！', 'error');
    return;
  }

  try {
    const res = await fetch('/api/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, url, enabled: true })
    });
    const json = await res.json();
    if (json.success) {
      showToast('第三方订阅节点注册成功！');
      closeAddWebhookModal();
      loadWebhooks();
      if (json.data && json.data.secret) {
        openWebhookSecretModal(json.data.secret, name);
      }
    } else {
      showToast(json.error || '注册失败', 'error');
    }
  } catch (err) {
    showToast('网络交互错误: ' + err.message, 'error');
  }
}

function openEditWebhookModal(id) {
  const item = cachedWebhooksData.find(h => h.id === id);
  if (!item) return;
  document.getElementById('editWebhookId').value = item.id;
  document.getElementById('editWebhookName').value = item.name || '';
  document.getElementById('editWebhookUrl').value = item.url || '';
  if (document.getElementById('editWebhookEnabled')) {
    document.getElementById('editWebhookEnabled').checked = item.enabled !== false;
  }
  const modal = document.getElementById('editWebhookModal');
  if (modal) modal.style.display = 'flex';
}

function closeEditWebhookModal() {
  const modal = document.getElementById('editWebhookModal');
  if (modal) modal.style.display = 'none';
}

async function handleSaveWebhook(e) {
  if (e) e.preventDefault();
  const id = document.getElementById('editWebhookId').value;
  const name = document.getElementById('editWebhookName').value.trim();
  const url = document.getElementById('editWebhookUrl').value.trim();
  const enabled = document.getElementById('editWebhookEnabled') ? document.getElementById('editWebhookEnabled').checked : true;

  if (!name || !url) {
    showToast('请输入系统名称和回调地址！', 'error');
    return;
  }

  try {
    const res = await fetch(`/api/webhooks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, url, enabled })
    });
    const json = await res.json();
    if (json.success) {
      showToast('第三方订阅节点更新成功！');
      closeEditWebhookModal();
      loadWebhooks();
    } else {
      showToast(json.error || '更新失败', 'error');
    }
  } catch (err) {
    showToast('请求发生错误: ' + err.message, 'error');
  }
}

function showWebhookTestPanel(type, title, detail) {
  const panel = document.getElementById('webhookTestResultPanel');
  const titleEl = document.getElementById('webhookTestResultTitle');
  const detailEl = document.getElementById('webhookTestResultDetail');
  if (!panel || !titleEl || !detailEl) return;

  panel.className = `webhook-result-panel ${type}`;
  panel.style.display = 'flex';
  titleEl.innerText = title;
  detailEl.innerText = detail;
}

function closeWebhookTestResultPanel() {
  const panel = document.getElementById('webhookTestResultPanel');
  if (panel) panel.style.display = 'none';
}

async function testWebhook(id) {
  const btn = document.getElementById(`btn-test-hook-${id}`);
  const item = cachedWebhooksData.find(h => h.id === id);
  const nodeName = item ? item.name : `#${id}`;

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<svg class="icon-svg" style="width:12px; height:12px; animation:spin 1s linear infinite;" viewBox="0 0 24 24"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg> 测试中...`;
  }

  showWebhookTestPanel('info', `正在向 [${nodeName}] 发起 Webhook 连通性测试推送...`, '正在构建加密报文与签名头并建立 HTTP(S) 连接...');

  try {
    const res = await fetch(`/api/webhooks/${id}/test`, { method: 'POST' });
    const json = await res.json();
    if (json.success) {
      showWebhookTestPanel('success', `[推送成功] ${nodeName} 连通性测试通过`, `${json.message} (时间: ${new Date().toLocaleTimeString()})`);
      showToast(`[${nodeName}] Webhook 测试推送成功！`);
    } else {
      showWebhookTestPanel('error', `[推送失败] ${nodeName} 响应异常`, `${json.error || '目标服务未正常响应'} (时间: ${new Date().toLocaleTimeString()})`);
      showToast(json.error || '测试推送失败', 'error');
    }
  } catch (e) {
    showWebhookTestPanel('error', `[网络错误] 测试请求未完成`, `无法连接 Core 服务端: ${e.message}`);
    showToast('发起测试推送发生网络错误', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<svg class="icon-svg" viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> 测试`;
    }
    loadWebhooks();
  }
}

async function deleteWebhook(id) {
  const item = cachedWebhooksData.find(h => h.id === id);
  const name = item ? item.name : `#${id}`;
  if (!confirm(`确认永久移除消息订阅节点 [${name}]？`)) return;

  try {
    const res = await fetch(`/api/webhooks/${id}`, { method: 'DELETE' });
    const json = await res.json();
    if (json.success) {
      showToast('订阅节点已移除');
      loadWebhooks();
    } else {
      showToast(json.error || '移除失败', 'error');
    }
  } catch (e) {
    showToast('移除请求失败: ' + e.message, 'error');
  }
}

async function rotateWebhookSecret(id) {
  const item = cachedWebhooksData.find(h => h.id === id);
  const name = item ? item.name : `#${id}`;
  if (!confirm(`确定轮换 [${name}] 的独立签名密钥？\n轮换后旧签名密钥立即失效，需重新配置接收系统。`)) return;

  try {
    const res = await fetch(`/api/webhooks/${id}/rotate-secret`, { method: 'POST' });
    const json = await res.json();
    if (!json.success) return showToast(json.error || '密钥轮换失败', 'error');
    
    showToast(`[${name}] 签名密钥已轮换`);
    loadWebhooks();
    if (json.data && json.data.secret) {
      openWebhookSecretModal(json.data.secret, name);
    }
  } catch (e) {
    showToast('密钥轮换请求失败: ' + e.message, 'error');
  }
}

async function openBatchReplayModal(id) {
  const item = cachedWebhooksData.find(h => h.id === id);
  if (!item) return;

  const idEl = document.getElementById('batchReplayHookId');
  const nameEl = document.getElementById('batchReplayHookName');
  const urlEl = document.getElementById('batchReplayHookUrl');
  const taskSelect = document.getElementById('batchReplayTaskFilter');
  const resultBox = document.getElementById('batchReplayResultBox');

  if (idEl) idEl.value = item.id;
  if (nameEl) nameEl.innerText = item.name;
  if (urlEl) urlEl.innerText = item.url;
  if (resultBox) { resultBox.style.display = 'none'; resultBox.innerHTML = ''; }

  if (taskSelect) {
    taskSelect.innerHTML = '<option value="">全量历史单据 (不限任务)</option>';
    try {
      const res = await fetch('/api/tasks');
      const json = await res.json();
      if (json.success && Array.isArray(json.data)) {
        json.data.forEach(t => {
          taskSelect.innerHTML += `<option value="${escapeHtml(t.task_code)}">${escapeHtml(t.task_name || t.task_code)} (${escapeHtml(t.task_code)})</option>`;
        });
      }
    } catch (e) {}
  }

  const modal = document.getElementById('batchReplayWebhookModal');
  if (modal) modal.style.display = 'flex';
}

function closeBatchReplayModal() {
  const modal = document.getElementById('batchReplayWebhookModal');
  if (modal) modal.style.display = 'none';
}

async function submitBatchReplay(e) {
  if (e) e.preventDefault();
  const id = document.getElementById('batchReplayHookId').value;
  const taskCode = document.getElementById('batchReplayTaskFilter') ? document.getElementById('batchReplayTaskFilter').value : '';
  const limit = document.getElementById('batchReplayLimitSelect') ? document.getElementById('batchReplayLimitSelect').value : 20;
  const submitBtn = document.getElementById('btnSubmitBatchReplay');
  const resultBox = document.getElementById('batchReplayResultBox');

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<svg class="icon-svg" style="width:12px; height:12px; animation:spin 1s linear infinite;" viewBox="0 0 24 24"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg> 批量补推送中...';
  }

  try {
    const res = await fetch(`/api/webhooks/${id}/batch-redispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_code: taskCode || undefined, limit: parseInt(limit, 10) })
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.message || '批量补推送完成');
      if (resultBox) {
        resultBox.style.display = 'block';
        resultBox.style.background = '#f0fdf4';
        resultBox.style.border = '1px solid #bbf7d0';
        resultBox.style.color = '#15803d';
        const details = (json.results || []).map(r => `<div>[${r.ok ? '✓' : '✕'}] ${escapeHtml(r.event_id)} (${escapeHtml(r.task_name || '-')}) -> HTTP ${r.statusCode || 'ERR'} (${r.durationMs || 0}ms)${r.error ? ` - ${escapeHtml(r.error)}` : ''}</div>`).join('');
        resultBox.innerHTML = `<strong>${escapeHtml(json.message)}</strong><div style="margin-top:4px; max-height:120px; overflow-y:auto;">${details}</div>`;
      }
    } else {
      showToast(json.error || '批量补推送失败', 'error');
      if (resultBox) {
        resultBox.style.display = 'block';
        resultBox.style.background = '#fef2f2';
        resultBox.style.border = '1px solid #fecaca';
        resultBox.style.color = '#b91c1c';
        resultBox.innerHTML = `<strong>补推送失败：</strong> ${escapeHtml(json.error || '未知错误')}`;
      }
    }
  } catch (err) {
    showToast('批量补推送请求异常: ' + err.message, 'error');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<svg class="icon-svg" viewBox="0 0 24 24" style="width:13px; height:13px;"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> 再次执行批量补推';
    }
    loadWebhooks();
  }
}

// ========== 第三方图片同步固定服务令牌 (Sync Token) 管理 ==========

async function loadSyncTokenConfig() {
  const input = document.getElementById('syncTokenInput');
  if (!input) return;
  try {
    const res = await fetch('/api/config/sync-token');
    const json = await res.json();
    if (json.success && json.data) {
      currentSyncTokenValue = json.data.sync_token || '';
      input.value = currentSyncTokenValue;
      input.type = isSyncTokenVisible ? 'text' : 'password';
    } else {
      input.value = '未设置';
    }
  } catch (e) {
    console.error('读取固定同步令牌失败:', e);
    if (input) input.value = '加载失败';
  }
}

function toggleSyncTokenVisibility() {
  const input = document.getElementById('syncTokenInput');
  const text = document.getElementById('textToggleSyncToken');
  if (!input) return;
  isSyncTokenVisible = !isSyncTokenVisible;
  input.type = isSyncTokenVisible ? 'text' : 'password';
  if (text) text.innerText = isSyncTokenVisible ? '隐藏' : '显示';
}

function copySyncToken() {
  if (!currentSyncTokenValue) {
    showToast('暂无有效的同步令牌可复制', 'warning');
    return;
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(currentSyncTokenValue)
      .then(() => showToast('已成功复制第三方图片同步固定令牌至剪贴板', 'success'))
      .catch(() => fallbackCopySyncToken());
  } else {
    fallbackCopySyncToken();
  }
}

function fallbackCopySyncToken() {
  const input = document.getElementById('syncTokenInput');
  if (!input) return;
  const originalType = input.type;
  input.type = 'text';
  input.focus();
  input.select();
  try {
    document.execCommand('copy');
    showToast('已复制固定令牌至剪贴板', 'success');
  } catch (e) {
    showToast('复制失败，请手动选中文本复制', 'error');
  } finally {
    input.type = isSyncTokenVisible ? 'text' : 'password';
  }
}

function rotateSyncToken() {
  const modal = document.getElementById('rotateSyncTokenModal');
  if (modal) modal.style.display = 'flex';
}

function closeRotateSyncTokenModal() {
  const modal = document.getElementById('rotateSyncTokenModal');
  if (modal) modal.style.display = 'none';
}

async function confirmRotateSyncToken() {
  const btn = document.getElementById('btnConfirmRotateSyncToken');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/config/sync-token/rotate', { method: 'POST' });
    const json = await res.json();
    if (json.success && json.data) {
      currentSyncTokenValue = json.data.sync_token;
      const input = document.getElementById('syncTokenInput');
      if (input) input.value = currentSyncTokenValue;
      closeRotateSyncTokenModal();
      showToast('固定服务令牌已成功重新生成，请及时同步至第三方系统', 'success');
    } else {
      showToast(json.error || '重新生成失败', 'error');
    }
  } catch (e) {
    showToast('请求异常: ' + e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function openCustomSyncTokenPrompt() {
  const input = document.getElementById('customSyncTokenInput');
  if (input) input.value = currentSyncTokenValue || '';
  const modal = document.getElementById('customSyncTokenModal');
  if (modal) modal.style.display = 'flex';
  setTimeout(() => input && input.focus(), 50);
}

function closeCustomSyncTokenModal() {
  const modal = document.getElementById('customSyncTokenModal');
  if (modal) modal.style.display = 'none';
}

function generateRandomSyncTokenForModal() {
  const input = document.getElementById('customSyncTokenInput');
  if (!input) return;
  const chars = '0123456789abcdef';
  let randHex = '';
  for (let i = 0; i < 48; i++) randHex += chars[Math.floor(Math.random() * chars.length)];
  input.value = `vfusion_sync_${randHex}`;
  showToast('已生成高强度随机令牌', 'info');
}

async function submitCustomSyncToken(event) {
  if (event) event.preventDefault();
  const input = document.getElementById('customSyncTokenInput');
  const custom = input ? input.value.trim() : '';
  if (!custom || custom.length < 16) {
    showToast('令牌长度不能少于 16 个字符', 'warning');
    return;
  }

  const btn = document.getElementById('btnSubmitCustomSyncToken');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch('/api/config/sync-token', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sync_token: custom })
    });
    const json = await res.json();
    if (json.success && json.data) {
      currentSyncTokenValue = json.data.sync_token;
      const mainInput = document.getElementById('syncTokenInput');
      if (mainInput) mainInput.value = currentSyncTokenValue;
      closeCustomSyncTokenModal();
      showToast('自定义固定服务令牌已成功保存并立即生效', 'success');
    } else {
      showToast(json.error || '保存失败', 'error');
    }
  } catch (e) {
    showToast('保存异常: ' + e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// 暴露操作方法给全局与事件代理
Object.assign(window.VFusionActions = window.VFusionActions || {}, {
  loadWebhooks, refreshWebhooksList, filterWebhooks, renderWebhooks,
  changeWebhookPageSize, prevWebhookPage, nextWebhookPage,
  copyWebhookText, openWebhookSecretModal, closeWebhookSecretModal, copyWebhookSecretFromModal,
  toggleWebhookNode, openAddWebhookModal, closeAddWebhookModal, handleAddWebhookSubmit,
  openEditWebhookModal, closeEditWebhookModal, handleSaveWebhook,
  showWebhookTestPanel, closeWebhookTestResultPanel,
  testWebhook, deleteWebhook, rotateWebhookSecret,
  openBatchReplayModal, closeBatchReplayModal, submitBatchReplay,
  loadSyncTokenConfig, toggleSyncTokenVisibility, copySyncToken,
  rotateSyncToken, closeRotateSyncTokenModal, confirmRotateSyncToken,
  openCustomSyncTokenPrompt, closeCustomSyncTokenModal, generateRandomSyncTokenForModal, submitCustomSyncToken
});
