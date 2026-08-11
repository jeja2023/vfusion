let usersCurrentPage = 1, usersPageSize = 10;
let cachedUsersData = [];

async function loadUsers() {
  try {
    const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const res = await fetchFn('/api/users');
    const json = await res.json();
    if (json.success) {
      cachedUsersData = json.data || [];
      renderUsers();
    }
  } catch (e) {
    console.error('加载用户列表失败:', e);
  }
}

function renderUsers() {
  const tbody = document.getElementById('usersTableBody');
  if (!tbody) return;
  const totalCount = cachedUsersData.length;
  const totalPages = Math.ceil(totalCount / usersPageSize) || 1;
  if (usersCurrentPage > totalPages) usersCurrentPage = totalPages;
  if (usersCurrentPage < 1) usersCurrentPage = 1;

  if (document.getElementById('usersTotalCount')) document.getElementById('usersTotalCount').innerText = totalCount;
  if (document.getElementById('usersCurrentPageText')) document.getElementById('usersCurrentPageText').innerText = usersCurrentPage;
  if (document.getElementById('usersTotalPagesText')) document.getElementById('usersTotalPagesText').innerText = totalPages;
  if (document.getElementById('usersPrevBtn')) document.getElementById('usersPrevBtn').disabled = usersCurrentPage <= 1;
  if (document.getElementById('usersNextBtn')) document.getElementById('usersNextBtn').disabled = usersCurrentPage >= totalPages;

  if (totalCount === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">暂无用户记录</td></tr>`;
    return;
  }

  const roleMap = { admin: '超级管理员', operator: '操作员', auditor: '审计员' };
  const paged = cachedUsersData.slice((usersCurrentPage - 1) * usersPageSize, usersCurrentPage * usersPageSize);

  tbody.innerHTML = paged.map((item, idx) => {
    const globalIdx = (usersCurrentPage - 1) * usersPageSize + idx + 1;
    return `
      <tr>
        <td class="col-idx">${globalIdx}</td>
        <td><code>${escapeHtml(item.username)}</code></td>
        <td><strong>${escapeHtml(item.name)}</strong></td>
        <td><span class="badge-level ${item.role === 'admin' ? '高' : '低'}">${escapeHtml(roleMap[item.role] || item.role)}</span></td>
        <td>${item.status === 'active' || item.status === 'ACTIVE' || !item.status
          ? '<span style="color:var(--success); font-weight:600;">启用</span>'
          : '<span style="color:var(--danger); font-weight:600;">已禁用</span>'}</td>
        <td style="display:flex; gap:0.4rem;">
          <button class="btn-submit" style="width:auto; min-width:55px; margin-top:0; padding:0.25rem 0.55rem; font-size:0.75rem; white-space:nowrap; flex-shrink:0;" onclick="resetUserPassword(${item.id})">重置密码</button>
          ${item.username !== 'admin' ? `<button class="btn-submit" style="width:auto; min-width:45px; margin-top:0; padding:0.25rem 0.55rem; font-size:0.75rem; background:var(--danger); white-space:nowrap; flex-shrink:0;" onclick="deleteUser(${item.id})">删除</button>` : ''}
        </td>
      </tr>
    `;
  }).join('');
}

function changeUsersPageSize(val) { usersPageSize = parseInt(val); usersCurrentPage = 1; renderUsers(); }
function prevUsersPage() { if (usersCurrentPage > 1) { usersCurrentPage--; renderUsers(); } }
function nextUsersPage() { usersCurrentPage++; renderUsers(); }

async function createNewUser() {
  const username = document.getElementById('newUsername').value.trim();
  const name = document.getElementById('newFullname').value.trim();
  const password = document.getElementById('newUserPwd').value.trim();
  const role = document.getElementById('newUserRole').value;

  if (!username || !name || !password) { showToast('请填写完整用户信息！', 'error'); return; }

  const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
  const res = await fetchFn('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, name, password, role })
  });
  const json = await res.json();
  if (json.success) {
    showToast('视频网新用户添加成功！');
    document.getElementById('newUsername').value = '';
    document.getElementById('newFullname').value = '';
    document.getElementById('newUserPwd').value = '';
    loadUsers();
  } else { showToast(json.error, 'error'); }
}

async function resetUserPassword(id) {
  const newPwd = prompt('请输入新密码 (如 123456):');
  if (!newPwd) return;

  const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
  const res = await fetchFn(`/api/users/${id}/reset-password`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ new_password: newPwd })
  });
  const json = await res.json();
  if (json.success) showToast('密码重置成功！');
  else showToast(json.error, 'error');
}

async function deleteUser(id) {
  if (!confirm('确认删除该用户？')) return;
  const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
  const res = await fetchFn(`/api/users/${id}`, { method: 'DELETE' });
  const json = await res.json();
  if (json.success) { showToast('用户已删除', 'error'); loadUsers(); }
  else showToast(json.error, 'error');
}
