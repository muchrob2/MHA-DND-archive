// Page logic for admin.html. Extracted from the HTML so it can be linted,
// diffed and tested directly rather than regex-scraped out of markup.
// Loaded as a CLASSIC script, not a module: the page wires controls with
// inline onclick= handlers that resolve against globals, and top-level
// declarations here become globals exactly as they did inline. type="module"
// would scope them and silently break every handler.

// Runs after auth.js, so fbAuthReady/fsMergeSave are already defined.
const db = firebase.firestore();

let allCharacterOptions = [];

function escHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

async function loadCharacterOptions() {
  const out = [];
  try {
    const roster = await fetch('CLASS-1A/roster.json').then(r => r.json());
    for (const s of (roster.students || [])) {
      if (s.file) out.push({ id: 'Student (1-A)::' + s.name, name: s.name });
    }
  } catch {}
  try {
    const snap = await db.collection('characters').get();
    snap.forEach(doc => {
      const data = doc.data();
      if (data._type === 'Custom') out.push({ id: doc.id, name: data.name || doc.id });
    });
  } catch {}
  return out;
}

async function loadUsers() {
  const snap = await db.collection('users').get();
  const tbody = document.getElementById('users-tbody');
  const tableWrap = document.getElementById('table-wrap');
  const emptyEl = document.getElementById('users-empty');
  tbody.innerHTML = '';
  tableWrap.style.display = snap.empty ? 'none' : '';
  emptyEl.style.display = snap.empty ? '' : 'none';
  snap.forEach(doc => {
    const uid = doc.id;
    const data = doc.data();
    const editable = new Set(data.editableCharacterIds || []);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escHtml(data.email || uid)}</td>
      <td>
        <select id="role-${uid}">
          <option value="pending" ${data.role === 'pending' ? 'selected' : ''}>pending</option>
          <option value="editor" ${data.role === 'editor' ? 'selected' : ''}>editor</option>
          <option value="admin" ${data.role === 'admin' ? 'selected' : ''}>admin</option>
        </select>
      </td>
      <td>
        <div class="char-picker" id="chars-${uid}">
          ${allCharacterOptions.map(c => `
            <label><input type="checkbox" value="${escHtml(c.id)}" ${editable.has(c.id) ? 'checked' : ''}> ${escHtml(c.name)}</label>
          `).join('')}
        </div>
        <button class="save-row-btn" onclick="saveUser('${uid}')">Save</button>
        <span class="row-saved" id="saved-${uid}">Saved ✓</span>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function saveUser(uid) {
  const role = document.getElementById('role-' + uid).value;
  const checks = document.querySelectorAll('#chars-' + uid + ' input[type=checkbox]:checked');
  const editableCharacterIds = [...checks].map(c => c.value);
  try {
    await db.collection('users').doc(uid).update({ role, editableCharacterIds });
    const notice = document.getElementById('saved-' + uid);
    notice.classList.add('show');
    setTimeout(() => notice.classList.remove('show'), 1500);
  } catch (e) {
    alert('Could not save: ' + e.message);
  }
}

document.addEventListener('auth-state-changed', async (state) => {
  const { role } = state.detail;
  const gate = document.getElementById('gate-message');
  const body = document.getElementById('admin-body');
  if (role !== 'admin') {
    gate.style.display = '';
    body.style.display = 'none';
    gate.textContent = state.detail.user ? 'You do not have admin access.' : 'Sign in with an admin account to view this page.';
    return;
  }
  gate.style.display = 'none';
  body.style.display = '';
  allCharacterOptions = await loadCharacterOptions();
  await loadUsers();
});
