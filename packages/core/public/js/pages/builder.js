async function loadSchema() {
  const appId = 'sys_gate_security';
  try {
    const res = await fetch(`/api/schema?app_id=${appId}`);
    const json = await res.json();
    if (json.success) { currentSchema = json.data; renderSchemaFields(); }
  } catch (e) {
    console.error('加载 Schema 失败:', e);
  }
}

function renderSchemaFields() {
  const tbody = document.getElementById('schemaFieldsBody');
  if (!tbody) return;
  tbody.innerHTML = (currentSchema.fields || []).map((f, idx) => `
    <tr>
      <td class="col-idx">${idx + 1}</td>
      <td><code>${escapeHtml(f.key)}</code></td>
      <td><strong>${escapeHtml(f.label)}</strong></td>
      <td>${escapeHtml(f.type)}</td>
      <td>${escapeHtml((f.options || []).join(', ')) || '-'}</td>
      <td style="display:flex; gap:0.4rem;">
        <button class="btn btn-secondary" style="padding:0.25rem 0.5rem; font-size:0.75rem; white-space:nowrap;" onclick="openEditFieldModal(${idx})">编辑</button>
        <button class="btn btn-danger" style="padding:0.25rem 0.5rem; font-size:0.75rem; white-space:nowrap;" onclick="removeSchemaField(${idx})">删除</button>
      </td>
    </tr>
  `).join('');
}

function addFieldToSchema() {
  const key = document.getElementById('newFieldKey').value.trim();
  const label = document.getElementById('newFieldLabel').value.trim();
  const type = document.getElementById('newFieldType').value;
  const optionsStr = document.getElementById('newFieldOptions').value.trim();

  if (!key || !label) { showToast('请填写字段键名和中文标签！', 'error'); return; }

  currentSchema.fields.push({
    key, label, type,
    options: optionsStr ? optionsStr.split(',').map(s=>s.trim()) : [],
    required: true, searchable: true, show_in_table: true
  });
  renderSchemaFields();
  showToast('已添加新字段');
  document.getElementById('newFieldKey').value = '';
  document.getElementById('newFieldLabel').value = '';
  document.getElementById('newFieldOptions').value = '';
}

function openEditFieldModal(idx) {
  const f = (currentSchema.fields || [])[idx];
  if (!f) return;
  document.getElementById('editFieldIndex').value = idx;
  document.getElementById('editFieldKey').value = f.key || '';
  document.getElementById('editFieldLabel').value = f.label || '';
  document.getElementById('editFieldType').value = f.type || 'text';
  document.getElementById('editFieldOptions').value = (f.options || []).join(', ');
  const modal = document.getElementById('editFieldModal');
  if (modal) modal.style.display = 'flex';
}

function closeEditFieldModal() {
  const modal = document.getElementById('editFieldModal');
  if (modal) modal.style.display = 'none';
}

function handleSaveField(e) {
  if (e) e.preventDefault();
  const idx = parseInt(document.getElementById('editFieldIndex').value);
  if (isNaN(idx) || !currentSchema.fields || !currentSchema.fields[idx]) return;

  const label = document.getElementById('editFieldLabel').value.trim();
  const type = document.getElementById('editFieldType').value;
  const optionsStr = document.getElementById('editFieldOptions').value.trim();

  if (!label) { showToast('中文标签不能为空！', 'error'); return; }

  currentSchema.fields[idx].label = label;
  currentSchema.fields[idx].type = type;
  currentSchema.fields[idx].options = optionsStr ? optionsStr.split(',').map(s=>s.trim()) : [];

  renderSchemaFields();
  closeEditFieldModal();
  showToast('字段属性已更新');
}

function removeSchemaField(idx) { currentSchema.fields.splice(idx, 1); renderSchemaFields(); showToast('已移除字段', 'error'); }

async function saveSchemaConfig() {
  const appId = 'sys_gate_security';
  currentSchema.app_id = appId;
  const res = await fetch('/api/schema', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(currentSchema)
  });
  const json = await res.json();
  if (json.success) showToast(json.message);
}
