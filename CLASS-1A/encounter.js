// Page logic for encounter.html. Extracted from the HTML so it can be linted,
// diffed and tested directly rather than regex-scraped out of markup.
// Loaded as a CLASSIC script, not a module: the page wires controls with
// inline onclick= handlers that resolve against globals, and top-level
// declarations here become globals exactly as they did inline. type="module"
// would scope them and silently break every handler.

// Runs after auth.js, so fbAuthReady/fsMergeSave are already defined.
const db = firebase.firestore();

const CONDITIONS = ['Blinded','Charmed','Deafened','Exhausted','Frightened','Grappled',
  'Incapacitated','Invisible','Paralyzed','Poisoned','Prone','Restrained','Stunned','Unconscious'];

let CHARACTERS = [];
let ENEMIES = [];

const SECTION_ORDER = ['class-1a'];

function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

/* ── Firestore storage (read-only: character sheets live on the Class 1-A toolkit) ── */
const FS_COLLECTION = 'mha-dnd';
const FS_DOC        = 'relationships-bundle';
const FS_REL_DOC = db.collection(FS_COLLECTION).doc(FS_DOC);

async function loadFromFirestore() {
  await fbAuthReady;
  const snap = await FS_REL_DOC.get();
  if (!snap.exists) return null;
  const parsed = snap.data();
  return (parsed.version === 1 && parsed.characters) ? parsed : null;
}

/* ── Roster select (populates the "Roster:" dropdown in the add-combatant bar) ── */
function populateRosterSelect() {
  const sel = document.getElementById('enc-roster-select');
  sel.innerHTML = '<option value="">— choose —</option>';
  for (const c of CHARACTERS) {
    const opt = document.createElement('option');
    opt.value = c._roster_id;
    opt.textContent = c.name + (c._alias ? ' / '+c._alias : '') + ' (' + c.quirk + ')';
    sel.appendChild(opt);
  }
}

// TEAM_COLORS is defined in board-shared.js (loaded above) — used here for
// the team-dot picker, and by the board engine for token colors.

let encounter = { round: 1, currentIndex: 0, combatants: [], attackLog: [], boardStrokes: [], boardTerrain: [] };
let _encId = 0;
function encId() { return ++_encId; }

const FS_ENCOUNTER_DOC = db.collection('mha-dnd').doc('encounter-state');
let encSaveTimer = null;
// The last encounter state this client knows was on the server (from either
// its own last successful save or the last applied remote snapshot). Diffing
// against this lets fsMergeSave tell "what I changed" apart from "what
// someone else changed" so concurrent edits to different combatants don't
// clobber each other.
let _lastSyncedEncounter = null;
// True from the moment a change is made until the debounced save actually
// lands. The drag/drawing/editing guards below only cover the gesture itself
// (mousedown..mouseup, focus..blur) — without this, a remote snapshot
// arriving during the 600ms debounce window would wholesale-replace
// `encounter` with server data that predates the change, reverting it before
// it's ever saved.
let _encSavePending = false;

function encSave() {
  localStorage.setItem('mha_encounter_v1', JSON.stringify(encounter));
  _encSavePending = true;
  clearTimeout(encSaveTimer);
  encSaveTimer = setTimeout(async () => {
    try {
      // boardStrokes/boardTerrain are merged per-item (like combatants) rather
      // than overwritten whole, so a player nudging a token on their board
      // tab can't clobber terrain/drawings the DM painted a moment earlier
      // with their own (possibly stale) local copy of that field.
      const merged = await fsMergeSave(FS_ENCOUNTER_DOC, encounter, _lastSyncedEncounter, [
        { path: 'combatants', idKey: 'id' },
        { path: 'boardStrokes', idKey: 'id' },
        { path: 'boardTerrain', idKey: 'id' },
      ]);
      _lastSyncedEncounter = merged;
    } catch {} finally {
      _encSavePending = false;
    }
  }, 600);
}
async function encLoad() {
  try {
    await fbAuthReady;
    const snap = await FS_ENCOUNTER_DOC.get();
    if (snap.exists) {
      encounter = snap.data();
      encounter.attackLog = encounter.attackLog || [];
      encounter.boardStrokes = encounter.boardStrokes || [];
      encounter.boardTerrain = encounter.boardTerrain || [];
      _lastSyncedEncounter = fsCloneDoc(encounter); // cloned: a baseline must never alias live state (see auth.js cloneDoc)
      return;
    }
  } catch {}
  try {
    const raw = localStorage.getItem('mha_encounter_v1');
    if (raw) encounter = JSON.parse(raw);
  } catch {}
  encounter.attackLog = encounter.attackLog || [];
  encounter.boardStrokes = encounter.boardStrokes || [];
  encounter.boardTerrain = encounter.boardTerrain || [];
}

// Live feed: push board/encounter updates to every open tab in real time.
let _pendingRemoteEncounter = null;
function isBoardOpen() { return document.getElementById('board-overlay')?.classList.contains('open'); }
function isTurnModalOpen() { return document.getElementById('turn-modal-overlay')?.classList.contains('open'); }
function isEncEditing() {
  const tag = document.activeElement?.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA') return false;
  return !!document.activeElement.closest('#enc-list, #board-overlay, #turn-modal-overlay');
}
// True mid-stroke or mid-terrain-drag. Without this, a remote snapshot that
// lands between mousedown and mouseup would wholesale-replace `encounter`
// (and therefore the in-progress, not-yet-saved boardStrokes/boardTerrain
// edit) with server data from before the gesture started.
function isBoardDrawing() { return !!(boardState.drawingStroke || _boardPainting); }
function applyRemoteEncounter(data) {
  encounter = data;
  encounter.attackLog = encounter.attackLog || [];
  encounter.boardStrokes = encounter.boardStrokes || [];
  encounter.boardTerrain = encounter.boardTerrain || [];
  _lastSyncedEncounter = fsCloneDoc(data); // cloned: a baseline must never alias live state (see auth.js cloneDoc)
  boardBumpArtVersion(); // invalidate the cached terrain/drawing layer — `encounter` was just replaced wholesale
  renderEncounter();
  renderAttackLog();
  if (isBoardOpen()) renderBoard();
  if (isTurnModalOpen()) updateTurnModal();
}
async function startEncLiveSync() {
  await fbAuthReady;
  FS_ENCOUNTER_DOC.onSnapshot(snap => {
    if (!snap.exists) return;
    // A cached snapshot is this tab's own stale copy, not news from the server.
    // When Firestore's streaming channel is blocked (Safari tracking
    // protection, content blockers, proxies) the write transport keeps working
    // while the listener replays cache — so a save commits and is then visibly
    // "undone" by data older than the write. See relationships.html.
    if (snap.metadata?.fromCache) return;
    const data = snap.data();
    // Defer while a local drag/edit/turn-modal-view is in progress — or a
    // change made moments ago is still debouncing/saving — so the remote
    // update doesn't yank the token, input, or displayed combatant mid-gesture
    // or revert an edit before it's had a chance to persist.
    if (boardState.dragging || boardPan || isEncEditing() || isTurnModalOpen() || isBoardDrawing() || _encSavePending) { _pendingRemoteEncounter = data; return; }
    applyRemoteEncounter(data);
  }, err => console.error('[encounter] live sync stopped:', err));
}
setInterval(() => {
  if (_pendingRemoteEncounter && !boardState.dragging && !boardPan && !isEncEditing() && !isTurnModalOpen() && !isBoardDrawing() && !_encSavePending) {
    const data = _pendingRemoteEncounter;
    _pendingRemoteEncounter = null;
    applyRemoteEncounter(data);
  }
}, 800);

function encAddFromRoster() {
  const sel = document.getElementById('enc-roster-select');
  const id = parseInt(sel.value);
  if (!id) return;
  const c = CHARACTERS.find(x => x._roster_id === id);
  if (!c) return;
  const dexMod = (c.modifiers || {}).DEX ?? 0;
  encounter.combatants.push({
    id: encId(), name: c.name, initiative: 0, hp: c.HP || 10, maxHp: c.HP || 10,
    ac: c.AC || 10, conditions: [], notes: '', rosterId: id, isPC: !!c.is_pc,
    quirk: c.quirk, condOpen: false, editingHp: false, dexMod, team: null, tempHp: 0
  });
  sel.value = '';
  encSave(); renderEncounter();
}

function encAddCustom() {
  const name = document.getElementById('enc-custom-name').value.trim();
  const hp = parseInt(document.getElementById('enc-custom-hp').value) || 10;
  const ac = parseInt(document.getElementById('enc-custom-ac').value) || 10;
  if (!name) { document.getElementById('enc-custom-name').focus(); return; }
  encounter.combatants.push({
    id: encId(), name, initiative: 0, hp, maxHp: hp, ac, conditions: [],
    notes: '', rosterId: null, isPC: false, quirk: '', condOpen: false, editingHp: false, dexMod: 0, team: null, tempHp: 0
  });
  document.getElementById('enc-custom-name').value = '';
  document.getElementById('enc-custom-hp').value = '';
  document.getElementById('enc-custom-ac').value = '';
  encSave(); renderEncounter();
}

function encRemove(id) {
  encounter.combatants = encounter.combatants.filter(c => c.id !== id);
  if (encounter.currentIndex >= encounter.combatants.length) encounter.currentIndex = 0;
  encSave(); renderEncounter();
}

function encSetInit(id, val) {
  const c = encounter.combatants.find(x => x.id === id);
  if (c) { c.initiative = parseInt(val) || 0; encSave(); }
}

function encSortByInit() {
  encounter.combatants.sort((a, b) => b.initiative - a.initiative);
  encounter.currentIndex = 0;
  encSave(); renderEncounter();
}

function encRollAllInit() {
  for (const c of encounter.combatants) {
    c.initiative = Math.max(1, Math.min(20, Math.floor(Math.random() * 20) + 1 + c.dexMod));
  }
  encSortByInit();
}

function encNextTurn() {
  if (!encounter.combatants.length) return;
  const prevId = encounter.combatants[encounter.currentIndex]?.id;
  if (prevId != null) encTickConditions(prevId);
  encounter.currentIndex = (encounter.currentIndex + 1) % encounter.combatants.length;
  if (encounter.currentIndex === 0) encounter.round++;
  document.getElementById('enc-round-num').textContent = encounter.round;
  encSave(); renderEncounter();
}

function encPrevTurn() {
  if (!encounter.combatants.length) return;
  if (encounter.currentIndex === 0) {
    if (encounter.round > 1) { encounter.round--; encounter.currentIndex = encounter.combatants.length - 1; }
  } else {
    encounter.currentIndex--;
  }
  document.getElementById('enc-round-num').textContent = encounter.round;
  encSave(); renderEncounter();
}

function encReset() {
  if (!confirm('Reset encounter? This will clear all combatants and round count.')) return;
  encounter = { round: 1, currentIndex: 0, combatants: [], attackLog: [], boardStrokes: encounter.boardStrokes || [], boardTerrain: encounter.boardTerrain || [] };
  encSave(); document.getElementById('enc-round-num').textContent = 1; renderEncounter(); renderAttackLog();
}

function encAdjustHp(id, delta) {
  const c = encounter.combatants.find(x => x.id === id);
  if (!c) return;
  c.hp = Math.max(0, Math.min(c.maxHp, c.hp + delta));
  encSave(); renderEncHpRow(id);
}

function encApplyDmg(id) {
  const inp = document.getElementById('enc-dmg-inp-'+id);
  const val = parseInt(inp?.value);
  if (!isNaN(val) && val > 0) { encAdjustHp(id, -val); if (inp) inp.value = ''; }
}
function encApplyHeal(id) {
  const inp = document.getElementById('enc-heal-inp-'+id);
  const val = parseInt(inp?.value);
  if (!isNaN(val) && val > 0) { encAdjustHp(id, val); if (inp) inp.value = ''; }
}

function encSetHpDirect(id, val) {
  const c = encounter.combatants.find(x => x.id === id);
  if (!c) return;
  const num = parseInt(val);
  if (!isNaN(num)) c.hp = Math.max(0, Math.min(c.maxHp, num));
  c.editingHp = false;
  encSave(); renderEncHpRow(id);
}

function encSetTempHp(id, val) {
  const c = encounter.combatants.find(x => x.id === id);
  if (!c) return;
  const num = parseInt(val);
  c.tempHp = isNaN(num) ? 0 : Math.max(0, num);
  encSave();
  const inp = document.getElementById('enc-thp-' + id);
  if (inp) inp.value = c.tempHp;
  const badge = document.getElementById('tm-thp-badge');
  if (badge && encounter.combatants[encounter.currentIndex]?.id === id) {
    badge.textContent = c.tempHp;
    badge.closest('.tm-stat').style.display = c.tempHp > 0 ? '' : 'none';
  }
}

function encToggleCond(id) {
  const c = encounter.combatants.find(x => x.id === id);
  if (!c) return;
  c.condOpen = !c.condOpen;
  const el = document.getElementById('enc-conds-'+id);
  if (el) el.classList.toggle('open', c.condOpen);
}

function encToggleCondition(id, cond) {
  const c = encounter.combatants.find(x => x.id === id);
  if (!c) return;
  if (!Array.isArray(c.conditions)) c.conditions = [];
  const idx = c.conditions.indexOf(cond);
  if (idx >= 0) c.conditions.splice(idx, 1);
  else c.conditions.push(cond);
  encSave();
  // Re-render just the conditions area
  const pillsEl = document.getElementById('enc-pill-'+id);
  if (pillsEl) pillsEl.innerHTML = renderCondPills(c);
  const condEl = document.getElementById('enc-conds-'+id);
  if (condEl) condEl.innerHTML = renderCondOptions(c);
}

function renderCondPills(c) {
  if (!c.conditions.length) return `<span style="font-size:10px;color:var(--text-dim);">no conditions</span>`;
  const durations = c.condDurations || {};
  return c.conditions.map(cond => {
    const dur = durations[cond];
    const durBadge = dur != null ? `<span style="font-size:9px;opacity:0.75;margin-left:1px;">(${dur})</span>` : '';
    return `<span class="cond-pill" onclick="encToggleCondition(${c.id},'${cond}')">${cond}${durBadge} ×</span>`;
  }).join('');
}

function renderCondOptions(c) {
  const durations = c.condDurations || {};
  return CONDITIONS.map(cond => {
    const active = c.conditions.includes(cond);
    const dur = durations[cond];
    const durPart = active && dur != null
      ? `<span style="font-size:9px;margin-left:3px;opacity:0.7;">${dur}r</span>`
      : '';
    const durBtn = active
      ? `<span class="cond-dur-btn" onclick="event.stopPropagation();encSetCondDuration(${c.id},'${cond}')" title="Set round duration">⏱</span>`
      : '';
    return `<span class="cond-option${active?' active':''}" onclick="encToggleCondition(${c.id},'${cond}')">${cond}${durPart}${durBtn}</span>`;
  }).join('');
}

function encSetCondDuration(id, cond) {
  const c = encounter.combatants.find(x => x.id === id);
  if (!c) return;
  const raw = prompt(`Rounds for ${cond} (blank = permanent):`, (c.condDurations||{})[cond] ?? '');
  if (raw === null) return;
  if (!c.condDurations) c.condDurations = {};
  const n = parseInt(raw);
  if (raw.trim() === '' || isNaN(n) || n <= 0) {
    delete c.condDurations[cond];
  } else {
    c.condDurations[cond] = n;
  }
  encSave();
  const pillsEl = document.getElementById('enc-pill-'+id);
  if (pillsEl) pillsEl.innerHTML = renderCondPills(c);
  const condEl = document.getElementById('enc-conds-'+id);
  if (condEl) condEl.innerHTML = renderCondOptions(c);
}

function encToggleNotes(id) {
  const c = encounter.combatants.find(x => x.id === id);
  if (!c) return;
  c.notesOpen = !c.notesOpen;
  const row = document.getElementById('enc-notes-'+id);
  if (!row) return;
  row.style.display = c.notesOpen || c.notes ? '' : 'none';
  if (c.notesOpen) row.querySelector('input')?.focus();
}
function encSetNotes(id, val) {
  const c = encounter.combatants.find(x => x.id === id);
  if (c) c.notes = val;
}
function encSaveNoteBlur(id) {
  encSave();
}

function encTickConditions(id) {
  const c = encounter.combatants.find(x => x.id === id);
  if (!c || !c.condDurations) return;
  const expired = [];
  for (const cond of Object.keys(c.condDurations)) {
    c.condDurations[cond]--;
    if (c.condDurations[cond] <= 0) { expired.push(cond); delete c.condDurations[cond]; }
  }
  for (const cond of expired) {
    const idx = c.conditions.indexOf(cond);
    if (idx >= 0) c.conditions.splice(idx, 1);
  }
}

function renderEncHpRow(id) {
  const c = encounter.combatants.find(x => x.id === id);
  if (!c) return;
  const el = document.getElementById('enc-hp-'+id);
  if (!el) return;
  const pct = c.maxHp > 0 ? (c.hp / c.maxHp) * 100 : 0;
  const barColor = pct > 50 ? 'var(--green)' : pct > 25 ? 'var(--amber)' : 'var(--red)';
  el.innerHTML = `
    <div class="hp-bar-wrap"><div class="hp-bar" style="width:${pct}%;background:${barColor}"></div></div>
    <div class="hp-controls">
      <input id="enc-dmg-inp-${c.id}" type="number" min="1" placeholder="dmg" style="width:46px;padding:2px 4px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:11px;outline:none;"
        onkeydown="if(event.key==='Enter')encApplyDmg(${c.id})">
      <button class="hp-adj-btn dmg" onclick="encApplyDmg(${c.id})" title="Apply damage" aria-label="Apply damage">−</button>
      <span class="hp-display" onclick="this.style.display='none';document.getElementById('enc-hp-edit-${c.id}').style.display='flex'">
        ${c.hp}/${c.maxHp}
      </span>
      <span id="enc-hp-edit-${c.id}" style="display:none;align-items:center;gap:3px;">
        <input class="hp-current-input" type="number" value="${c.hp}" min="0" max="${c.maxHp}"
          onblur="encSetHpDirect(${c.id},this.value)" onkeydown="if(event.key==='Enter')encSetHpDirect(${c.id},this.value)">
      </span>
      <button class="hp-adj-btn heal" onclick="encApplyHeal(${c.id})" title="Apply healing" aria-label="Apply healing">+</button>
      <input id="enc-heal-inp-${c.id}" type="number" min="1" placeholder="heal" style="width:46px;padding:2px 4px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:11px;outline:none;"
        onkeydown="if(event.key==='Enter')encApplyHeal(${c.id})">
    </div>
    <div class="temp-hp-row">
      <span class="temp-hp-label">Temp HP</span>
      <input class="temp-hp-input" id="enc-thp-${c.id}" type="number" min="0" value="${c.tempHp || 0}"
        onchange="encSetTempHp(${c.id},this.value)" onkeydown="if(event.key==='Enter')encSetTempHp(${c.id},this.value)">
    </div>`;
}

function teamDotHtml(c) {
  if (c.team === null || c.team === undefined) {
    return `<span class="team-dot" onclick="encCycleTeam(${c.id})" title="No team — click to assign" role="button" tabindex="0" aria-label="No team — click to assign"></span>`;
  }
  const t = TEAM_COLORS[c.team];
  return `<span class="team-dot assigned" onclick="encCycleTeam(${c.id})" title="${t.name} team — click to change" style="background:${t.bg}" role="button" tabindex="0" aria-label="${t.name} team — click to change"></span>`;
}

function renderEncounter() {
  document.getElementById('enc-round-num').textContent = encounter.round;
  const list = document.getElementById('enc-list');
  if (!encounter.combatants.length) {
    list.innerHTML = '<div class="enc-empty">No combatants. Add characters from the roster or add custom enemies above.</div>';
    return;
  }
  list.innerHTML = encounter.combatants.map((c, idx) => {
    const isCurrent = idx === encounter.currentIndex;
    const isDead = c.hp === 0;
    const pct = c.maxHp > 0 ? (c.hp / c.maxHp) * 100 : 0;
    const barColor = pct > 50 ? 'var(--green)' : pct > 25 ? 'var(--amber)' : 'var(--red)';
    const typeLabel = c.isPC ? 'PC' : c.quirk || 'NPC';
    const team = (c.team !== null && c.team !== undefined) ? TEAM_COLORS[c.team] : null;
    const borderColor = team ? team.bg : isCurrent ? 'var(--accent)' : 'transparent';
    const rowBg = isCurrent ? (team ? team.light : 'var(--accent-light)') : (team ? team.light : '');
    // Only per-row colour belongs inline. The grid itself lives in CSS —
    // duplicating `display:grid; grid-template-columns:...` here pinned the
    // desktop layout at inline specificity and overrode the mobile
    // breakpoint, so rows never reflowed on narrow screens.
    return `<div class="enc-row${isDead?' is-dead':''}" id="enc-row-${c.id}" style="border-left-color:${borderColor};${rowBg?'background:'+rowBg+';':''}">
      <div class="enc-init">
        <label>Init</label>
        <input type="number" value="${c.initiative}" onchange="encSetInit(${c.id},this.value)">
      </div>
      <div class="enc-name-col">
        <div class="enc-name" style="display:flex;align-items:center;gap:6px;">${teamDotHtml(c)}${escHtml(c.name)}${isCurrent?' ◀':''}</div>
        <div class="enc-name-sub">${escHtml(typeLabel)}${team ? ` · <span style="color:${team.bg};font-weight:600;">${team.name}</span>` : ''}</div>
        <div class="enc-conditions" id="enc-pill-${c.id}">${renderCondPills(c)}</div>
        <div class="cond-selector${c.condOpen?' open':''}" id="enc-conds-${c.id}">${renderCondOptions(c)}</div>
        ${c.notesOpen || c.notes ? `<div class="enc-notes-row" id="enc-notes-${c.id}"><input class="enc-notes-inp" type="text" value="${escHtml(c.notes||'')}" placeholder="Combat note…" oninput="encSetNotes(${c.id},this.value)" onblur="encSaveNoteBlur(${c.id})"></div>` : `<div class="enc-notes-row" id="enc-notes-${c.id}" style="display:none;"><input class="enc-notes-inp" type="text" value="" placeholder="Combat note…" oninput="encSetNotes(${c.id},this.value)"></div>`}
      </div>
      <div class="enc-hp-col" id="enc-hp-${c.id}">
        <div class="hp-bar-wrap"><div class="hp-bar" style="width:${pct}%;background:${barColor}"></div></div>
        <div class="hp-controls">
          <input id="enc-dmg-inp-${c.id}" type="number" min="1" placeholder="dmg" style="width:46px;padding:2px 4px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:11px;outline:none;"
            onkeydown="if(event.key==='Enter')encApplyDmg(${c.id})">
          <button class="hp-adj-btn dmg" onclick="encApplyDmg(${c.id})" title="Apply damage" aria-label="Apply damage">−</button>
          <span class="hp-display" onclick="this.style.display='none';document.getElementById('enc-hp-edit-${c.id}').style.display='flex'">
            ${c.hp}/${c.maxHp}
          </span>
          <span id="enc-hp-edit-${c.id}" style="display:none;align-items:center;gap:3px;">
            <input class="hp-current-input" type="number" value="${c.hp}" min="0" max="${c.maxHp}"
              onblur="encSetHpDirect(${c.id},this.value)" onkeydown="if(event.key==='Enter')encSetHpDirect(${c.id},this.value)">
          </span>
          <button class="hp-adj-btn heal" onclick="encApplyHeal(${c.id})" title="Apply healing" aria-label="Apply healing">+</button>
          <input id="enc-heal-inp-${c.id}" type="number" min="1" placeholder="heal" style="width:46px;padding:2px 4px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:11px;outline:none;"
            onkeydown="if(event.key==='Enter')encApplyHeal(${c.id})">
        </div>
        <div class="temp-hp-row">
          <span class="temp-hp-label">Temp HP</span>
          <input class="temp-hp-input" id="enc-thp-${c.id}" type="number" min="0" value="${c.tempHp || 0}"
            onchange="encSetTempHp(${c.id},this.value)" onkeydown="if(event.key==='Enter')encSetTempHp(${c.id},this.value)">
        </div>
      </div>
      <div class="enc-actions">
        <div style="font-size:11px;font-weight:600;color:var(--text-dim);">AC ${c.ac}</div>
        <button class="icon-btn" onclick="encRandomAttack(${c.id})" title="Random attack against an enemy">⚔</button>
        <button class="icon-btn" onclick="encToggleCond(${c.id})" title="Conditions">⚡</button>
        <button class="icon-btn${c.notes?'  note-active':''}" onclick="encToggleNotes(${c.id})" title="Combat note">📝</button>
        <button class="icon-btn remove" onclick="encRemove(${c.id})" title="Remove" aria-label="Remove">✕</button>
      </div>
    </div>`;
  }).join('');
}

/* ── Teams ────────────────────────────────────────────────── */
function encCycleTeam(id) {
  const c = encounter.combatants.find(x => x.id === id);
  if (!c) return;
  if (c.team === null || c.team === undefined) {
    c.team = 0;
  } else if (c.team >= TEAM_COLORS.length - 1) {
    c.team = null;
  } else {
    c.team++;
  }
  encSave(); renderEncounter();
}

/* ── Random Attack ────────────────────────────────────────── */
function encRandomAttack(attackerId) {
  const attacker = encounter.combatants.find(x => x.id === attackerId);
  if (!attacker) return;

  const targets = encounter.combatants.filter(t => {
    if (t.id === attackerId) return false;
    if (t.hp === 0) return false;
    if (attacker.team !== null && attacker.team !== undefined &&
        t.team !== null && t.team !== undefined &&
        t.team === attacker.team) return false;
    return true;
  });

  if (!targets.length) {
    addAttackLog({ attacker: attacker.name, target: null, roll: null, ac: null });
    return;
  }

  const target = targets[Math.floor(Math.random() * targets.length)];
  const roll = Math.floor(Math.random() * 20) + 1;
  addAttackLog({ attacker: attacker.name, target: target.name, roll, ac: target.ac });
}

function addAttackLog(entry) {
  encounter.attackLog = encounter.attackLog || [];
  encounter.attackLog.unshift(entry);
  if (encounter.attackLog.length > 8) encounter.attackLog.pop();
  encSave();
  renderAttackLog();
}

function renderAttackLog() {
  const el = document.getElementById('enc-log');
  const attackLog = encounter.attackLog || [];
  if (!attackLog.length) {
    el.innerHTML = '<div class="log-none">No attacks yet this encounter.</div>';
    return;
  }
  el.innerHTML = attackLog.map(e => {
    if (!e.target) {
      return `<div class="log-entry"><span class="log-name">${escHtml(e.attacker)}</span> — no valid targets</div>`;
    }
    const hit = e.roll >= e.ac;
    const crit = e.roll === 20;
    const fumble = e.roll === 1;
    const rollClass = crit ? 'log-roll log-crit' : fumble ? 'log-roll log-miss' : hit ? 'log-roll log-hit' : 'log-roll log-miss';
    const label = crit ? '★ CRIT' : fumble ? '☠ FUMBLE' : hit ? 'HIT' : 'MISS';
    const outcome = crit ? 'Critical hit!' : fumble ? 'Fumble!' : hit ? `hits (AC ${e.ac})` : `misses (AC ${e.ac})`;
    return `<div class="log-entry">
      <span class="log-name">${escHtml(e.attacker)}</span>
      <span style="color:var(--text-dim)">→</span>
      <span class="log-name">${escHtml(e.target)}</span>
      <span class="${rollClass}">d20: ${e.roll} — ${label}</span>
      <span style="color:var(--text-dim)">${outcome}</span>
    </div>`;
  }).join('');
}

/* ── Enemy preset ─────────────────────────────────────────── */
function buildEnemySelect() {
  const sel = document.getElementById('enc-enemy-select');
  if (!sel || !ENEMIES.length) return;
  const cats = [...new Set(ENEMIES.map(e => e.category))];
  sel.innerHTML = '<option value="">— choose —</option>';
  for (const cat of cats) {
    const grp = document.createElement('optgroup');
    grp.label = cat;
    for (const e of ENEMIES.filter(x => x.category === cat)) {
      const opt = document.createElement('option');
      opt.value = e.id;
      opt.textContent = `${e.name} (CR ${e.cr}, HP ${e.hp}, AC ${e.ac})`;
      grp.appendChild(opt);
    }
    sel.appendChild(grp);
  }
}

function encAddEnemy() {
  const sel = document.getElementById('enc-enemy-select');
  const qty = Math.max(1, Math.min(10, parseInt(document.getElementById('enc-enemy-qty').value) || 1));
  const id = sel.value;
  if (!id) return;
  const e = ENEMIES.find(x => x.id === id);
  if (!e) return;
  for (let i = 0; i < qty; i++) {
    const suffix = qty > 1 ? ` #${i+1}` : '';
    encounter.combatants.push({
      id: encId(), name: e.name + suffix, initiative: 0,
      hp: e.hp, maxHp: e.hp, ac: e.ac, conditions: [],
      notes: '', rosterId: null, isPC: false,
      quirk: `CR ${e.cr} · ${e.category}`,
      condOpen: false, editingHp: false, dexMod: e.dex_mod || 0, team: null, tempHp: 0
    });
  }
  sel.value = '';
  encSave(); renderEncounter();
}
/* ── Init ──────────────────────────────────────────────── */
(async () => {
  const [rosterRes, enemiesRes] = await Promise.all([
    fetch('roster.json'),
    fetch('../CAMPAIGN/enemies.json'),
  ]);
  const roster = await rosterRes.json();
  try { const ed = await enemiesRes.json(); ENEMIES = ed.enemies || []; } catch {}

  // Try Firestore first (current character sheets, kept live by the Class 1-A
  // toolkit), fall back to bundled JSON files.
  let fsBundle = null;
  try { fsBundle = await loadFromFirestore(); } catch {}

  if (fsBundle) {
    CHARACTERS = (roster.students || []).filter(s => s.file).map(s => {
      const c = Object.assign({}, fsBundle.characters?.[s.file] || {});
      c._file = s.file; c._roster_id = s.id; c._section = 'class-1a';
      c.name = c.name || s.name; c.quirk = c.quirk || s.quirk;
      return c;
    }).filter(c => c.name);
  } else {
    const charResults = await Promise.all(
      (roster.students || []).filter(s => s.file).map(s =>
        fetch(s.file).then(r => r.json()).then(c => { c._file = s.file; c._roster_id = s.id; c._section = 'class-1a'; return c; }).catch(() => null)
      )
    );
    CHARACTERS = charResults.filter(Boolean);
  }

  CHARACTERS.sort((a, b) => {
    const si = SECTION_ORDER.indexOf(a._section) - SECTION_ORDER.indexOf(b._section);
    if (si !== 0) return si;
    if (a._section === 'class-1a') { if (a.is_pc !== b.is_pc) return a.is_pc ? -1 : 1; }
    return a._roster_id - b._roster_id;
  });

  await encLoad();
  renderAttackLog();
  startEncLiveSync();
  populateRosterSelect();
  buildEnemySelect();
  renderEncounter();
})();

/* ── Turn Modal ───────────────────────────────────────── */
let modalAttackResult = null;
let tmSelectedDie = null;

let turnModalLastFocusedEl = null;
function openTurnModal() {
  if (!encounter.combatants.length) return;
  modalAttackResult = null;
  tmSelectedDie = null;
  turnModalLastFocusedEl = document.activeElement;
  document.getElementById('turn-modal-overlay').classList.add('open');
  updateTurnModal();
  document.getElementById('turn-modal').focus({ preventScroll: true });
}

function closeTurnModal() {
  document.getElementById('turn-modal-overlay').classList.remove('open');
  modalAttackResult = null;
  if (turnModalLastFocusedEl && typeof turnModalLastFocusedEl.focus === 'function') turnModalLastFocusedEl.focus();
  turnModalLastFocusedEl = null;
}

function modalNextTurn() {
  encNextTurn();
  modalAttackResult = null;
  tmSelectedDie = null;
  tmDiceQty = 1;
  document.querySelectorAll('.tm-die').forEach(b => b.classList.remove('selected'));
  document.getElementById('tm-qr-btn').disabled = true;
  document.getElementById('tm-quick-result').textContent = '—';
  document.getElementById('tm-quick-result').className = '';
  document.getElementById('tm-qr-qty').textContent = '1';
  document.getElementById('tm-hp-inp').value = '';
  document.getElementById('tm-hp-feedback').textContent = '';
  tmResetActions();
  // Skip dead combatants if checkbox is on
  if (document.getElementById('tm-skip-dead-chk').checked) {
    let safety = encounter.combatants.length;
    while (safety-- > 0 && encounter.combatants.length) {
      const c = encounter.combatants[encounter.currentIndex];
      if (c && c.hp > 0) break;
      encNextTurn();
    }
  }
  updateTurnModal();
}

function updateTurnModal() {
  const combatants = encounter.combatants;
  if (!combatants.length) { closeTurnModal(); return; }

  const c = combatants[encounter.currentIndex];
  const total = combatants.length;
  const turnNum = encounter.currentIndex + 1;
  const isDead = c.hp === 0;
  const team = (c.team !== null && c.team !== undefined) ? TEAM_COLORS[c.team] : null;
  const pct = c.maxHp > 0 ? (c.hp / c.maxHp) * 100 : 0;
  const barColor = pct > 50 ? 'var(--green)' : pct > 25 ? 'var(--amber)' : 'var(--red)';

  // Header
  document.getElementById('turn-modal-round').textContent =
    `Round ${encounter.round} · Turn ${turnNum} of ${total}`;

  // Avatar
  const avatarEl = document.getElementById('tm-avatar');
  const avatarColor = team ? team.bg : 'var(--accent)';
  const avatarBg = team ? team.light : 'var(--accent-light)';
  avatarEl.style.cssText = `background:${avatarBg};color:${avatarColor};`;
  avatarEl.textContent = c.name.split(' ').slice(0,2).map(w=>w[0]).join('').toUpperCase();

  // Name + sub
  document.getElementById('tm-name').textContent = c.name;
  const typeLabel = c.isPC ? 'PC' : c.quirk || 'NPC';
  const teamLabel = team ? ` · ${team.name} team` : '';
  document.getElementById('tm-sub').innerHTML =
    `${escHtml(typeLabel)}${teamLabel ? `<span style="color:${team.bg};font-weight:600;">${escHtml(teamLabel)}</span>` : ''}`;

  // HP bar
  document.getElementById('tm-hp-bar').style.cssText = `width:${pct}%;background:${barColor};`;

  // Stats chips
  document.getElementById('tm-stats').innerHTML = `
    <div class="tm-stat">
      <div class="tm-stat-label">HP</div>
      <div class="tm-stat-val" style="color:${barColor}">${c.hp}<span style="font-size:11px;font-weight:400;color:var(--text-dim)">/${c.maxHp}</span></div>
    </div>
    <div class="tm-stat">
      <div class="tm-stat-label">AC</div>
      <div class="tm-stat-val">${c.ac}</div>
    </div>
    <div class="tm-stat">
      <div class="tm-stat-label">Init</div>
      <div class="tm-stat-val">${c.initiative}</div>
    </div>
    ${c.dexMod !== undefined ? `<div class="tm-stat">
      <div class="tm-stat-label">Dex Mod</div>
      <div class="tm-stat-val">${c.dexMod >= 0 ? '+' : ''}${c.dexMod}</div>
    </div>` : ''}
    <div class="tm-stat" style="${(c.tempHp || 0) === 0 ? 'display:none' : ''}">
      <div class="tm-stat-label" style="color:var(--teal-text)">Temp HP</div>
      <div class="tm-stat-val" id="tm-thp-badge" style="color:var(--teal)">${c.tempHp || 0}</div>
    </div>
  `;

  // Conditions
  const condEl = document.getElementById('tm-conditions');
  condEl.innerHTML = (c.conditions && c.conditions.length)
    ? c.conditions.map(cond => `<span class="cond-pill" style="cursor:default">${escHtml(cond)}</span>`).join('')
    : `<span style="font-size:11px;color:var(--text-dim);">No conditions</span>`;

  // Dead badge
  document.getElementById('tm-dead-badge').style.display = isDead ? 'inline-block' : 'none';

  // Attack zone
  document.getElementById('tm-roll-btn').disabled = isDead;
  document.getElementById('tm-roll-btn').style.opacity = isDead ? '0.4' : '1';

  // Target selector — show for PCs so they can pick manually
  const targetRow = document.getElementById('tm-target-select-row');
  const targetSel = document.getElementById('tm-target-select');
  if (c.isPC) {
    const validTargets = combatants.filter(t => {
      if (t.id === c.id) return false;
      if (t.hp === 0) return false;
      if (c.team !== null && c.team !== undefined &&
          t.team !== null && t.team !== undefined &&
          t.team === c.team) return false;
      return true;
    });
    targetSel.innerHTML = '<option value="">— random target —</option>' +
      validTargets.map(t => `<option value="${t.id}">${escHtml(t.name)} (HP ${t.hp}/${t.maxHp} · AC ${t.ac})</option>`).join('');
    targetRow.style.display = validTargets.length ? 'block' : 'none';
  } else {
    targetRow.style.display = 'none';
    targetSel.value = '';
  }

  renderModalAttackResult();
  renderTmActionChips();
  renderDeathSaves(c);

  // Next button label: last combatant wraps to next round
  const isLast = encounter.currentIndex === combatants.length - 1;
  document.getElementById('tm-next-btn').textContent = isLast ? 'End Turn · Next Round →' : 'End Turn →';
}

function modalRollAttack() {
  const c = encounter.combatants[encounter.currentIndex];
  if (!c || c.hp === 0) return;

  const targets = encounter.combatants.filter(t => {
    if (t.id === c.id) return false;
    if (t.hp === 0) return false;
    if (c.team !== null && c.team !== undefined &&
        t.team !== null && t.team !== undefined &&
        t.team === c.team) return false;
    return true;
  });

  if (!targets.length) {
    modalAttackResult = { attacker: c.name, target: null, roll: null, ac: null };
  } else {
    const selectedId = c.isPC ? document.getElementById('tm-target-select').value : '';
    const target = selectedId
      ? targets.find(t => t.id === selectedId) || targets[Math.floor(Math.random() * targets.length)]
      : targets[Math.floor(Math.random() * targets.length)];
    const roll = Math.floor(Math.random() * 20) + 1;
    modalAttackResult = { attacker: c.name, target: target.name, targetId: target.id, roll, ac: target.ac };
    addAttackLog(modalAttackResult);
  }
  renderModalAttackResult();
}

function renderModalAttackResult() {
  const el = document.getElementById('tm-roll-result');
  if (!modalAttackResult) { el.innerHTML = ''; return; }
  const e = modalAttackResult;
  if (!e.target) {
    el.innerHTML = `<div class="tm-result-row" style="color:var(--text-dim);font-size:12px;">No valid targets</div>`;
    return;
  }
  const hit = e.roll >= e.ac;
  const crit = e.roll === 20;
  const fumble = e.roll === 1;
  const rollClass = crit ? 'log-roll log-crit' : fumble ? 'log-roll log-miss' : hit ? 'log-roll log-hit' : 'log-roll log-miss';
  const label = crit ? '★ CRIT' : fumble ? '☠ FUMBLE' : hit ? 'HIT' : 'MISS';
  el.innerHTML = `<div class="tm-result-row" style="margin-top:4px;">
    <span class="tm-result-arrow">→</span>
    <span class="tm-result-target">${escHtml(e.target)}</span>
    <span class="${rollClass}">d20: ${e.roll} — ${label}</span>
    <span style="font-size:11px;color:var(--text-dim);">${crit?'Critical hit!':fumble?'Fumble!':hit?`hits (AC ${e.ac})`:`misses (AC ${e.ac})`}</span>
  </div>
  <div class="tm-target-hp-row" style="margin-top:6px;display:flex;align-items:center;gap:5px;flex-wrap:wrap;">
    <span style="font-size:10px;font-weight:700;color:var(--text-dim);letter-spacing:0.07em;text-transform:uppercase;">Apply to ${escHtml(e.target)}:</span>
    <input class="tm-hp-inp" id="tm-target-hp-inp" type="number" min="1" placeholder="amt" title="Amount" style="width:54px;">
    <button class="tm-dmg-btn dmg" onclick="tmApplyHpToTarget('dmg')" title="Deal damage to target">− Dmg</button>
    <button class="tm-dmg-btn heal" onclick="tmApplyHpToTarget('heal')" title="Heal target">+ Heal</button>
    <span id="tm-target-hp-feedback" style="font-size:11px;color:var(--text-dim);margin-left:2px;"></span>
  </div>`;
}

/* ── Quick Roll ───────────────────────────────────────── */
let tmDiceQty = 1;

function tmAdjQty(delta) {
  tmDiceQty = Math.max(1, Math.min(20, tmDiceQty + delta));
  document.getElementById('tm-qr-qty').textContent = tmDiceQty;
}

function tmSelectDie(sides, btn) {
  tmSelectedDie = sides;
  document.querySelectorAll('.tm-die').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  document.getElementById('tm-qr-btn').disabled = false;
}

function tmQuickRoll() {
  if (!tmSelectedDie) return;
  const qty = tmDiceQty;
  const mod = parseInt(document.getElementById('tm-qr-mod').value) || 0;
  const rolls = Array.from({ length: qty }, () => Math.floor(Math.random() * tmSelectedDie) + 1);
  const sum = rolls.reduce((a, b) => a + b, 0);
  const total = sum + mod;
  const isCrit = tmSelectedDie === 20 && qty === 1 && rolls[0] === 20;
  const isFumble = tmSelectedDie === 20 && qty === 1 && rolls[0] === 1;
  const modStr = mod > 0 ? `+${mod}` : mod < 0 ? `${mod}` : '';
  const breakdown = qty > 1 ? `[${rolls.join('+')}]${modStr}` : `${rolls[0]}${modStr}`;
  const el = document.getElementById('tm-quick-result');
  el.className = isCrit ? 'tm-quick-crit' : isFumble ? 'tm-quick-fumble' : '';
  const label = isCrit ? ' ★ CRIT' : isFumble ? ' ☠ FUMBLE' : '';
  el.textContent = `${total} (${breakdown})${label}`;
}

/* ── HP Editor (modal) ────────────────────────────────── */
function tmApplyHp(mode) {
  const c = encounter.combatants[encounter.currentIndex];
  if (!c) return;
  const val = parseInt(document.getElementById('tm-hp-inp').value);
  if (!val || val <= 0) { document.getElementById('tm-hp-feedback').textContent = 'Enter an amount'; return; }

  const before = c.hp;
  if (mode === 'dmg') {
    c.hp = Math.max(0, c.hp - val);
  } else {
    c.hp = Math.min(c.maxHp, c.hp + val);
  }
  const delta = c.hp - before;
  encSave();
  renderEncHpRow(c.id);

  // Update modal HP bar + stat chip live
  const pct = c.maxHp > 0 ? (c.hp / c.maxHp) * 100 : 0;
  const barColor = pct > 50 ? 'var(--green)' : pct > 25 ? 'var(--amber)' : 'var(--red)';
  document.getElementById('tm-hp-bar').style.cssText = `width:${pct}%;background:${barColor};`;
  document.getElementById('tm-stats').querySelector('.tm-stat-val').innerHTML =
    `<span style="color:${barColor}">${c.hp}</span><span style="font-size:11px;font-weight:400;color:var(--text-dim)">/${c.maxHp}</span>`;

  // Feedback
  const fb = document.getElementById('tm-hp-feedback');
  fb.style.color = delta < 0 ? 'var(--red-text)' : 'var(--green-text)';
  fb.textContent = delta < 0 ? `−${Math.abs(delta)} → ${c.hp} HP` : delta > 0 ? `+${delta} → ${c.hp} HP` : 'No change';
  document.getElementById('tm-hp-inp').value = '';

  if (c.hp === 0) document.getElementById('tm-dead-badge').style.display = 'inline-block';
}

function tmApplyHpToTarget(mode) {
  if (!modalAttackResult?.targetId) return;
  const t = encounter.combatants.find(x => x.id === modalAttackResult.targetId);
  if (!t) return;
  const inp = document.getElementById('tm-target-hp-inp');
  const val = parseInt(inp?.value);
  const fb = document.getElementById('tm-target-hp-feedback');
  if (!val || val <= 0) { if (fb) fb.textContent = 'Enter an amount'; return; }

  const before = t.hp;
  if (mode === 'dmg') {
    t.hp = Math.max(0, t.hp - val);
  } else {
    t.hp = Math.min(t.maxHp, t.hp + val);
  }
  const delta = t.hp - before;
  encSave();
  renderEncHpRow(t.id);

  if (fb) {
    fb.style.color = delta < 0 ? 'var(--red-text)' : 'var(--green-text)';
    fb.textContent = delta < 0 ? `−${Math.abs(delta)} → ${t.hp} HP` : delta > 0 ? `+${delta} → ${t.hp} HP` : 'No change';
  }
  if (inp) inp.value = '';
}

/* ── Action Economy (C1) ──────────────────────────────── */
const TM_ACTIONS = [
  { key: 'action',   label: 'Action',       color: 'var(--accent)' },
  { key: 'bonus',    label: 'Bonus Action', color: 'var(--teal)'   },
  { key: 'reaction', label: 'Reaction',     color: 'var(--amber)'  },
  { key: 'movement', label: 'Movement',     color: 'var(--green)'  },
];
let tmActionState = { action: false, bonus: false, reaction: false, movement: false };

function tmResetActions() {
  tmActionState = { action: false, bonus: false, reaction: false, movement: false };
  renderTmActionChips();
}

function tmToggleAction(key) {
  tmActionState[key] = !tmActionState[key];
  renderTmActionChips();
}

function renderTmActionChips() {
  const el = document.getElementById('tm-action-chips');
  if (!el) return;
  el.innerHTML = TM_ACTIONS.map(a => {
    const used = tmActionState[a.key];
    return `<button class="tm-action-chip${used?' used':''}" style="--chip-color:${a.color}" onclick="tmToggleAction('${a.key}')" title="${used?'Used — click to undo':'Click to mark used'}">${used?'<s>'+a.label+'</s>':a.label}</button>`;
  }).join('');
}

/* ── Death Saves (C2) ─────────────────────────────────── */
function renderDeathSaves(c) {
  const zone = document.getElementById('tm-death-zone');
  if (!zone) return;
  const isDead = c.hp === 0;
  zone.style.display = isDead ? '' : 'none';
  if (!isDead) return;
  if (!c.deathSuccesses) c.deathSuccesses = 0;
  if (!c.deathFails) c.deathFails = 0;
  const bubble = (filled, color) => `<span style="width:18px;height:18px;border-radius:50%;display:inline-block;border:2px solid ${color};background:${filled?color:'transparent'};"></span>`;
  document.getElementById('tm-ds-success').innerHTML = [0,1,2].map(i => bubble(i < c.deathSuccesses, 'var(--green)')).join('');
  document.getElementById('tm-ds-fail').innerHTML    = [0,1,2].map(i => bubble(i < c.deathFails,    'var(--red)')).join('');
}

function tmRollDeathSave() {
  const c = encounter.combatants[encounter.currentIndex];
  if (!c || c.hp > 0) return;
  if (!c.deathSuccesses) c.deathSuccesses = 0;
  if (!c.deathFails) c.deathFails = 0;
  const roll = Math.floor(Math.random() * 20) + 1;
  const res = document.getElementById('tm-ds-result');
  if (roll === 20) {
    c.hp = 1; c.deathSuccesses = 0; c.deathFails = 0;
    encSave(); renderEncHpRow(c.id); updateTurnModal();
    if (res) res.innerHTML = `<span style="color:var(--green-text)">★ Natural 20 — ${c.name} stabilises at 1 HP!</span>`;
    return;
  } else if (roll === 1) {
    c.deathFails = Math.min(3, c.deathFails + 2);
    if (res) res.innerHTML = `<span style="color:var(--red-text)">☠ Natural 1 — two failures!</span>`;
  } else if (roll >= 10) {
    c.deathSuccesses = Math.min(3, c.deathSuccesses + 1);
    if (res) res.innerHTML = `<span style="color:var(--green-text)">✓ ${roll} — success (${c.deathSuccesses}/3)</span>`;
  } else {
    c.deathFails = Math.min(3, c.deathFails + 1);
    if (res) res.innerHTML = `<span style="color:var(--red-text)">✗ ${roll} — failure (${c.deathFails}/3)</span>`;
  }
  if (c.deathSuccesses >= 3) {
    c.deathSuccesses = 0; c.deathFails = 0;
    if (res) res.innerHTML = `<span style="color:var(--green-text)">✓✓✓ ${c.name} is stable!</span>`;
  } else if (c.deathFails >= 3) {
    c.deathFails = 0; c.deathSuccesses = 0;
    if (res) res.innerHTML = `<span style="color:var(--red-text)">☠☠☠ ${c.name} is dead.</span>`;
  }
  encSave();
  renderDeathSaves(c);
}

/* ── Board Mode ───────────────────────────────────────── */
// The grid/tokens/drag/draw/touch engine (constants, rendering, event
// wiring) lives in board-shared.js, loaded above — shared with the player
// Battle Board (CLASS-1A/board.html) instead of hand-kept-in-sync copies.
// Only these two functions are specific to this page's modal chrome.

let boardModalLastFocusedEl = null;
function openBoardMode() {
  boardModalLastFocusedEl = document.activeElement;
  document.getElementById('board-overlay').classList.add('open');
  requestAnimationFrame(() => { boardFitZoom(); renderBoard(); });
  document.getElementById('board-modal').focus({ preventScroll: true });
}
function closeBoardMode() {
  document.getElementById('board-overlay').classList.remove('open');
  boardState = { pendingId: null, selectedIds: [], rangeFt: 0, dragging: null, _wasDragging: false, tool: 'move', penColor: boardState.penColor, drawingStroke: null };
  boardHoverInfo = null;
  document.querySelectorAll('.board-tool-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === 'move'));
  const inp = document.getElementById('board-range-input');
  if (inp) inp.value = '';
  if (boardModalLastFocusedEl && typeof boardModalLastFocusedEl.focus === 'function') boardModalLastFocusedEl.focus();
  boardModalLastFocusedEl = null;
}

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role="button"][tabindex]')) {
      e.preventDefault();
      e.target.click();
    }
    return;
  }
  if (document.getElementById('board-overlay').classList.contains('open')) closeBoardMode();
  else if (document.getElementById('turn-modal-overlay').classList.contains('open')) closeTurnModal();
});
