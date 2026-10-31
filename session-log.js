// Page logic for session-log.html. Extracted from the HTML so it can be linted,
// diffed and tested directly rather than regex-scraped out of markup.
// Loaded as a CLASSIC script, not a module: the page wires controls with
// inline onclick= handlers that resolve against globals, and top-level
// declarations here become globals exactly as they did inline. type="module"
// would scope them and silently break every handler.

// Runs after auth.js, so fbAuthReady/fsMergeSave are already defined.
const db = firebase.firestore();

let data = { sessions: [] };
// The players, from the class roster — whoever is marked is_pc there. Loaded
// rather than listed here so adding a player to the roster adds them to the
// attendance list and to the per-player counts without this file changing.
let PLAYERS = [];
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

async function loadPlayers() {
  try {
    const roster = await fetch('CLASS-1A/roster.json').then(r => r.json());
    PLAYERS = (roster.students || []).filter(s => s.is_pc).map(s => ({ id: s.id, name: s.name }));
  } catch {
    // The log is readable and writable without the roster; attendance just
    // has nobody to offer, which is better than the page failing to load.
    PLAYERS = [];
  }
}

function playerName(id) {
  const p = PLAYERS.find(x => String(x.id) === String(id));
  // Resolved at render time, so a character renamed in the roster reads
  // correctly in every session they were ever at.
  return p ? p.name : '#' + id;
}

function sessionPresent(s) {
  return Array.isArray(s.present) ? s.present : [];
}

async function init() {
  try {
    await loadPlayers();
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

function sessionMatches(s, q) {
  if (!q) return true;
  const hay = [s.title, s.recap, s.arc, s.npcs, s.places, s.loot, s.next,
    'session ' + (s.number ?? ''), formatDate(s.date),
    ...sessionPresent(s).map(playerName)].join(' ').toLowerCase();
  // Every word has to appear somewhere, in any order: "ginza byakko" finds
  // the session those two things were both in.
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w));
}

function render() {
  const sorted = [...data.sessions].sort((a, b) => (Number(b.number)||0) - (Number(a.number)||0));
  const search = document.getElementById('log-search');
  const q = search ? search.value.trim() : '';
  const shown = sorted.filter(s => sessionMatches(s, q));

  document.getElementById('stat-count').textContent = data.sessions.length;
  document.getElementById('stat-xp').textContent = data.sessions.reduce((sum, s) => sum + (Number(s.xp) || 0), 0).toLocaleString();

  // Last played: the latest date anybody actually wrote down, which is not
  // necessarily the highest session number.
  const dates = data.sessions.map(s => s.date).filter(Boolean).sort();
  const lastEl = document.getElementById('stat-last');
  if (lastEl) lastEl.textContent = dates.length ? formatDate(dates[dates.length - 1]) : '—';

  renderAttendance();

  const slot = document.getElementById('new-form-slot');
  slot.innerHTML = draftNew ? formHtml(null) : '';

  const list = document.getElementById('sessions-list');
  const empty = document.getElementById('empty-state');
  empty.style.display = shown.length ? 'none' : '';
  // Always set, never only on the search branch: leaving the last message in
  // place meant deleting every session showed "no session matches that".
  empty.innerHTML = data.sessions.length
    ? '<svg class="es-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-4.8-4.8"/></svg>No session matches that.'
    : '<svg class="es-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M5 8h14M9 12h6M9 16h4"/><path d="M8 3v18"/></svg>No sessions logged yet — recap your first session to start the log.';
  list.innerHTML = shown.map(s => editingId === s.id ? formHtml(s) : cardHtml(s)).join('');
  const count = document.getElementById('log-search-count');
  if (count) count.textContent = q && data.sessions.length ? `${shown.length} of ${data.sessions.length}` : '';
}

// How many sessions each player has actually been at. Derived, never stored:
// it is only ever a count of the attendance ticked on the cards below.
function renderAttendance() {
  const wrap = document.getElementById('attendance-bar');
  if (!wrap) return;
  const recorded = data.sessions.filter(s => sessionPresent(s).length);
  if (!PLAYERS.length || !recorded.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  wrap.innerHTML = '<div class="attendance-label">Sessions attended</div>'
    + PLAYERS.map(p => {
      const n = recorded.filter(s => sessionPresent(s).some(id => String(id) === String(p.id))).length;
      return `<span class="attendance-chip${n ? '' : ' none'}">${escHtml(p.name)}
        <b>${n}</b><span class="attendance-of">/${recorded.length}</span></span>`;
    }).join('');
}

function onLogSearch() { render(); }

// Comma-separated in the form, chips on the card: the people and places a
// session touched are a list, and a list you can see at a glance is the thing
// you actually scan a log for six weeks later.
function chipsHtml(label, value, kind) {
  const items = String(value || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!items.length) return '';
  return `<div class="session-meta-block"><div class="session-meta-label">${escHtml(label)}</div>
    <div class="chip-row">${items.map(i => `<span class="log-chip ${kind}">${escHtml(i)}</span>`).join('')}</div></div>`;
}

function cardHtml(s) {
  const present = sessionPresent(s);
  return `<div class="session-card">
    <div class="session-card-head">
      <span class="session-number">Session ${escHtml(s.number ?? '?')}</span>
      <span class="session-title">${escHtml(s.title || 'Untitled session')}</span>
      ${s.arc ? `<span class="session-arc">${escHtml(s.arc)}</span>` : ''}
      <span class="session-date">${formatDate(s.date)}</span>
    </div>
    ${present.length ? `<div class="chip-row present-row">${present.map(id =>
      `<span class="log-chip present">${escHtml(playerName(id))}</span>`).join('')}</div>` : ''}
    ${s.recap ? `<div class="session-recap">${escHtml(s.recap)}</div>` : ''}
    ${s.next ? `<div class="session-next"><span class="session-next-label">Next time</span>${escHtml(s.next)}</div>` : ''}
    <div class="session-meta-row">
      ${s.xp ? `<div class="session-meta-block"><div class="session-meta-label">XP awarded</div><div class="xp-value">${escHtml(String(s.xp))}</div></div>` : ''}
      ${s.loot ? `<div class="session-meta-block"><div class="session-meta-label">Loot &amp; rewards</div><div class="loot-text">${escHtml(s.loot)}</div></div>` : ''}
      ${chipsHtml('Met', s.npcs, 'npc')}
      ${chipsHtml('Went', s.places, 'place')}
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
    <div class="form-row-pair">
      <div class="form-row" style="flex:2;"><label>Chapter or arc</label><input class="edit-input" id="f-arc-${idAttr}" type="text" placeholder="e.g. After Hours — Chapter 3" value="${escHtml(s.arc||'')}"></div>
    </div>
    ${PLAYERS.length ? `<div class="form-row"><label>Who was there</label>
      <div class="present-picker">${PLAYERS.map(pl => `<label class="present-opt">
        <input type="checkbox" id="f-present-${idAttr}-${pl.id}" value="${pl.id}"${sessionPresent(s).some(id => String(id) === String(pl.id)) ? ' checked' : ''}>
        ${escHtml(pl.name)}</label>`).join('')}</div></div>` : ''}
    <div class="form-row"><label>Recap</label><textarea class="edit-textarea" id="f-recap-${idAttr}" placeholder="What actually happened at the table…">${escHtml(s.recap||'')}</textarea></div>
    <div class="form-row-pair">
      <div class="form-row"><label>NPCs met</label><input class="edit-input" id="f-npcs-${idAttr}" type="text" placeholder="Comma separated" value="${escHtml(s.npcs||'')}"></div>
      <div class="form-row"><label>Places</label><input class="edit-input" id="f-places-${idAttr}" type="text" placeholder="Comma separated" value="${escHtml(s.places||'')}"></div>
    </div>
    <div class="form-row-pair">
      <div class="form-row"><label>XP awarded</label><input class="edit-input" id="f-xp-${idAttr}" type="number" placeholder="0" value="${escHtml(String(s.xp||''))}"></div>
      <div class="form-row" style="flex:2;"><label>Loot &amp; rewards</label><input class="edit-input" id="f-loot-${idAttr}" type="text" placeholder="Items, currency, favors gained" value="${escHtml(s.loot||'')}"></div>
    </div>
    <div class="form-row"><label>Next time</label><input class="edit-input" id="f-next-${idAttr}" type="text" placeholder="Where you left them, and what opens the next one" value="${escHtml(s.next||'')}"></div>
    <div class="form-actions">
      <button class="action-btn primary" onclick="${isNew ? 'submitNewForm()' : `saveEdit('${s.id}')`}">${isNew ? 'Add Session' : 'Save Changes'}</button>
      <button class="action-btn" onclick="${isNew ? 'cancelNewForm()' : 'cancelEdit()'}">Cancel</button>
    </div>
  </div>`;
}

function readForm(idAttr) {
  const val = (name) => {
    const el = document.getElementById(`f-${name}-${idAttr}`);
    return el ? el.value.trim() : '';
  };
  return {
    number: Number(document.getElementById(`f-number-${idAttr}`).value) || 0,
    date: document.getElementById(`f-date-${idAttr}`).value,
    title: val('title'),
    arc: val('arc'),
    // Ids rather than names: a character renamed in the roster still reads
    // correctly on every session they were ever at.
    present: PLAYERS.filter(pl => {
      const box = document.getElementById(`f-present-${idAttr}-${pl.id}`);
      return box && box.checked;
    }).map(pl => pl.id),
    recap: val('recap'),
    npcs: val('npcs'),
    places: val('places'),
    xp: Number(document.getElementById(`f-xp-${idAttr}`).value) || 0,
    loot: val('loot'),
    next: val('next'),
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
