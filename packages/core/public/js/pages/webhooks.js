let webhookCurrentPage = 1, webhookPageSize = 10;
let cachedWebhooksData = [];

async function loadWebhooks() {
  try {
    const res = await fetch('/api/webhooks');
    const json = await res.json();
    if (json.success) {
      cachedWebhooksData = json.data || [];
      renderWebhooks();
    }
  } catch (e) {
    console.error('加载 Webhooks 失败:', e);
  }
}

function renderWebhooks() {
  const tbody = document.getElementById('webhookTableBody');
  if (!tbody) return;

  const totalCount = cachedWebhooksData.length;
  const totalPages = Math.ceil(totalCount / webhookPageSize) || 1;
  if (webhookCurrentPage > totalPages) webhookCurrentPage = totalPages;
  if (webhookCurrentPage < 1) webhookCurrentPage = 1;

  if (document.getElementById('webhookTotalCount')) document.getElementById('webhookTotalCount').innerText = totalCount;
  if (document.getElementById('webhookCurrentPageText')) document.getElementById('webhookCurrentPageText').innerText = webhookCurrentPage;
  if (document.getElementById('webhookTotalPagesText')) document.getElementById('webhookTotalPagesText').innerText = totalPages;
  if (document.getElementById('webhookPrevBtn')) document.getElementById('webhookPrevBtn').disabled = webhookCurrentPage <= 1;
  if (document.getElementById('webhookNextBtn')) document.getElementById('webhookNextBtn').disabled = webhookCurrentPage >= totalPages;

  if (totalCount === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">暂无注册的订阅节点</td></tr>`;
    return;
  }

  const paged = cachedWebhooksData.slice((webhookCurrentPage - 1) * webhookPageSize, webhookCurrentPage * webhookPageSize);
  tbody.innerHTML = paged.map((item, idx) => {
    const globalIdx = (webhookCurrentPage - 1) * webhookPageSize + idx + 1;
    const isEnabled = item.enabled !== false;
    
    let statusBadge = `<span class="badge" style="background:#f1f5f9; color:#94a3b8; padding:2px 8px; border-radius:4px; font-size:0.75rem;">已停用</span>`;
    if (isEnabled) {
      if (item.last_status === 'SUCCESS') {
        statusBadge = `<span class="badge" style="background:#dcfce7; color:#15803d; padding:2px 8px; border-radius:4px; font-size:0.75rem;">推送成功</span>`;
      } else if (item.last_status === 'FAILED') {
        statusBadge = `<span class="badge" style="background:#fee2e2; color:#b91c1c; padding:2px 8px; border-radius:4px; font-size:0.75rem;">推送异常 ${item.fail_count ? `(${item.fail_count}次)` : ''}</span>`;
      } else {
        statusBadge = `<span class="badge" style="background:#e0f2fe; color:#0369a1; padding:2px 8px; border-radius:4px; font-size:0.75rem;">待推送</span>`;
      }
    }

    return `
      <tr>
        <td class="col-idx">${globalIdx}</td>
        <td><strong>${escapeHtml(item.name)}</strong></td>
        <td><code>${escapeHtml(item.url)}</code></td>
        <td>
          <div style="display:flex; align-items:center; gap:0.4rem;">
            <label class="toggle-switch" style="width:32px; height:16px; margin:0;" title="${isEnabled ? '点击停用' : '点击启用'}">
              <input type="checkbox" ${isEnabled ? 'checked' : ''} data-action-change="toggleWebhookNode(${item.id}, this.checked)">
              <span class="toggle-slider"></span>
            </label>
            <span style="font-size:0.75rem; color:${isEnabled ? '#15803d' : '#94a3b8'}; font-weight:600;">
              ${isEnabled ? '已开启' : '已关闭'}
            </span>
          </div>
        </td>
        <td>${statusBadge}</td>
        <td style="display:flex; gap:0.35rem;">
          <button class="btn btn-secondary" style="padding:0.2rem 0.45rem; font-size:0.75rem; white-space:nowrap;" data-action="openEditWebhookModal(${item.id})">编辑</button>
          <button class="btn btn-primary" style="padding:0.2rem 0.45rem; font-size:0.75rem; white-space:nowrap;" data-action="testWebhook(${item.id})">测试推送</button>
          <button class="btn btn-secondary" style="padding:0.2rem 0.45rem; font-size:0.75rem; white-space:nowrap;" data-action="rotateWebhookSecret(${item.id})">轮换密钥</button>
          <button class="btn btn-danger" style="padding:0.2rem 0.45rem; font-size:0.75rem; white-space:nowrap;" data-action="deleteWebhook(${item.id})">移除</button>
        </td>
      </tr>
    `;
  }).join('');
}

function changeWebhookPageSize(val) { webhookPageSize = parseInt(val); webhookCurrentPage = 1; renderWebhooks(); }
function prevWebhookPage() { if (webhookCurrentPage > 1) { webhookCurrentPage--; renderWebhooks(); } }
function nextWebhookPage() { webhookCurrentPage++; renderWebhooks(); }

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
  document.getElementById('hookName').value = '';
  document.getElementById('hookUrl').value = '';
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
  if (!name || !url) { showToast('请输入系统名称和回调地址！', 'error'); return; }

  try {
    const res = await fetch('/api/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, url, enabled: true })
    });
    const json = await res.json();
    if (json.success) {
      showToast('第三方订阅节点注册成功！');
      const box = document.getElementById('webhookSecretStatusBox');
      if (box && json.data && json.data.secret) {
        box.style.display = 'block';
        box.textContent = `请立即将以下独立 Webhook 签名密钥安全交给接收方（仅本次显示）：\n${json.data.secret}`;
      }
      closeAddWebhookModal();
      loadWebhooks();
    } else {
      showToast(json.error || '注册失败', 'error');
    }
  } catch (err) {
    showToast('网络交互错误', 'error');
  }
}

async function addWebhookNode() {
  await handleAddWebhookSubmit();
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

  if (!name || !url) { showToast('请输入系统名称和回调地址！', 'error'); return; }

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

async function testWebhook(id) {
  const box = document.getElementById('webhookTestStatusBox');
  if (box) {
    box.style.display = 'block';
    box.style.background = '#eff6ff';
    box.style.border = '1px solid #bfdbfe';
    box.style.color = '#1d4ed8';
    box.innerText = '正在发起测试 Webhook 消息推送，请稍候...';
  }

  try {
    const res = await fetch(`/api/webhooks/${id}/test`, { method: 'POST' });
    const json = await res.json();
    if (json.success) {
      if (box) {
        box.style.background = '#f0fdf4';
        box.style.border = '1px solid #bbf7d0';
        box.style.color = '#15803d';
        box.innerText = `[成功] ${json.message}`;
      }
      showToast('Webhook 测试消息推送成功！');
    } else {
      if (box) {
        box.style.background = '#fef2f2';
        box.style.border = '1px solid #fecaca';
        box.style.color = '#b91c1c';
        box.innerText = `[失败] 测试推送失败: ${json.error}`;
      }
      showToast(json.error || '测试推送失败', 'error');
    }
  } catch (e) {
    if (box) {
      box.style.background = '#fef2f2';
      box.style.border = '1px solid #fecaca';
      box.style.color = '#b91c1c';
      box.innerText = `[错误] 网络错误: ${e.message}`;
    }
    showToast('发起测试推送发生网络错误', 'error');
  }
}

async function deleteWebhook(id) {
  if (!confirm('确认移除该消息订阅节点？')) return;
  await fetch(`/api/webhooks/${id}`, { method: 'DELETE' });
  showToast('订阅节点已移除', 'error');
  loadWebhooks();
}

async function rotateWebhookSecret(id) {
  if (!confirm('轮换后旧签名密钥立即失效，确认继续？')) return;
  try {
    const res = await fetch(`/api/webhooks/${id}/rotate-secret`, { method: 'POST' });
    const json = await res.json();
    if (!json.success) return showToast(json.error || '密钥轮换失败', 'error');
    const box = document.getElementById('webhookSecretStatusBox');
    if (box) {
      box.style.display = 'block';
      box.textContent = `请立即将以下独立 Webhook 签名密钥安全同步给接收方（旧密钥已失效）：\n${json.data.secret}`;
    }
    showToast('Webhook 独立签名密钥已轮换');
    loadWebhooks();
  } catch (e) {
    showToast('密钥轮换请求失败: ' + e.message, 'error');
  }
}

Object.assign(window.VFusionActions = window.VFusionActions || {}, {
  loadWebhooks, renderWebhooks, changeWebhookPageSize, prevWebhookPage, nextWebhookPage,
  toggleWebhookNode, openAddWebhookModal, closeAddWebhookModal, handleAddWebhookSubmit,
  addWebhookNode, openEditWebhookModal, closeEditWebhookModal, handleSaveWebhook,
  testWebhook, deleteWebhook, rotateWebhookSecret
});
