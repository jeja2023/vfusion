let currentSchema = { fields: [] };
let schemaCurrentPage = 1, schemaPageSize = 10;

async function loadSchema() {
  const appId = 'sys_gate_security';
  try {
    if (typeof loadPersonnelList === 'function') await loadPersonnelList();
    const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const res = await fetchFn(`/api/schema?app_id=${appId}`);
    const json = await res.json();
    if (json.success) {
      currentSchema = json.data;
      if (typeof renderDynamicForm === 'function') renderDynamicForm(currentSchema.fields);
      renderSchemaFields();
    }
  } catch (err) { console.error('加载 Schema 失败:', err); }
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
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">暂无字段配置</td></tr>`;
    if (typeof renderDynamicForm === 'function') renderDynamicForm(fields);
    return;
  }

  const paged = fields.slice((schemaCurrentPage - 1) * schemaPageSize, schemaCurrentPage * schemaPageSize);

  tbody.innerHTML = paged.map((f, idx) => {
    const globalIdx = (schemaCurrentPage - 1) * schemaPageSize + idx + 1;
    const realIdx = fields.indexOf(f);
    return `
      <tr>
        <td class="col-idx">${globalIdx}</td>
        <td><code>${escapeHtml(f.key)}</code></td>
        <td><strong>${escapeHtml(f.label)}</strong></td>
        <td>${escapeHtml(f.type)}</td>
        <td>${escapeHtml((f.options || []).join(', ')) || '-'}</td>
        <td><button class="btn-submit" style="width:auto; min-width:55px; margin-top:0; padding:0.25rem 0.55rem; font-size:0.75rem; background:var(--danger); white-space:nowrap; flex-shrink:0;" onclick="removeSchemaField(${realIdx})">删除</button></td>
      </tr>
    `;
  }).join('');
  if (typeof renderDynamicForm === 'function') renderDynamicForm(fields);
}

function changeSchemaPageSize(val) { schemaPageSize = parseInt(val); schemaCurrentPage = 1; renderSchemaFields(); }
function prevSchemaPage() { if (schemaCurrentPage > 1) { schemaCurrentPage--; renderSchemaFields(); } }
function nextSchemaPage() { schemaCurrentPage++; renderSchemaFields(); }

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

function removeSchemaField(idx) {
  currentSchema.fields.splice(idx, 1);
  renderSchemaFields();
  showToast('字段已移除', 'error');
}

async function saveSchemaConfig() {
  const appId = 'sys_gate_security';
  currentSchema.app_id = appId;

  const res = await fetch('/api/schema', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(currentSchema)
  });
  const json = await res.json();
  if (json.success) {
    showToast(json.message);
    if (typeof renderDynamicForm === 'function') renderDynamicForm(currentSchema.fields);
  }
}

function exportSchemaJson() {
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(currentSchema, null, 2));
  const downloadAnchor = document.createElement('a');
  downloadAnchor.setAttribute("href", dataStr);
  downloadAnchor.setAttribute("download", "vfusion_schema_v2.json");
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();
  showToast('表单配置文件导出成功');
}
