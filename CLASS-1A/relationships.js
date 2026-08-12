// Class 1-A toolkit page logic. Extracted from relationships.html so it can be
// linted, diffed and tested directly instead of regex-scraped out of HTML.
// Loaded as a CLASSIC script (not a module) on purpose: the page wires buttons
// with inline onclick= handlers, which resolve against globals, and top-level
// function declarations here become globals exactly as they did inline. Loading
// this as type="module" would scope them and silently break every handler.
// Runs after auth.js, so fbAuthReady/fsMergeSave are already defined.

const db = firebase.firestore();

const STAT_KEYS = ['STR','DEX','CON','INT','WIS','CHA','TECH'];
let CHARACTERS = [];
let selected = null;
let activeTab = 'personality';
let rels = {};
let currentView = 'character';

const SECTION_ORDER  = ['class-1a'];

/* ── Save status ──────────────────────────────────────── */
function setSaveStatus(state, text) {
  const el = document.getElementById('save-status');
  el.className = state;
  el.textContent = text;
}

/* ── Firestore storage ────────────────────────────────── */
const FS_COLLECTION = 'mha-dnd';
const FS_DOC        = 'relationships-bundle';

let canWrite = false;

document.addEventListener('auth-state-changed', (e) => {
  canWrite = e.detail.role === 'admin' || e.detail.role === 'editor';
  if (selected) showTab(activeTab);
});

function buildBundle() {
  const characters = {};
  for (const c of CHARACTERS) { if (c._file) characters[c._file] = c; }
  return { version: 1, exported_at: new Date().toISOString(), relationships: rels, characters };
}

// Attacks and inventory items are edited live by whoever has this character
// open, so two people saving around the same time is routine, not an edge
// case — one player adds an attack, the DM tweaks that PC's HP a moment
// later, both from a snapshot that predates the other's change. Firestore's
// own merge:true only merges *object* fields recursively; an array field
// (abilities, inventory items) is always replaced wholesale, so whichever
// save lands second would silently erase whatever the other person added to
// that array. genId()/ensureCharIds() give every item a stable id so
// fsMergeSave can merge those arrays by item instead of overwriting them —
// same mechanism the battle board already uses for combatants/strokes.
// Migration note: existing (pre-fix) attacks/items have no id yet. If two
// clients both load the same un-migrated character before either of them
// saves, each backfills that item with a *different* generated id, and the
// next merge sees two distinct items instead of one edited one — a visible,
// harmless duplicate card, not data loss. It's a one-time, self-resolving
// window: the first save of any kind persists real ids to Firestore, and
// every client after that loads the already-migrated ids instead of
// generating its own.
function genId(prefix) {
  return prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function ensureCharIds(c) {
  const abilities = c.quirk_mechanics?.abilities;
  if (Array.isArray(abilities)) for (const a of abilities) if (!a.id) a.id = genId('atk');
  const items = c.inventory?.items;
  if (Array.isArray(items)) for (const it of items) if (!it.id) it.id = genId('item');
}

const FS_REL_DOC = db.collection(FS_COLLECTION).doc(FS_DOC);
let _lastSyncedRel = null;
// True only while a manual save triggered by the Save button is actually in
// flight (not while edits are merely pending).
let _relSavePending = false;

// What has unsaved local edits, tracked per field rather than as one global
// "dirty" boolean. Saving here is manual (the Save button), so this window is
// unbounded — it lasts however long the user takes to click Save. A single
// boolean couldn't express "this one note is unsaved, everything else is safe
// to sync", so any incoming snapshot had to be either applied wholesale
// (reverting the edit) or blocked wholesale (going stale). Tracking per field
// lets applyRemoteRelBundle take remote data for everything *except* the exact
// fields the user is still working on.
//
// Each entry maps to a monotonic edit sequence number rather than being a bare
// set member. That matters: if you edit the same note twice — once before
// clicking Save and once while the save is still in flight — a set has no way
// to tell those apart, so clearing the key on completion would mark the second,
// never-written edit clean. The sequence number lets manualSaveRelationships
// clear only entries that haven't been touched since it captured them.
let _editSeq = 0;
let _dirtyRelKeys   = new Map();  // "fromId:toId" -> edit seq
let _dirtyCharFiles = new Map();  // c._file       -> edit seq
function isDirty() { return _dirtyRelKeys.size > 0 || _dirtyCharFiles.size > 0; }

async function saveToFirestore() {
  await fbAuthReady;
  for (const c of CHARACTERS) ensureCharIds(c);
  const idArrays = [];
  for (const c of CHARACTERS) {
    if (!c._file) continue;
    idArrays.push({ path: ['characters', c._file, 'quirk_mechanics', 'abilities'], idKey: 'id' });
    idArrays.push({ path: ['characters', c._file, 'inventory', 'items'], idKey: 'id' });
  }
  _lastSyncedRel = await fsMergeSave(FS_REL_DOC, buildBundle(), _lastSyncedRel, idArrays);
}

async function loadFromFirestore() {
  await fbAuthReady;
  const snap = await FS_REL_DOC.get();
  if (!snap.exists) return null;
  const parsed = snap.data();
  return (parsed.version === 1 && parsed.characters) ? parsed : null;
}

// Live feed: pull in other tabs' character/relationship saves so this tab's
// local copy never goes stale and clobbers them on its own next save.
//
// Incoming snapshots used to be parked in a "pending" variable while the user
// was editing, then applied once that guard cleared. That was the bug: the
// parked bundle was never invalidated when a local save superseded it, so
// clicking Save (which cleared the guard) applied a bundle that predated the
// save and reverted the edit. There is no parking any more — the merge below
// is safe to run at any time because it never overwrites a field listed in
// _dirtyRelKeys/_dirtyCharFiles, so a snapshot can be applied the moment it
// arrives. Only the *render* is deferred, and only to protect the caret.
let _pendingRender = false;

// Re-rendering replaces innerHTML, which destroys the caret and any half-typed
// text in the field being edited. This gates rendering only, never the data
// merge. (The old version tested for '#view-relationships', an id that exists
// nowhere in this repo — so for the relationship notes, which live in
// #rel-section, this check silently always returned false.)
function isFieldFocused() {
  const el = document.activeElement;
  const tag = el?.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return false;
  return !!el.closest('#profile, #rel-section');
}

// Remote wins for every key except the ones holding unsaved local edits.
// `dirtyKeys` is any iterable of key strings (callers pass a Map's .keys()).
// Kept as a pure top-level function so scripts/verify-merge-safety.js can
// extract and test it: this apply-remote path is where the "my typing gets
// undone" bug lived, and it previously had no test coverage at all.
function mergeRemoteRels(localRels, incomingRels, dirtyKeys) {
  const merged = Object.assign({}, incomingRels);
  for (const k of dirtyKeys) {
    if (Object.prototype.hasOwnProperty.call(localRels, k)) merged[k] = localRels[k];
  }
  return merged;
}

// _lastSyncedRel is fsMergeSave's 3-way baseline — "what this client has seen
// on the server". It must only advance for characters we actually applied. If
// it claimed we'd seen a remote-added ability that our (skipped, still dirty)
// local copy lacks, the next merge would read that absence as "this client
// deleted it" and drop another player's attack. `dirtyCharFiles` is any
// iterable of filenames. Pure + top-level so scripts/verify-merge-safety.js
// can test that edge case.
function nextSyncBaseline(data, prevBaseline, dirtyCharFiles) {
  const characters = Object.assign({}, data.characters);
  for (const f of dirtyCharFiles) {
    const prev = prevBaseline?.characters?.[f];
    if (prev === undefined) delete characters[f];
    else characters[f] = prev;
  }
  return Object.assign({}, data, { characters });
}

function applyRemoteRelBundle(data) {
  rels = mergeRemoteRels(rels, data.relationships || {}, _dirtyRelKeys.keys());

  for (const c of CHARACTERS) {
    if (!c._file || !data.characters?.[c._file]) continue;
    if (_dirtyCharFiles.has(c._file)) continue; // unsaved local edits — leave it alone
    const f = c._file, rid = c._roster_id, sec = c._section;
    Object.assign(c, data.characters[c._file]);
    c._file = f; c._roster_id = rid; c._section = sec;
    ensureCharIds(c); // backfill in case this remote copy predates the id fix
  }
  _lastSyncedRel = nextSyncBaseline(data, _lastSyncedRel, _dirtyCharFiles.keys());
  renderSynced();
}

function renderSynced() {
  if (isFieldFocused()) { _pendingRender = true; return; }
  _pendingRender = false;
  if (!selected) return;
  renderProfile();
  renderRelationships();
  refreshSidebar();
}

// Split out of the listener so scripts/verify-relationship-sync.js can drive
// it directly, without needing a live Firestore connection.
function handleRelSnapshot(snap) {
  if (!snap.exists) return;
  // A cached snapshot is this tab's own stale copy, not news from the server,
  // and must never be applied as if it were. When Firestore's streaming
  // channel is blocked (Safari tracking protection, content blockers, some
  // proxies) the write transport keeps working while the listener goes offline
  // and replays cache — so a save would commit successfully and then be
  // visibly "undone" by data older than the write. Wait for a server-confirmed
  // snapshot instead.
  if (snap.metadata?.fromCache) return;
  const data = snap.data();
  if (data.version !== 1 || !data.characters) return;
  applyRemoteRelBundle(data);
}

async function startRelLiveSync() {
  await fbAuthReady;
  FS_REL_DOC.onSnapshot(handleRelSnapshot, err => {
    // Previously swallowed, which made a dead listener indistinguishable from
    // a working one. Say so: edits still save, they just won't stream in.
    console.error('[relationships] live sync stopped:', err);
    if (!isDirty()) setSaveStatus('error', 'Live sync offline — saving still works');
  });
}

// Flush a render that was deferred while the user was typing. focusout catches
// the common case immediately; the interval is the backstop for focus moving
// somewhere without a focusout we hear about (e.g. the window losing focus).
document.addEventListener('focusout', () => {
  setTimeout(() => { if (_pendingRender) renderSynced(); }, 0);
});
setInterval(() => { if (_pendingRender) renderSynced(); }, 1500);

// Called by every field/score edit. Saving here is manual (the Save button in
// #save-bar), not automatic — these just record *what* changed and let the user
// decide when to write it, instead of a timer racing a background sync that
// could revert the edit before it's sent.
function markRelDirty(key)   { _dirtyRelKeys.set(key, ++_editSeq); onDirtyChanged(); }
function markCharDirty(file) { if (!file) return; _dirtyCharFiles.set(file, ++_editSeq); onDirtyChanged(); }
function onDirtyChanged() { setSaveStatus('dirty', 'Unsaved changes'); refreshSaveBar(); }

// Button state only — deliberately does not touch the status text, so it can be
// called after a failed save without wiping the error message off the bar.
function refreshSaveBar() {
  const btn = document.getElementById('rel-save-btn');
  if (!btn || _relSavePending) return;
  const dirty = isDirty();
  btn.disabled = !dirty;
  btn.classList.toggle('dirty', dirty);
  btn.title = dirty ? 'Save unsaved changes' : 'No unsaved changes';
}

async function manualSaveRelationships() {
  if (!isDirty() || _relSavePending) return;
  const btn = document.getElementById('rel-save-btn');
  // Capture exactly what this save is flushing, before the await. Anything
  // typed during the round-trip must stay dirty: buildBundle() snapshots the
  // data when the save *starts*, so later keystrokes aren't in this write.
  // Clearing the whole dirty set on completion (what the previous version did)
  // marked those edits clean without ever writing them — losing both the data
  // and the protection that keeps an incoming snapshot from overwriting them.
  //
  // Deliberate asymmetry: an edit landing between this capture and
  // buildBundle() is written *and* stays dirty, so it simply saves twice.
  // That's harmless. The reverse — clean but unwritten — is data loss.
  const sentRelKeys   = new Map(_dirtyRelKeys);
  const sentCharFiles = new Map(_dirtyCharFiles);
  _relSavePending = true;
  setSaveStatus('saving', 'Saving…');
  if (btn) btn.disabled = true;
  try {
    await saveToFirestore();
    // Clear only what hasn't been re-edited since the capture above; a bumped
    // sequence number means this field changed after the bundle was built and
    // is therefore still unsaved.
    for (const [k, seq] of sentRelKeys)   if (_dirtyRelKeys.get(k)   === seq) _dirtyRelKeys.delete(k);
    for (const [f, seq] of sentCharFiles) if (_dirtyCharFiles.get(f) === seq) _dirtyCharFiles.delete(f);
    _relSavePending = false;
    // Edits that arrived mid-flight are legitimately still unsaved — say so
    // rather than flashing "Saved" over them.
    if (isDirty()) setSaveStatus('dirty', 'Unsaved changes');
    else setSaveStatus('saved', 'Saved ' + new Date().toLocaleTimeString());
    refreshSaveBar();
  } catch (e) {
    _relSavePending = false;
    setSaveStatus('error', e.message);
    refreshSaveBar(); // still dirty — let them retry
  }
}

// Warn before leaving the tab with unsaved edits sitting in memory — there's
// no auto-save left to fall back on now that saving is manual.
window.addEventListener('beforeunload', (e) => {
  if (!isDirty()) return;
  e.preventDefault();
  e.returnValue = '';
});

/* ── View switching ───────────────────────────────────── */
function setView(view) {
  currentView = view;
  document.querySelectorAll('.main-view').forEach(el => el.classList.remove('active'));
  document.getElementById('view-' + view).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach((btn, i) => {
    btn.classList.toggle('active', ['character','dice'][i] === view);
  });
}

/* ── Relationships persistence ────────────────────────── */
function relKey(from, to) { return from + ':' + to; }
function getRel(fromId, toId) { return rels[relKey(fromId, toId)] || { score: 0, note: '' }; }

function setRelScore(fromId, toId, score) {
  const k = relKey(fromId, toId);
  rels[k] = rels[k] || { score: 0, note: '' };
  rels[k].score = Math.max(-10, Math.min(10, parseInt(score) || 0));
  updateScoreDisplay(fromId, toId, score);
  markRelDirty(k);
}
function setRelNote(fromId, toId, note) {
  const k = relKey(fromId, toId);
  rels[k] = rels[k] || { score: 0, note: '' };
  rels[k].note = note;
  markRelDirty(k);
}
function updateScoreDisplay(fromId, toId, score) {
  const el = document.getElementById('score-'+fromId+'-'+toId);
  if (!el) return;
  score = parseInt(score);
  el.textContent = score > 0 ? '+'+score : ''+score;
  el.className = 'rel-score '+(score<0?'score-neg':score>0?'score-pos':'score-zero');
}

/* ── Character persistence ────────────────────────────── */
function scheduleCharSave(c) { markCharDirty(c?._file); }

function onStatChange(field, value, isFloat) {
  const c = selected;
  const num = isFloat ? parseFloat(value) : parseInt(value);
  if (isNaN(num)) return;
  c[field] = num;
  scheduleCharSave(c);
}
function onAbilityScoreChange(key, value) {
  const c = selected;
  const num = parseInt(value);
  if (isNaN(num)) return;
  c.ability_scores[key] = num;
  const mod = Math.floor((num - 10) / 2);
  c.modifiers[key] = mod;
  const modEl = document.getElementById('mod-'+key);
  if (modEl) modEl.textContent = (mod>=0?'+':'')+mod;
  scheduleCharSave(c);
}
function onClassChange(value) { selected.suggested_class = value; scheduleCharSave(selected); }

function refreshSidebar() {
  renderSidebar();
  filterList(document.getElementById('search').value);
}

function onNameChange(value) {
  const v = value.trim();
  if (!v) { renderProfile(); return; }
  selected.name = v;
  scheduleCharSave(selected);
  document.getElementById('profile-avatar').textContent = initials(selected.name);
  refreshSidebar();
}
function onSubFieldChange(field, value) {
  selected[field] = value;
  scheduleCharSave(selected);
  if (field === 'quirk') refreshSidebar();
}
function onCategoryChange(value) {
  selected.is_pc = value === 'pc';
  scheduleCharSave(selected);
  refreshSidebar();
  renderProfile();
}

/* ── Sidebar ──────────────────────────────────────────── */
function initials(name) { return name.split(' ').slice(0,2).map(w=>w[0]).join(''); }

const AV_CLASS = { 'class-1a': c => c.is_pc ? 'av-pc' : 'av-npc' };

function renderSidebar() {
  const visible = CHARACTERS;

  let html = '';
  const pcs = visible.filter(c => c.is_pc), npcs = visible.filter(c => !c.is_pc);
  if (pcs.length)  { html += '<div class="section-label">Player Characters</div>'; for (const c of pcs)  html += charItem(c); }
  if (npcs.length) { html += '<div class="section-label">Class 1-A</div>'; for (const c of npcs) html += charItem(c); }
  document.getElementById('char-list').innerHTML = html;
}

function charItem(c) {
  const av = (AV_CLASS[c._section] || (()=>'av-npc'))(c);
  const active = selected && c._roster_id === selected._roster_id ? ' active' : '';
  const sub = c._alias ? c._alias : c.quirk;
  return `<div class="char-item${active}" onclick="selectChar(${c._roster_id})" id="item-${c._roster_id}">
    <div class="char-avatar ${av}">${initials(c.name)}</div>
    <div class="char-info"><div class="char-name">${c.name}</div><div class="char-quirk">${sub}</div></div>
  </div>`;
}

function selectChar(id) {
  selected = CHARACTERS.find(c => c._roster_id === id);
  document.querySelectorAll('.char-item').forEach(el => el.classList.remove('active'));
  const item = document.getElementById('item-'+id);
  if (item) item.classList.add('active');
  activeTab = 'personality';
  renderProfile();
  renderRelationships();
  setView('character');
  if (window.innerWidth <= 640) document.getElementById('app').classList.add('mobile-main');
}

function mobileBack() {
  document.getElementById('app').classList.remove('mobile-main');
}

function mobileFwd(view) {
  setView(view);
  document.getElementById('app').classList.add('mobile-main');
}

function filterList(q) {
  const query = q.toLowerCase();
  document.querySelectorAll('.char-item').forEach(el => {
    const name = el.querySelector('.char-name').textContent.toLowerCase();
    const quirk = el.querySelector('.char-quirk').textContent.toLowerCase();
    el.style.display = (name.includes(query)||quirk.includes(query)) ? '' : 'none';
  });
  document.querySelectorAll('.section-label').forEach(el => el.style.display = q ? 'none' : '');
}

/* ── Profile ──────────────────────────────────────────── */
function renderProfile() {
  const c = selected;
  const avEl = document.getElementById('profile-avatar');
  avEl.textContent = initials(c.name);
  const SEC_COLORS = { 'class-1a': c.is_pc ? ['var(--accent-light)','var(--accent-text)'] : ['var(--teal-light)','var(--teal-text)'], 'class-1b': ['var(--amber-light)','var(--amber-text)'], teachers: ['var(--green-light)','var(--green-text)'], villains: ['var(--red-light)','var(--red-text)'], supporting: ['rgba(99,102,241,0.13)','#a5b4fc'] };
  const [avBg, avColor] = SEC_COLORS[c._section || 'class-1a'] || SEC_COLORS['class-1a'];
  avEl.style.background = avBg; avEl.style.color = avColor;
  document.getElementById('profile-name').innerHTML =
    `<input class="name-input" type="text" value="${escHtml(c.name||'')}" onchange="onNameChange(this.value)" title="Character name">`;

  document.getElementById('profile-sub').innerHTML = `
    <input class="sub-input sub-input-quirk" type="text" value="${escHtml(c.quirk||'')}" placeholder="Quirk" onchange="onSubFieldChange('quirk',this.value)" title="Quirk">
    <span class="sub-sep">·</span>
    <select class="sub-select" onchange="onCategoryChange(this.value)" title="Category">
      <option value="npc" ${!c.is_pc?'selected':''}>Class 1-A</option>
      <option value="pc" ${c.is_pc?'selected':''}>Player Character</option>
    </select>
    <span class="sub-sep">·</span>
    <input class="sub-input" type="text" value="${escHtml(c.physiology||'')}" placeholder="Physiology" onchange="onSubFieldChange('physiology',this.value)" title="Physiology">
    <span class="sub-sep">·</span>
    <input class="sub-input sub-input-narrow" type="text" value="${escHtml(c.height||'')}" placeholder="Height" onchange="onSubFieldChange('height',this.value)" title="Height">
    <span class="sub-sep">·</span>
    <input class="sub-input sub-input-narrow" type="text" value="${escHtml(c.gender||'')}" placeholder="Gender" onchange="onSubFieldChange('gender',this.value)" title="Gender">
  `;

  const tags = document.getElementById('tags-row');
  const lv = c.level || 1;
  const prof = Math.floor((lv - 1) / 4) + 2;
  const wisMod = (c.modifiers || {}).WIS ?? Math.floor(((c.ability_scores || {}).WIS ?? 10) - 10) / 2 | 0;
  const passivePerc = 10 + wisMod + prof;
  let tagHtml = '';
  if (c.is_pc) tagHtml += '<span class="tag tag-pc">PC</span>';
  tagHtml += `<div class="edit-wrap"><label>Lv</label><input class="stat-input" type="number" min="1" max="20" value="${lv}" onchange="onStatChange('level',this.value,false)" title="Level"></div>`;
  tagHtml += `<div class="edit-wrap"><label>HP</label><input class="stat-input" type="number" min="1" value="${c.HP||10}" onchange="onStatChange('HP',this.value,false)" title="Max HP"></div>`;
  tagHtml += `<div class="edit-wrap"><label>AC</label><input class="stat-input" type="number" min="1" value="${c.AC||10}" onchange="onStatChange('AC',this.value,false)" title="Armour Class"></div>`;
  tagHtml += `<div class="edit-wrap"><label>Class</label><input class="class-input" type="text" value="${escHtml(c.suggested_class||'')}" onchange="onClassChange(this.value)" title="Class"></div>`;
  tagHtml += `<div class="stat-chip" title="Proficiency bonus (level ${lv})">Prof +${prof}</div>`;
  tagHtml += `<div class="stat-chip" title="Passive Perception = 10 + WIS mod + Prof">Passive ${passivePerc}</div>`;
  tagHtml += `<button class="profile-action-btn" onclick="copyStatBlock()" title="Copy stat block to clipboard">⧉ Copy</button>`;
  tags.innerHTML = tagHtml;

  const sc = c.ability_scores || {};
  const mo = c.modifiers || {};
  document.getElementById('scores-row').innerHTML = STAT_KEYS.map(k => {
    const val = sc[k] ?? 10;
    const mod = mo[k] ?? Math.floor((val-10)/2);
    return `<div class="score-block">
      <span class="score-label">${k}</span>
      <input class="score-val-input" type="number" min="1" max="30" value="${val}" onchange="onAbilityScoreChange('${k}',this.value)" title="${k}">
      <span class="score-mod" id="mod-${k}">${(mod>=0?'+':'')+mod}</span>
    </div>`;
  }).join('');

  showTab(activeTab);
}

function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function copyStatBlock() {
  const c = selected;
  if (!c) return;
  const lv = c.level || 1;
  const prof = Math.floor((lv - 1) / 4) + 2;
  const mo = c.modifiers || {};
  const sc = c.ability_scores || {};
  const fmt = k => { const v = sc[k] ?? 10; const m = mo[k] ?? (Math.floor((v-10)/2)); return `${k} ${m>=0?'+':''}${m}`; };
  const line = `${c.name} — Lv ${lv} ${c.suggested_class||''} | HP: ${c.HP||10}  AC: ${c.AC||10}  Prof: +${prof} | ${['STR','DEX','CON','INT','WIS','CHA'].map(fmt).join('  ')}`;
  navigator.clipboard.writeText(line).then(() => {
    const btn = document.querySelector('.profile-action-btn');
    if (btn && btn.textContent.includes('Copy')) { btn.textContent = '✓ Copied'; setTimeout(() => btn.textContent = '⧉ Copy', 1500); }
  });
}

function showTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.textContent.trim().toLowerCase().replace(/\s+/g,'')===tab.replace(/\s+/g,''));
  });
  const c = selected;
  if (tab==='personality') {
    return renderEditableTab((c.personality||{}).summary||'', v => { c.personality = c.personality||{}; c.personality.summary = v; });
  }
  if (tab==='appearance') {
    const app = c.appearance||{};
    return renderEditableTab([app.hair,app.build,app.other].filter(Boolean).join(' — '), v => { c.appearance = { hair: null, build: null, other: v }; });
  }
  if (tab==='combat') {
    return renderEditableTab((c.dm_notes||{}).combat_role||'', v => { c.dm_notes = c.dm_notes||{}; c.dm_notes.combat_role = v; });
  }
  if (tab==='social') {
    return renderEditableTab((c.dm_notes||{}).social_role||'', v => { c.dm_notes = c.dm_notes||{}; c.dm_notes.social_role = v; });
  }
  if (tab==='background') {
    return renderEditableTab(c.backstory||'', v => { c.backstory = v; });
  }
  if (tab==='attacks') {
    return renderAttacksTab(c);
  }
  if (tab==='inventory') {
    return renderInventoryTab(c);
  }
  if (tab==='additionalfeatures') {
    return renderEditableTab(c.additional_features||'', v => { c.additional_features = v; });
  }
}

function renderAttacksTab(c) {
  const tabContent = document.getElementById('tab-content');
  tabContent.classList.remove('tab-quirk', 'tab-inventory');
  tabContent.classList.add('tab-attacks');
  c.quirk_mechanics = c.quirk_mechanics || {};
  const abilities = c.quirk_mechanics.abilities = c.quirk_mechanics.abilities || [];

  const cards = abilities.map((a, i) => {
    if (canWrite) {
      return `
    <div class="ability-card ability-card-editable">
      <div class="ability-edit-row">
        <input class="ability-input ability-input-name" placeholder="Attack name" value="${escHtml(a.name||'')}" oninput="onAttackEdit(${i},'name',this.value)">
        <button class="icon-btn ability-delete-btn" title="Delete attack" aria-label="Delete attack" onclick="onAttackDelete(${i})">✕</button>
      </div>
      <input class="ability-input ability-input-type" placeholder="Type (e.g. Action; costs 2 Heat Points)" value="${escHtml(a.type||'')}" oninput="onAttackEdit(${i},'type',this.value)">
      <textarea class="ability-input ability-input-desc" rows="2" placeholder="Description" oninput="onAttackEdit(${i},'description',this.value)">${escHtml(a.description||'')}</textarea>
    </div>`;
    }
    return `
    <div class="ability-card">
      <div class="ability-name">${escHtml(a.name||'')}${a.type ? `<span class="ability-type">${escHtml(a.type)}</span>` : ''}</div>
      ${a.damage ? `<div class="ability-desc"><strong>Damage:</strong> ${escHtml(a.damage)}</div>` : ''}
      ${a.description ? `<div class="ability-desc">${escHtml(a.description)}</div>` : ''}
    </div>`;
  });

  if (!abilities.length) {
    cards.push(`<div class="ability-card locked"><div class="ability-name">No attacks recorded</div></div>`);
  }

  if (canWrite) {
    cards.push(`<button class="add-attack-btn" onclick="onAttackAdd()">+ Add attack</button>`);
  }

  tabContent.innerHTML = cards.join('');
}

function onAttackEdit(i, field, value) {
  const abilities = selected.quirk_mechanics.abilities;
  if (!abilities[i]) return;
  abilities[i][field] = value;
  scheduleCharSave(selected);
}

function onAttackAdd() {
  selected.quirk_mechanics.abilities.push({ id: genId('atk'), name: '', type: '', description: '' });
  scheduleCharSave(selected);
  renderAttacksTab(selected);
}

function onAttackDelete(i) {
  selected.quirk_mechanics.abilities.splice(i, 1);
  scheduleCharSave(selected);
  renderAttacksTab(selected);
}

/* ── Inventory ─────────────────────────────────────────
   Currency denominations & Yen (¥) conversion rates are from
   the MHA D&D Official Handbook, Chapter 4: Equipment. */
const CURRENCY_KEYS = ['yen','pp','gp','ep','sp','cp'];
const CURRENCY_LABELS = { yen: '¥ Yen', pp: 'PP', gp: 'GP', ep: 'EP', sp: 'SP', cp: 'CP' };
const CURRENCY_TO_YEN = { yen: 1, cp: 10, sp: 100, ep: 500, gp: 1000, pp: 10000 };

function renderInventoryTab(c) {
  const tabContent = document.getElementById('tab-content');
  tabContent.classList.remove('tab-quirk', 'tab-attacks');
  tabContent.classList.add('tab-inventory');
  c.inventory = c.inventory || {};
  const currency = c.inventory.currency = c.inventory.currency || { yen: 0, cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 };
  const items = c.inventory.items = c.inventory.items || [];

  const totalYen = CURRENCY_KEYS.reduce((sum, k) => sum + (currency[k]||0) * CURRENCY_TO_YEN[k], 0);

  const currencyBlocks = CURRENCY_KEYS.map(k => `
    <div class="inv-currency-block">
      <label>${CURRENCY_LABELS[k]}</label>
      <input class="inv-currency-input" type="number" min="0" value="${currency[k]||0}"
        ${canWrite ? `onchange="onCurrencyChange('${k}',this.value)"` : 'disabled'} title="${CURRENCY_LABELS[k]}">
    </div>`).join('');

  const itemCards = items.map((it, i) => {
    if (canWrite) {
      return `
    <div class="ability-card ability-card-editable">
      <div class="ability-edit-row">
        <input class="ability-input ability-input-name" placeholder="Item name" value="${escHtml(it.name||'')}" oninput="onItemEdit(${i},'name',this.value)">
        <input class="ability-input inv-item-qty" type="number" min="0" placeholder="Qty" value="${it.qty ?? 1}" oninput="onItemEdit(${i},'qty',this.value)" title="Quantity">
        <button class="icon-btn ability-delete-btn" title="Delete item" aria-label="Delete item" onclick="onItemDelete(${i})">✕</button>
      </div>
      <textarea class="ability-input ability-input-desc" rows="2" placeholder="Notes (e.g. weight, effect, where it came from)" oninput="onItemEdit(${i},'notes',this.value)">${escHtml(it.notes||'')}</textarea>
    </div>`;
    }
    return `
    <div class="ability-card">
      <div class="ability-name">${escHtml(it.name||'')}${(it.qty ?? 1) !== 1 ? `<span class="ability-type">×${it.qty ?? 1}</span>` : ''}</div>
      ${it.notes ? `<div class="ability-desc">${escHtml(it.notes)}</div>` : ''}
    </div>`;
  });

  if (!items.length) {
    itemCards.push(`<div class="inv-empty">No items yet.</div>`);
  }
  if (canWrite) {
    itemCards.push(`<button class="add-attack-btn" onclick="onItemAdd()">+ Add item</button>`);
  }

  tabContent.innerHTML = `
    <div class="inv-currency-panel">
      <div class="inv-currency-title">Currency</div>
      <div class="inv-currency-row">${currencyBlocks}</div>
      <div class="inv-currency-total">Total value: <strong>¥${totalYen.toLocaleString()}</strong> <span title="1cp=¥10 · 1sp=¥100 · 1ep=¥500 · 1gp=¥1,000 · 1pp=¥10,000">(handbook conversion)</span></div>
    </div>
    <div class="inv-items-title">Items</div>
    ${itemCards.join('')}
  `;
}

function onCurrencyChange(key, value) {
  const num = Math.max(0, parseInt(value) || 0);
  selected.inventory.currency[key] = num;
  scheduleCharSave(selected);
  renderInventoryTab(selected);
}

function onItemEdit(i, field, value) {
  const items = selected.inventory.items;
  if (!items[i]) return;
  items[i][field] = field === 'qty' ? Math.max(0, parseInt(value) || 0) : value;
  scheduleCharSave(selected);
}

function onItemAdd() {
  selected.inventory.items.push({ id: genId('item'), name: '', qty: 1, notes: '' });
  scheduleCharSave(selected);
  renderInventoryTab(selected);
}

function onItemDelete(i) {
  selected.inventory.items.splice(i, 1);
  scheduleCharSave(selected);
  renderInventoryTab(selected);
}

/* ── Editable tab content ────────────────────────────── */
let currentTabSave = null;

function renderEditableTab(value, onSave) {
  currentTabSave = onSave;
  const tabContent = document.getElementById('tab-content');
  tabContent.classList.remove('tab-quirk', 'tab-attacks', 'tab-inventory');
  if (canWrite) {
    tabContent.innerHTML = `<textarea class="tab-editable" rows="4" placeholder="Nothing here yet — click to add." oninput="onTabEdit(this.value)">${escHtml(value)}</textarea>`;
  } else {
    tabContent.textContent = value;
  }
}

function onTabEdit(value) {
  if (currentTabSave) currentTabSave(value);
  scheduleCharSave(selected);
}

/* ── Relationships ────────────────────────────────────── */
function renderRelationships() {
  const c = selected;
  document.getElementById('rel-heading').textContent = c.name+"'s view of classmates";
  const others = CHARACTERS.filter(o => o._roster_id !== c._roster_id && o._section === 'class-1a');
  let html = '';
  for (const o of others) {
    const rel = getRel(c._roster_id, o._roster_id);
    const score = rel.score||0;
    const scoreStr = score>0?'+'+score:''+score;
    const scoreClass = score<0?'score-neg':score>0?'score-pos':'score-zero';
    const av = o.is_pc?'av-pc':'av-npc';
    html += `<div class="rel-row">
      <div><div style="display:flex;align-items:center;gap:6px">
        <div class="char-avatar ${av}" style="width:24px;height:24px;font-size:9px;flex-shrink:0">${initials(o.name)}</div>
        <div><div class="rel-char-name">${o.name}</div><div class="rel-char-quirk">${o.quirk}${o.is_pc?' · PC':''}</div></div>
      </div></div>
      <div class="rel-controls">
        <div class="slider-wrap"><input type="range" class="rel-slider" min="-10" max="10" step="1" value="${score}" oninput="setRelScore(${c._roster_id},${o._roster_id},this.value)"></div>
        <div class="rel-labels"><span>hate −10</span><span>0</span><span>love +10</span></div>
        <textarea class="rel-note" rows="1" placeholder="Add a note…" oninput="setRelNote(${c._roster_id},${o._roster_id},this.value)">${escHtml(rel.note||'')}</textarea>
      </div>
      <div class="rel-score ${scoreClass}" id="score-${c._roster_id}-${o._roster_id}">${scoreStr}</div>
    </div>`;
  }
  document.getElementById('rel-list').innerHTML = html;
  applyRelCollapseState();
}

function getRelCollapseKey() {
  return 'relCollapsed-' + selected._roster_id;
}
function applyRelCollapseState() {
  const collapsed = localStorage.getItem(getRelCollapseKey()) === '1';
  document.getElementById('rel-list').classList.toggle('collapsed', collapsed);
  document.getElementById('rel-toggle-btn').classList.toggle('collapsed', collapsed);
  document.getElementById('rel-section').classList.toggle('collapsed', collapsed);
  document.getElementById('profile').classList.toggle('expanded', collapsed);
}
function toggleRelCollapse() {
  const key = getRelCollapseKey();
  const collapsed = localStorage.getItem(key) === '1';
  localStorage.setItem(key, collapsed ? '0' : '1');
  applyRelCollapseState();
}

/* ══════════════════════════════════════════════════════════
   DICE ROLLER
══════════════════════════════════════════════════════════ */
let diceState = { sides: 4, count: 1, mod: 0, advMode: null }; // advMode: null | 'adv' | 'dis'
let diceHistory = [];

function toggleAdvMode(mode) {
  diceState.advMode = diceState.advMode === mode ? null : mode;
  document.getElementById('dice-adv-btn').classList.toggle('active', diceState.advMode === 'adv');
  document.getElementById('dice-dis-btn').classList.toggle('active', diceState.advMode === 'dis');
  updateRollBtn();
}

function selectDie(sides, btn) {
  diceState.sides = sides;
  document.querySelectorAll('.die-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  // Adv/Dis only applies to d20
  const hint = document.getElementById('adv-hint');
  if (sides !== 20 && diceState.advMode) { diceState.advMode = null; document.getElementById('dice-adv-btn').classList.remove('active'); document.getElementById('dice-dis-btn').classList.remove('active'); }
  if (hint) hint.style.display = sides === 20 ? 'none' : (diceState.advMode ? 'inline' : 'none');
  updateRollBtn();
}
function adjustDice(delta) {
  diceState.count = Math.max(1, Math.min(20, diceState.count + delta));
  document.getElementById('dice-count').textContent = diceState.count;
  updateRollBtn();
}
function adjustMod(delta) {
  diceState.mod = Math.max(-20, Math.min(20, diceState.mod + delta));
  const el = document.getElementById('dice-mod');
  el.textContent = diceState.mod >= 0 ? '+'+diceState.mod : ''+diceState.mod;
  updateRollBtn();
}
function updateRollBtn() {
  const { count, sides, mod } = diceState;
  let label = `Roll ${count}d${sides}`;
  if (mod > 0) label += ` +${mod}`;
  else if (mod < 0) label += ` ${mod}`;
  document.getElementById('roll-btn').textContent = label;
}

function rollDice() {
  const { count, sides, mod, advMode } = diceState;

  if (advMode && sides === 20) {
    const r1 = Math.floor(Math.random() * 20) + 1;
    const r2 = Math.floor(Math.random() * 20) + 1;
    const kept = advMode === 'adv' ? Math.max(r1, r2) : Math.min(r1, r2);
    const dropped = advMode === 'adv' ? Math.min(r1, r2) : Math.max(r1, r2);
    const total = kept + mod;
    const isCrit = kept === 20;
    const isFumble = kept === 1;
    const modeLabel = advMode === 'adv' ? 'Advantage' : 'Disadvantage';
    const modStr = mod !== 0 ? (mod > 0 ? ` +${mod}` : ` ${mod}`) : '';
    const label = `d20 (${modeLabel})${modStr}`;
    const entry = { label, rolls: [kept], mod, total, isCrit, isFumble, advRolls: [r1, r2], dropped, advMode };
    diceHistory.unshift(entry);
    if (diceHistory.length > 12) diceHistory.pop();
    renderDiceResult(entry);
    renderDiceHistory();
    return;
  }

  const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
  const total = rolls.reduce((a, b) => a + b, 0) + mod;
  const isCrit = sides === 20 && count === 1 && rolls[0] === 20;
  const isFumble = sides === 20 && count === 1 && rolls[0] === 1;
  const label = `${count}d${sides}${mod>=0?'+'+mod:mod!==0?mod:''}`.replace('+0','');

  const entry = { label, rolls, mod, total, isCrit, isFumble };
  diceHistory.unshift(entry);
  if (diceHistory.length > 12) diceHistory.pop();

  renderDiceResult(entry);
  renderDiceHistory();
}

function rollExpr() {
  const inp = document.getElementById('dice-expr-inp');
  const raw = (inp?.value || '').trim();
  if (!raw) return;
  const m = raw.replace(/\s+/g,'').match(/^(\d+)d(\d+)([+-]\d+)?$/i);
  if (!m) {
    document.getElementById('dice-result').innerHTML = `<div style="color:var(--red-text);font-size:13px;">Invalid expression — try "2d6+3"</div>`;
    return;
  }
  const count = Math.min(parseInt(m[1]), 100);
  const sides = parseInt(m[2]);
  const mod = m[3] ? parseInt(m[3]) : 0;
  if (count < 1 || sides < 2) return;
  const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
  const total = rolls.reduce((a, b) => a + b, 0) + mod;
  const isCrit = sides === 20 && count === 1 && rolls[0] === 20;
  const isFumble = sides === 20 && count === 1 && rolls[0] === 1;
  const label = `${count}d${sides}${mod>0?'+'+mod:mod<0?mod:''}`;
  const entry = { label, rolls, mod, total, isCrit, isFumble };
  diceHistory.unshift(entry);
  if (diceHistory.length > 12) diceHistory.pop();
  renderDiceResult(entry);
  renderDiceHistory();
  inp.value = '';
}

function renderDiceResult(e) {
  const modStr = e.mod > 0 ? ` + ${e.mod}` : e.mod < 0 ? ` − ${Math.abs(e.mod)}` : '';
  const numClass = e.isCrit ? 'crit' : e.isFumble ? 'fumble' : '';
  const badge = e.isCrit ? '<div class="crit-label">★ Critical!</div>' : e.isFumble ? '<div class="fumble-label">☠ Fumble!</div>' : '';
  let rollStr;
  if (e.advRolls) {
    const [a, b] = e.advRolls;
    const keptStr = `<span style="font-weight:700;color:var(--text)">${e.rolls[0]}</span>`;
    const dropStr = `<span style="text-decoration:line-through;color:var(--text-dim)">${e.dropped}</span>`;
    rollStr = e.advMode === 'adv'
      ? (a >= b ? `${keptStr}, ${dropStr}` : `${dropStr}, ${keptStr}`)
      : (a <= b ? `${keptStr}, ${dropStr}` : `${dropStr}, ${keptStr}`);
    if (e.mod !== 0) rollStr += modStr;
  } else {
    rollStr = escHtml(e.rolls.join(', ') + modStr);
  }
  document.getElementById('dice-result').innerHTML = `
    <div class="result-number ${numClass}">${e.total}</div>
    <div class="result-detail">
      <div class="result-label">${e.label}</div>
      <div class="result-breakdown">${rollStr}</div>
      ${badge}
    </div>`;
}

function renderDiceHistory() {
  const el = document.getElementById('dice-history');
  if (!diceHistory.length) { el.innerHTML = ''; return; }
  el.innerHTML = diceHistory.map(e => {
    const modStr = e.mod > 0 ? ` +${e.mod}` : e.mod < 0 ? ` ${e.mod}` : '';
    const breakdown = e.rolls.join(', ') + modStr;
    const badge = e.isCrit ? '<span class="history-crit">★ Crit</span>' : e.isFumble ? '<span class="history-fumble">☠ Fumble</span>' : '';
    return `<div class="history-row">
      <span class="history-die">${e.label}</span>
      <span class="history-total">${e.total}</span>
      <span class="history-breakdown">${escHtml(breakdown)}</span>
      ${badge}
    </div>`;
  }).join('');
}

/* ── Init ──────────────────────────────────────────────── */
(async () => {
  const rosterRes = await fetch('roster.json');
  const roster = await rosterRes.json();

  // Try Firestore first, fall back to bundled JSON files
  setSaveStatus('saving', 'Loading…');
  let fsBundle = null;
  try { fsBundle = await loadFromFirestore(); } catch {}

  if (fsBundle) {
    rels = fsBundle.relationships || {};
    CHARACTERS = (roster.students || []).filter(s => s.file).map(s => {
      const c = Object.assign({}, fsBundle.characters?.[s.file] || {});
      c._file = s.file; c._roster_id = s.id; c._section = 'class-1a';
      c.name = c.name || s.name; c.quirk = c.quirk || s.quirk;
      return c;
    }).filter(c => c.name);
    setSaveStatus('saved', 'Loaded from Firestore ✓');
  } else {
    const [relsRes, ...charResults] = await Promise.all([
      fetch('relationships.json'),
      ...(roster.students || []).filter(s => s.file).map(s =>
        fetch(s.file).then(r => r.json()).then(c => { c._file = s.file; c._roster_id = s.id; c._section = 'class-1a'; return c; }).catch(() => null)
      )
    ]);
    rels = await relsRes.json();
    CHARACTERS = charResults.filter(Boolean);
    setSaveStatus('saved', 'Firestore unreachable — loaded local');
  }

  for (const c of CHARACTERS) ensureCharIds(c);
  if (fsBundle) _lastSyncedRel = fsBundle; // baseline for saveToFirestore's 3-way merge

  CHARACTERS.sort((a, b) => {
    const si = SECTION_ORDER.indexOf(a._section) - SECTION_ORDER.indexOf(b._section);
    if (si !== 0) return si;
    if (a._section === 'class-1a') { if (a.is_pc !== b.is_pc) return a.is_pc ? -1 : 1; }
    return a._roster_id - b._roster_id;
  });
  selected = CHARACTERS[0];
  if (fsBundle) startRelLiveSync();
  renderSidebar();
  renderProfile();
  renderRelationships();
})();
// ── Keyboard shortcuts ─────────────────────────────────────
document.addEventListener('keydown', e => {
  const tag = document.activeElement?.tagName;
  const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  if (inInput) return;

  if (e.key === '1') { e.preventDefault(); setView('character'); }
  else if (e.key === '2') { e.preventDefault(); setView('dice'); }
  else if ((e.key === ' ' || e.key === 'Enter') && currentView === 'dice') {
    e.preventDefault(); rollDice();
  } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && currentView === 'character') {
    e.preventDefault();
    const idx = CHARACTERS.findIndex(c => c._roster_id === selected?._roster_id);
    if (idx === -1) return;
    const next = e.key === 'ArrowRight'
      ? CHARACTERS[(idx + 1) % CHARACTERS.length]
      : CHARACTERS[(idx - 1 + CHARACTERS.length) % CHARACTERS.length];
    selectChar(next._roster_id);
  }
});

/* ── Export / Import ──────────────────────────────────── */
function exportData() {
  setSaveStatus('saving', 'Exporting…');
  try {
    const blob = new Blob([JSON.stringify(buildBundle(), null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `mha-dnd-backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click(); URL.revokeObjectURL(url);
    setSaveStatus('saved', 'Exported ✓');
  } catch { setSaveStatus('error', 'Export failed'); }
}

async function importData(input) {
  const file = input.files[0];
  if (!file) return;
  input.value = '';
  if (!confirm(`Import "${file.name}"? This will overwrite all current character data and relationships.`)) return;
  setSaveStatus('saving', 'Importing…');
  try {
    const data = JSON.parse(await file.text());
    if (data.version !== 1) throw new Error('Unsupported version');
    if (data.relationships) rels = data.relationships;
    if (data.characters) {
      for (const c of CHARACTERS) {
        if (c._file && data.characters[c._file]) {
          const f = c._file, rid = c._roster_id;
          Object.assign(c, data.characters[c._file]);
          c._file = f; c._roster_id = rid;
        }
      }
    }
    await saveToFirestore();
    setSaveStatus('saved', 'Imported ✓ — reloading…');
    setTimeout(() => location.reload(), 800);
  } catch (e) { setSaveStatus('error', 'Import failed: ' + e.message); }
}
