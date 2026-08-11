async function loadWebhooks() {
  try {
    const res = await fetch('/api/webhooks');
    const json = await res.json();
    const tbody = document.getElementById('webhookTableBody');
    if (!tbody) return;
    if (!json.success || json.data.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:var(--text-muted);">暂无注册的订阅节点</td></tr>`;
      return;
    }
    tbody.innerHTML = json.data.map((item, idx) => `
      <tr>
        <td class="col-idx">${idx + 1}</td>
        <td><strong>${item.name}</strong></td>
        <td><code>${item.url}</code></td>
        <td><button class="btn btn-danger" style="padding:0.25rem 0.5rem; font-size:0.75rem; white-space:nowrap;" onclick="deleteWebhook(${item.id})">移除</button></td>
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

async function deleteWebhook(id) {
  await fetch(`/api/webhooks/${id}`, { method: 'DELETE' });
  showToast('订阅节点已移除', 'error');
  loadWebhooks();
}
