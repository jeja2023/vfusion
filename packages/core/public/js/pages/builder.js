let schemaCurrentPage = 1, schemaPageSize = 10;

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

  const fields = currentSchema.fields || [];
  const totalCount = fields.length;
  const totalPages = Math.ceil(totalCount / schemaPageSize) || 1;
  if (schemaCurrentPage > totalPages) schemaCurrentPage = totalPages;
  if (schemaCurrentPage < 1) schemaCurrentPage = 1;

  if (document.getElementById('schemaTotalCount')) document.getElementById('schemaTotalCount').innerText = totalCount;
  if (document.getElementById('schemaCurrentPageText')) document.getElementById('schemaCurrentPageText').innerText = schemaCurrentPage;
  if (document.getElementById('schemaTotalPagesText')) document.getElementById('schemaTotalPagesText').innerText = totalPages;
  if (document.getElementById('schemaPrevBtn')) document.getElementById('schemaPrevBtn').disabled = schemaCurrentPage <= 1;
  if (document.getElementById('schemaNextBtn')) document.getElementById('schemaNextBtn').disabled = schemaCurrentPage >= totalPages;

  if (totalCount === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">暂无配置字段规范</td></tr>`;
    return;
  }

  const paged = fields.slice((schemaCurrentPage - 1) * schemaPageSize, schemaCurrentPage * schemaPageSize);
  tbody.innerHTML = paged.map((f, idx) => {
    const realIdx = (schemaCurrentPage - 1) * schemaPageSize + idx;
    return `
      <tr>
        <td class="col-idx">${realIdx + 1}</td>
        <td><code>${escapeHtml(f.key)}</code></td>
        <td><strong>${escapeHtml(f.label)}</strong></td>
        <td>${escapeHtml(f.type)}</td>
        <td>${escapeHtml((f.options || []).join(', ')) || '-'}</td>
        <td style="display:flex; gap:0.4rem;">
          <button class="btn btn-secondary" style="padding:0.25rem 0.5rem; font-size:0.75rem; white-space:nowrap;" data-action="openEditFieldModal(${realIdx})">编辑</button>
          <button class="btn btn-danger" style="padding:0.25rem 0.5rem; font-size:0.75rem; white-space:nowrap;" data-action="removeSchemaField(${realIdx})">删除</button>
        </td>
      </tr>
    `;
  }).join('');
}

function changeSchemaPageSize(val) { schemaPageSize = parseInt(val); schemaCurrentPage = 1; renderSchemaFields(); }
function prevSchemaPage() { if (schemaCurrentPage > 1) { schemaCurrentPage--; renderSchemaFields(); } }
function nextSchemaPage() { schemaCurrentPage++; renderSchemaFields(); }

function openAddFieldModal() {
  document.getElementById('newFieldKey').value = '';
  document.getElementById('newFieldLabel').value = '';
  document.getElementById('newFieldType').value = 'text';
  document.getElementById('newFieldOptions').value = '';
  const modal = document.getElementById('addFieldModal');
  if (modal) modal.style.display = 'flex';
}

function closeAddFieldModal() {
  const modal = document.getElementById('addFieldModal');
  if (modal) modal.style.display = 'none';
}

function handleAddFieldSubmit(e) {
  if (e) e.preventDefault();
  const key = document.getElementById('newFieldKey').value.trim();
  const label = document.getElementById('newFieldLabel').value.trim();
  const type = document.getElementById('newFieldType').value;
  const optionsStr = document.getElementById('newFieldOptions').value.trim();

  if (!key || !label) { showToast('请填写字段键名和中文标签！', 'error'); return; }

  if ((currentSchema.fields || []).some(f => f.key === key)) {
    showToast(`字段键名 [${key}] 已存在！`, 'error');
    return;
  }

  if (!currentSchema.fields) currentSchema.fields = [];
  currentSchema.fields.push({
    key, label, type,
    options: optionsStr ? optionsStr.split(',').map(s=>s.trim()) : [],
    required: true, searchable: true, show_in_table: true
  });
  renderSchemaFields();
  showToast('已添加到表单字段列表');
  closeAddFieldModal();
}

function addFieldToSchema() {
  handleAddFieldSubmit();
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

Object.assign(window.VFusionActions = window.VFusionActions || {}, {
  loadSchema, renderSchemaFields, changeSchemaPageSize, prevSchemaPage, nextSchemaPage,
  openAddFieldModal, closeAddFieldModal, handleAddFieldSubmit, addFieldToSchema,
  openEditFieldModal, closeEditFieldModal, handleSaveField, removeSchemaField,
  saveSchemaConfig
});
