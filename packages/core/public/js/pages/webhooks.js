let cachedWebhooksData = [];

async function loadWebhooks() {
  try {
    const res = await fetch('/api/webhooks');
    const json = await res.json();
    const tbody = document.getElementById('webhookTableBody');
    if (!tbody) return;
    if (!json.success || json.data.length === 0) {
      cachedWebhooksData = [];
      tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:var(--text-muted);">暂无注册的订阅节点</td></tr>`;
      return;
    }
    cachedWebhooksData = json.data;
    tbody.innerHTML = json.data.map((item, idx) => `
      <tr>
        <td class="col-idx">${idx + 1}</td>
        <td><strong>${escapeHtml(item.name)}</strong></td>
        <td><code>${escapeHtml(item.url)}</code></td>
        <td style="display:flex; gap:0.4rem;">
          <button class="btn btn-secondary" style="padding:0.25rem 0.5rem; font-size:0.75rem; white-space:nowrap;" onclick="openEditWebhookModal(${item.id})">编辑</button>
          <button class="btn btn-primary" style="padding:0.25rem 0.5rem; font-size:0.75rem; white-space:nowrap;" onclick="testWebhook(${item.id})">测试推送</button>
          <button class="btn btn-danger" style="padding:0.25rem 0.5rem; font-size:0.75rem; white-space:nowrap;" onclick="deleteWebhook(${item.id})">移除</button>
        </td>
      </tr>
    `).join('');
  } catch (e) {
    console.error('加载 Webhooks 失败:', e);
  }
}

async function addWebhookNode() {
  const name = document.getElementById('hookName').value.trim();
  const url = document.getElementById('hookUrl').value.trim();
  if (!name || !url) { showToast('请输入系统名称和回调地址！', 'error'); return; }

  const res = await fetch('/api/webhooks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, url })
  });
  const json = await res.json();
  if (json.success) {
    showToast('第三方订阅节点注册成功！');
    document.getElementById('hookName').value = '';
    document.getElementById('hookUrl').value = '';
    loadWebhooks();
  }
}

function openEditWebhookModal(id) {
  const item = cachedWebhooksData.find(h => h.id === id);
  if (!item) return;
  document.getElementById('editWebhookId').value = item.id;
  document.getElementById('editWebhookName').value = item.name || '';
  document.getElementById('editWebhookUrl').value = item.url || '';
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

  if (!name || !url) { showToast('请输入系统名称和回调地址！', 'error'); return; }

  try {
    const res = await fetch(`/api/webhooks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, url })
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
        box.innerText = `✓ ${json.message}`;
      }
      showToast('Webhook 测试消息推送成功！');
    } else {
      if (box) {
        box.style.background = '#fef2f2';
        box.style.border = '1px solid #fecaca';
        box.style.color = '#b91c1c';
        box.innerText = `✕ 测试推送失败: ${json.error}`;
      }
      showToast(json.error || '测试推送失败', 'error');
    }
  } catch (e) {
    if (box) {
      box.style.background = '#fef2f2';
      box.style.border = '1px solid #fecaca';
      box.style.color = '#b91c1c';
      box.innerText = `✕ 网络错误: ${e.message}`;
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

