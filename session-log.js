// Page logic for session-log.html. Extracted from the HTML so it can be linted,
// diffed and tested directly rather than regex-scraped out of markup.
// Loaded as a CLASSIC script, not a module: the page wires controls with
// inline onclick= handlers that resolve against globals, and top-level
// declarations here become globals exactly as they did inline. type="module"
// would scope them and silently break every handler.

// Runs after auth.js, so fbAuthReady/fsMergeSave are already defined.
const db = firebase.firestore();

let data = { sessions: [] };
let editingId = null;
let draftNew = false;
let canWrite = false;

function escHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function uid() { return 'sl_' + Math.random().toString(36).slice(2, 8); }

const FS_DOC = db.collection('mha-dnd').doc('session-log');
// Last session-log doc this client knows was on the server — diffed against
// on save so concurrent edits to different sessions don't clobber each other.
let _lastSyncedLog = null;
// True from the moment a save is kicked off until it lands (or fails).
// editingId/draftNew already reset to "not editing" before this resolves
// (the form closes immediately), so isLogEditing() alone leaves a window
// where a live snapshot could apply mid-save and revert the just-made edit.
let _logSaveInFlight = false;

document.addEventListener('auth-state-changed', (e) => {
  canWrite = e.detail.role === 'admin' || e.detail.role === 'editor';
  document.getElementById('add-session-btn').style.display = canWrite ? '' : 'none';
  render();
});

async function init() {
  try {
    await fbAuthReady;
    const snap = await FS_DOC.get();
    data = snap.exists ? snap.data() : { sessions: [] };
    if (!Array.isArray(data.sessions)) data.sessions = [];
    _lastSyncedLog = fsCloneDoc(data); // cloned: a baseline must never alias live state (see auth.js cloneDoc)
  } catch {
    document.getElementById('load-error-banner').style.display = '';
    data = { sessions: [] };
  }
  render();
  startLogLiveSync();
}

async function saveAll() {
  const notice = document.getElementById('saved-notice');
  _logSaveInFlight = true;
  try {
    await fbAuthReady;
    const merged = await fsMergeSave(FS_DOC, data, _lastSyncedLog, [{ path: 'sessions', idKey: 'id' }]);
    _lastSyncedLog = merged;
    notice.textContent = 'Saved ✓';
    notice.classList.add('show');
    setTimeout(() => notice.classList.remove('show'), 2000);
  } catch (e) {
    notice.textContent = 'Save failed — changes not persisted';
    notice.classList.add('show');
    setTimeout(() => notice.classList.remove('show'), 3000);
  } finally {
    _logSaveInFlight = false;
  }
}

// Live feed: reflect other people's changes without a manual refresh. Deferred
// while a session card is open for editing so a remote update can't blow away
// in-progress, unsaved text in a field.
let _pendingRemoteLog = null;
function isLogEditing() { return editingId !== null || draftNew || _logSaveInFlight; }
function applyRemoteLog(remote) {
  data = remote;
  if (!Array.isArray(data.sessions)) data.sessions = [];
  _lastSyncedLog = fsCloneDoc(remote); // cloned: a baseline must never alias live state (see auth.js cloneDoc)
  render();
}
async function startLogLiveSync() {
  await fbAuthReady;
  FS_DOC.onSnapshot(snap => {
    if (!snap.exists) return;
    // A cached snapshot is this tab's own stale copy, not news from the server.
    // When Firestore's streaming channel is blocked (Safari tracking
    // protection, content blockers, proxies) the write transport keeps working
    // while the listener replays cache — so a save commits and is then visibly
    // "undone" by data older than the write. See relationships.html.
    if (snap.metadata?.fromCache) return;
    const remote = snap.data();
    if (isLogEditing()) { _pendingRemoteLog = remote; return; }
    applyRemoteLog(remote);
  }, err => console.error('[session-log] live sync stopped:', err));
}
setInterval(() => {
  if (_pendingRemoteLog && !isLogEditing()) {
    const remote = _pendingRemoteLog;
    _pendingRemoteLog = null;
    applyRemoteLog(remote);
  }
}, 800);

function formatDate(d) {
  if (!d) return '';
  const parsed = new Date(d + 'T00:00:00');
  if (isNaN(parsed)) return escHtml(d);
  return parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function nextSessionNumber() {
  return data.sessions.reduce((max, s) => Math.max(max, Number(s.number) || 0), 0) + 1;
}

function render() {
  const sorted = [...data.sessions].sort((a, b) => (Number(b.number)||0) - (Number(a.number)||0));

  document.getElementById('stat-count').textContent = data.sessions.length;
  document.getElementById('stat-xp').textContent = data.sessions.reduce((sum, s) => sum + (Number(s.xp) || 0), 0).toLocaleString();

  const slot = document.getElementById('new-form-slot');
  slot.innerHTML = draftNew ? formHtml(null) : '';

  const list = document.getElementById('sessions-list');
  document.getElementById('empty-state').style.display = sorted.length ? 'none' : '';
  list.innerHTML = sorted.map(s => editingId === s.id ? formHtml(s) : cardHtml(s)).join('');
}

function cardHtml(s) {
  return `<div class="session-card">
    <div class="session-card-head">
      <span class="session-number">Session ${escHtml(s.number ?? '?')}</span>
      <span class="session-title">${escHtml(s.title || 'Untitled session')}</span>
      <span class="session-date">${formatDate(s.date)}</span>
    </div>
    ${s.recap ? `<div class="session-recap">${escHtml(s.recap)}</div>` : ''}
    <div class="session-meta-row">
      ${s.xp ? `<div class="session-meta-block"><div class="session-meta-label">XP awarded</div><div class="xp-value">${escHtml(String(s.xp))}</div></div>` : ''}
      ${s.loot ? `<div class="session-meta-block"><div class="session-meta-label">Loot &amp; rewards</div><div class="loot-text">${escHtml(s.loot)}</div></div>` : ''}
    </div>
    ${canWrite ? `<div class="session-actions">
      <button class="action-btn" onclick="startEdit('${s.id}')">Edit</button>
      <button class="action-btn danger" onclick="deleteSession('${s.id}')">Delete</button>
    </div>` : ''}
  </div>`;
}

function formHtml(s) {
  s = s || {};
  const isNew = !s.id;
  const idAttr = isNew ? 'new' : s.id;
  return `<div class="session-card">
    <div class="form-row-pair">
      <div class="form-row"><label>Session #</label><input class="edit-input" id="f-number-${idAttr}" type="number" value="${escHtml(String(s.number ?? nextSessionNumber()))}"></div>
      <div class="form-row"><label>Date</label><input class="edit-input" id="f-date-${idAttr}" type="date" value="${escHtml(s.date||'')}"></div>
    </div>
    <div class="form-row"><label>Title</label><input class="edit-input" id="f-title-${idAttr}" type="text" placeholder="e.g. Sports Festival — Prelims" value="${escHtml(s.title||'')}"></div>
    <div class="form-row"><label>Recap</label><textarea class="edit-textarea" id="f-recap-${idAttr}" placeholder="What actually happened at the table…">${escHtml(s.recap||'')}</textarea></div>
    <div class="form-row-pair">
      <div class="form-row"><label>XP awarded</label><input class="edit-input" id="f-xp-${idAttr}" type="number" placeholder="0" value="${escHtml(String(s.xp||''))}"></div>
      <div class="form-row" style="flex:2;"><label>Loot &amp; rewards</label><input class="edit-input" id="f-loot-${idAttr}" type="text" placeholder="Items, currency, favors gained" value="${escHtml(s.loot||'')}"></div>
    </div>
    <div class="form-actions">
      <button class="action-btn primary" onclick="${isNew ? 'submitNewForm()' : `saveEdit('${s.id}')`}">${isNew ? 'Add Session' : 'Save Changes'}</button>
      <button class="action-btn" onclick="${isNew ? 'cancelNewForm()' : 'cancelEdit()'}">Cancel</button>
    </div>
  </div>`;
}

function readForm(idAttr) {
  return {
    number: Number(document.getElementById(`f-number-${idAttr}`).value) || 0,
    date: document.getElementById(`f-date-${idAttr}`).value,
    title: document.getElementById(`f-title-${idAttr}`).value.trim(),
    recap: document.getElementById(`f-recap-${idAttr}`).value.trim(),
    xp: Number(document.getElementById(`f-xp-${idAttr}`).value) || 0,
    loot: document.getElementById(`f-loot-${idAttr}`).value.trim(),
  };
}

function openNewForm() {
  draftNew = true;
  editingId = null;
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function cancelNewForm() {
  draftNew = false;
  render();
}
async function submitNewForm() {
  const fields = readForm('new');
  if (!fields.title) { alert('Session title is required.'); return; }
  data.sessions.push(Object.assign({ id: uid() }, fields));
  draftNew = false;
  render();
  await saveAll();
}

function startEdit(id) {
  editingId = id;
  draftNew = false;
  render();
}
function cancelEdit() {
  editingId = null;
  render();
}
async function saveEdit(id) {
  const fields = readForm(id);
  if (!fields.title) { alert('Session title is required.'); return; }
  const idx = data.sessions.findIndex(s => s.id === id);
  if (idx > -1) data.sessions[idx] = Object.assign({ id }, fields);
  editingId = null;
  render();
  await saveAll();
}

async function deleteSession(id) {
  if (!confirm('Delete this session log entry? This cannot be undone.')) return;
  data.sessions = data.sessions.filter(s => s.id !== id);
  render();
  await saveAll();
}

init();
