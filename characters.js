// Page logic for characters.html. Extracted from the HTML so it can be linted,
// diffed and tested directly rather than regex-scraped out of markup.
// Loaded as a CLASSIC script, not a module: the page wires controls with
// inline onclick= handlers that resolve against globals, and top-level
// declarations here become globals exactly as they did inline. type="module"
// would scope them and silently break every handler.

// Runs after auth.js, so fbAuthReady/fsMergeSave are already defined.
const db = firebase.firestore();

let allChars = [];
let allFolders = [];
let currentFolderId = null;
let isAdminUI = false;
let activeTypes = new Set();
let activeGenders = new Set();
let activePc = new Set();
let activeTags = new Set();

function escHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

const FS_CHARACTERS = db.collection('characters');
const FS_FOLDERS_DOC = db.collection('mha-dnd').doc('character-folders');

const FOLDER_COLORS = [
  ['#E8A020', 'Gold',   '#F5C842', 'rgba(232,160,32,0.15)'],
  ['#0EA572', 'Teal',   '#5FDBAA', 'rgba(14,165,114,0.15)'],
  ['#EF4444', 'Red',    '#FCA5A5', 'rgba(239,68,68,0.15)'],
  ['#8B47D4', 'Purple', '#C09CEB', 'rgba(139,71,212,0.15)'],
  ['#3B82F6', 'Blue',   '#93C5FD', 'rgba(59,130,246,0.15)'],
  ['#EC4899', 'Pink',   '#F9A8D4', 'rgba(236,72,153,0.15)'],
  ['#F97316', 'Orange', '#FDBA74', 'rgba(249,115,22,0.15)'],
  ['#8A9BB0', 'Gray',   '#C3CEDA', 'rgba(138,155,176,0.15)'],
];
function folderColorInfo(hex) {
  const found = FOLDER_COLORS.find(c => c[0] === hex);
  return found ? { accent: found[0], text: found[2], light: found[3] } : { accent: hex || '#8A9BB0', text: hex || '#8A9BB0', light: 'rgba(138,155,176,0.15)' };
}

function isCustom(c) { return c._type === 'Custom'; }
function charKey(c) { return isCustom(c) ? c._id : c._staticId; }

async function loadCharacterDocs() {
  try {
    await fbAuthReady;
    const snap = await FS_CHARACTERS.get();
    const fields = {}, deletedIds = new Set(), customChars = [];
    snap.forEach(doc => {
      const data = doc.data();
      if (data._type === 'Custom') {
        customChars.push(Object.assign({}, data, { _id: doc.id }));
      } else {
        if (data.deleted) deletedIds.add(doc.id);
        if (data.fields) fields[doc.id] = data.fields;
      }
    });
    return { fields, deletedIds, customChars };
  } catch {
    document.getElementById('load-error-banner').style.display = '';
    return { fields: {}, deletedIds: new Set(), customChars: [] };
  }
}

async function loadStaticCharacters() {
  // Fire every top-level fetch at once; only the per-student CLASS-1A files
  // genuinely depend on roster.json resolving first.
  const rosterPromise = fetch('CLASS-1A/roster.json').then(r => r.json()).catch(() => null);
  const class1bPromise = fetch('CAMPAIGN/class1b.json').then(r => r.json()).catch(() => null);
  const teachersPromise = fetch('CAMPAIGN/teachers.json').then(r => r.json()).catch(() => null);
  const villainsPromise = fetch('CAMPAIGN/villains.json').then(r => r.json()).catch(() => null);
  const npcsPromise = fetch('CAMPAIGN/npcs.json').then(r => r.json()).catch(() => null);

  const out = [];

  const roster = await rosterPromise;
  if (roster) {
    const students = (roster.students || []).filter(s => s.file);
    const class1aFiles = await Promise.all(students.map(s =>
      fetch('CLASS-1A/' + s.file).then(r => r.json()).catch(() => null)
    ));
    for (const char of class1aFiles) {
      if (char) { char._type = 'Student (1-A)'; out.push(char); }
    }
  }

  const class1b = await class1bPromise;
  if (class1b) {
    for (const student of (class1b.students || [])) {
      out.push(Object.assign({}, student, { _type: 'Student (1-B)', is_pc: false }));
    }
  }

  const teachersData = await teachersPromise;
  if (teachersData) {
    for (const teacher of (teachersData.teachers || [])) {
      out.push(Object.assign({}, teacher, { _type: 'Teacher', is_pc: false }));
    }
  }

  const villainsData = await villainsPromise;
  if (villainsData) {
    const seen = new Set();
    for (const faction of (villainsData.factions || [])) {
      for (const villain of (faction.villains || [])) {
        if (seen.has(villain.name)) continue;
        seen.add(villain.name);
        out.push(Object.assign({}, villain, { _type: 'Villain', is_pc: false, _faction: faction.name }));
      }
    }
  }

  const npcsData = await npcsPromise;
  if (npcsData) {
    for (const npc of (npcsData.characters || [])) {
      out.push(Object.assign({}, npc, { _type: 'Supporting', is_pc: false, role: npc.role || npc.category }));
    }
  }

  for (const c of out) c._staticId = c._type + '::' + c.name;
  return out;
}

let canEditAnyUI = false;
let initialLoadDone = false;

document.addEventListener('auth-state-changed', (e) => {
  const isAdmin = e.detail.role === 'admin';
  document.getElementById('new-char-btn').style.display = isAdmin ? '' : 'none';
  document.getElementById('new-folder-btn').style.display = isAdmin ? '' : 'none';
  isAdminUI = isAdmin;
  canEditAnyUI = e.detail.role === 'admin' || e.detail.role === 'editor';
  if (initialLoadDone) renderGrid();
});

async function loadFolders() {
  try {
    await fbAuthReady;
    const snap = await FS_FOLDERS_DOC.get();
    const data = snap.exists ? (snap.data().folders || {}) : {};
    return Object.keys(data).map(id => Object.assign({ id }, data[id])).sort((a, b) => (a.name||'').localeCompare(b.name||''));
  } catch {
    return [];
  }
}

async function init() {
  try {
    const [staticChars, { fields, deletedIds, customChars }, folders] = await Promise.all([loadStaticCharacters(), loadCharacterDocs(), loadFolders()]);
    const merged = staticChars
      .filter(c => !deletedIds.has(c._staticId))
      .map(c => fields[c._staticId] ? Object.assign({}, c, fields[c._staticId]) : c);
    allChars = merged.concat(customChars);
    allFolders = folders;
  } catch (e) {
    allChars = [];
    allFolders = [];
  }
  if (currentFolderId && !allFolders.some(f => f.id === currentFolderId)) currentFolderId = null;
  buildFilterOptions();
  initialLoadDone = true;
  renderGrid();
}

function buildFilterOptions() {
  const types = [...new Set(allChars.map(c => c._type).filter(Boolean))];
  document.getElementById('type-filters').innerHTML = types.map(t =>
    `<div class="filter-opt" data-type="${escHtml(t)}" role="button" tabindex="0" onclick="toggleTypeFilter(this)">${escHtml(t)}</div>`
  ).join('');

  const genders = [...new Set(allChars.map(c => c.gender).filter(Boolean))];
  document.getElementById('gender-filters').innerHTML = genders.map(g =>
    `<div class="filter-opt" data-gender="${escHtml(g)}" role="button" tabindex="0" onclick="toggleGenderFilter(this)">${escHtml(g)}</div>`
  ).join('');

  const tags = [...new Set(allChars.flatMap(c => c.tags || []))].sort();
  document.getElementById('tag-filters').innerHTML = tags.length
    ? tags.map(t => `<div class="filter-opt" data-tag="${escHtml(t)}" role="button" tabindex="0" onclick="toggleTagFilter(this)">${escHtml(t)}</div>`).join('')
    : `<span style="font-size:11px;color:var(--text-dim);">No tags yet</span>`;
}

function toggleFilterPanel() {
  document.getElementById('filter-panel').classList.toggle('open');
  document.getElementById('filter-toggle').classList.toggle('active');
}
function toggleTypeFilter(el) {
  const t = el.dataset.type;
  el.classList.toggle('active');
  activeTypes.has(t) ? activeTypes.delete(t) : activeTypes.add(t);
  renderGrid();
}
function toggleGenderFilter(el) {
  const g = el.dataset.gender;
  el.classList.toggle('active');
  activeGenders.has(g) ? activeGenders.delete(g) : activeGenders.add(g);
  renderGrid();
}
function toggleTagFilter(el) {
  const t = el.dataset.tag;
  el.classList.toggle('active');
  activeTags.has(t) ? activeTags.delete(t) : activeTags.add(t);
  renderGrid();
}
function togglePcFilter(el) {
  const p = el.dataset.pc;
  el.classList.toggle('active');
  activePc.has(p) ? activePc.delete(p) : activePc.add(p);
  renderGrid();
}

function badgeClass(type) {
  if (type === 'Student (1-A)') return 'student-1a';
  if (type === 'Student (1-B)') return 'student-1b';
  if (type === 'Teacher') return 'teacher';
  if (type === 'Villain') return 'villain';
  if (type === 'Supporting') return 'supporting';
  if (type === 'Custom') return 'custom';
  return '';
}

function passesFilters(c) {
  if (activeTypes.size && !activeTypes.has(c._type)) return false;
  if (activeGenders.size && !activeGenders.has(c.gender)) return false;
  if (activePc.size && !activePc.has(String(!!c.is_pc))) return false;
  if (activeTags.size && !(c.tags||[]).some(t => activeTags.has(t))) return false;
  return true;
}

function charCardHtml(c, showFolderBadge) {
  const idx = allChars.indexOf(c);
  const folder = showFolderBadge && c.folderId ? allFolders.find(f => f.id === c.folderId) : null;
  const fc = folder ? folderColorInfo(folder.color) : null;
  return `<div class="char-card" onclick="showDetail(${idx})" role="button" tabindex="0" aria-label="View ${escHtml(c.name)} details">
    <div class="char-card-top">
      <div>
        <div class="char-name">${escHtml(c.name)}</div>
        <div class="char-quirk">${escHtml(c.quirk||'')}</div>
      </div>
      <span class="badge ${badgeClass(c._type)}">${escHtml(c._type||'')}</span>
    </div>
    <div class="char-meta">
      ${c.gender ? `<span>${escHtml(c.gender)}</span>` : ''}
      ${c.is_pc ? `<span class="badge pc">PC</span>` : ''}
      ${c.role ? `<span>${escHtml(c.role)}</span>` : ''}
      ${folder ? `<span class="folder-badge" style="background:${fc.light};color:${fc.text};">🗂 ${escHtml(folder.name)}</span>` : ''}
    </div>
    ${(c.tags||[]).length ? `<div class="char-meta">${c.tags.map(t => `<span class="tag-chip">${escHtml(t)}</span>`).join('')}</div>` : ''}
  </div>`;
}

function folderTileHtml(f) {
  const count = allChars.filter(c => c.folderId === f.id).length;
  const fc = folderColorInfo(f.color);
  return `<div class="folder-tile" style="--folder-accent:${fc.accent};" onclick="openFolder('${f.id}')" role="button" tabindex="0" aria-label="Open folder ${escHtml(f.name)}">
    ${isAdminUI ? `<div class="folder-tile-actions">
      <span role="button" tabindex="0" title="Edit folder" aria-label="Edit folder ${escHtml(f.name)}" onclick="event.stopPropagation(); openEditFolderModal('${f.id}')">✎</span>
      <span role="button" tabindex="0" title="Delete folder" aria-label="Delete folder ${escHtml(f.name)}" onclick="event.stopPropagation(); deleteFolder('${f.id}')">✕</span>
    </div>` : ''}
    <div class="folder-tile-icon">🗂</div>
    <div class="folder-tile-name">${escHtml(f.name)}</div>
    <div class="folder-tile-count">${count} character${count === 1 ? '' : 's'}</div>
  </div>`;
}

function emptyStateHtml(icon, text) {
  return `<div id="empty-state"><div class="es-icon">${icon}</div>${text}</div>`;
}

function renderGrid() {
  const qRaw = document.getElementById('search-input').value.trim();
  const q = qRaw.toLowerCase();
  const grid = document.getElementById('grid');
  renderBreadcrumb(qRaw);

  const matchesQuery = c => !q || (c.name||'').toLowerCase().includes(q) || (c.quirk||'').toLowerCase().includes(q);

  if (q) {
    const matchedFolders = allFolders.filter(f => (f.name||'').toLowerCase().includes(q));
    const matchedChars = allChars.filter(c => matchesQuery(c) && passesFilters(c));
    if (!matchedFolders.length && !matchedChars.length) {
      grid.innerHTML = emptyStateHtml('🔍', 'No folders or characters match your search/filters.');
      return;
    }
    grid.innerHTML = matchedFolders.map(folderTileHtml).join('') + matchedChars.map(c => charCardHtml(c, true)).join('');
    return;
  }

  if (currentFolderId === null) {
    const unfiled = allChars.filter(c => !c.folderId && passesFilters(c));
    if (!allFolders.length && !unfiled.length) {
      grid.innerHTML = emptyStateHtml('🗂', 'No characters match your search/filters.');
      return;
    }
    let html = allFolders.map(folderTileHtml).join('');
    if (allFolders.length && unfiled.length) html += `<div class="grid-section-label">Unfiled Characters</div>`;
    html += unfiled.map(c => charCardHtml(c)).join('');
    grid.innerHTML = html;
    return;
  }

  const members = allChars.filter(c => c.folderId === currentFolderId && passesFilters(c));
  if (!members.length) {
    grid.innerHTML = emptyStateHtml('🗂', 'No characters in this folder yet.');
    return;
  }
  grid.innerHTML = members.map(c => charCardHtml(c)).join('');
}

function renderBreadcrumb(qRaw) {
  const el = document.getElementById('breadcrumb');
  if (qRaw || currentFolderId === null) {
    el.classList.remove('open');
    el.innerHTML = '';
    return;
  }
  const folder = allFolders.find(f => f.id === currentFolderId);
  if (!folder) {
    currentFolderId = null;
    el.classList.remove('open');
    el.innerHTML = '';
    return;
  }
  const fc = folderColorInfo(folder.color);
  el.classList.add('open');
  el.innerHTML = `
    <span class="breadcrumb-link" role="button" tabindex="0" onclick="openFolder(null)">← All Folders</span>
    <span class="breadcrumb-sep">/</span>
    <span class="breadcrumb-current" style="color:${fc.text};">🗂 ${escHtml(folder.name)}</span>
    <span class="breadcrumb-spacer"></span>
    ${canEditAnyUI ? `<button class="action-btn" onclick="openAddToFolderModal()">+ Add Existing Character</button>` : ''}
    ${isAdminUI ? `<button class="action-btn" onclick="openEditFolderModal('${folder.id}')">Rename / Recolor</button>` : ''}
  `;
}

function openFolder(id) {
  currentFolderId = id;
  document.getElementById('search-input').value = '';
  renderGrid();
}

function quirkMechanicsHtml(mech) {
  if (!mech) return '';
  const abilities = (mech.abilities || []).map(a => {
    // Optional structured fields, shown as a chip row above the prose. An
    // ability carrying only a description renders exactly as it always did.
    const chips = [];
    if (a.range)  chips.push(escHtml(a.range));
    if (a.damage) chips.push(escHtml(a.damage) + (a.damageType ? ' ' + escHtml(a.damageType) : ''));
    if (a.attackBonus) chips.push(escHtml(a.attackBonus) + ' to hit');
    if (a.saveAbility || a.saveDC) chips.push(`${escHtml(a.saveAbility||'')} save${a.saveDC ? ' DC ' + escHtml(a.saveDC) : ''}`);
    return `<div style="margin-top:8px;"><strong>${escHtml(a.name)}</strong>${a.type ? ` <span style="color:var(--text-dim);">(${escHtml(a.type)})</span>` : ''}`
      + (chips.length ? `<div class="atk-chips">${chips.map(c => `<span class="atk-chip">▸ ${c}</span>`).join('')}</div>` : '')
      + `<div>${escHtml(a.description||'')}</div></div>`;
  }).join('');
  return `<div class="detail-section">
    <div class="detail-label">Quirk Mechanics${mech.source ? ` — ${escHtml(mech.source)}` : ''}</div>
    <div class="detail-body">
      ${mech.weakness ? `<div><strong>Weakness</strong> ${escHtml(mech.weakness)}</div>` : ''}
      ${abilities}
    </div>
  </div>`;
}

function dmNotesHtml(notes) {
  if (!notes) return '';
  const rows = [
    ['Combat Role', notes.combat_role],
    ['Social Role', notes.social_role],
    ['Growth Arc', notes.growth_arc],
    ['Weakness to Exploit', notes.weakness_to_exploit],
  ].filter(([, v]) => v);
  if (!rows.length) return '';
  return rows.map(([label, v]) => `<div class="detail-section"><div class="detail-label">${escHtml(label)}</div><div class="detail-body">${escHtml(v)}</div></div>`).join('');
}

function showDetail(idx) {
  const c = allChars[idx];
  const personalityObj = typeof c.personality === 'object' ? c.personality : {};
  const personality = personalityObj.summary || (typeof c.personality === 'string' ? c.personality : '') || c.personality_tag || '';
  const appearanceObj = typeof c.appearance === 'object' ? c.appearance : {};
  const appearance = [appearanceObj.hair, appearanceObj.build, appearanceObj.other].filter(Boolean).join(' ') || (typeof c.appearance === 'string' ? c.appearance : '');
  const bonus = c.bonus_features || c.notable_trait || c.quirk_summary || '';

  document.getElementById('modal').innerHTML = `
    <span class="modal-close" onclick="closeModal()" role="button" tabindex="0" aria-label="Close">✕</span>
    <h2 id="modal-title">${escHtml(c.name)}</h2>
    <div class="modal-sub">${escHtml(c._type||'')}${c.role ? ' — ' + escHtml(c.role) : ''}</div>
    <div class="detail-section"><div class="detail-label">Quirk</div><div class="detail-body">${escHtml(c.quirk||'—')}${(c.quirk_type||c.quirk_rarity) ? ` <span style="color:var(--text-dim);">(${[c.quirk_type,c.quirk_rarity].filter(Boolean).map(escHtml).join(' · ')})</span>` : ''}</div></div>
    ${quirkMechanicsHtml(c.quirk_mechanics)}
    ${appearance ? `<div class="detail-section"><div class="detail-label">Appearance</div><div class="detail-body">${escHtml(appearance)}</div></div>` : ''}
    ${personality ? `<div class="detail-section"><div class="detail-label">Personality</div><div class="detail-body">${escHtml(personality)}</div></div>` : ''}
    ${personalityObj.in_class ? `<div class="detail-section"><div class="detail-label">In Class</div><div class="detail-body">${escHtml(personalityObj.in_class)}</div></div>` : ''}
    ${personalityObj.in_combat ? `<div class="detail-section"><div class="detail-label">In Combat</div><div class="detail-body">${escHtml(personalityObj.in_combat)}</div></div>` : ''}
    ${personalityObj.quirk_of_character ? `<div class="detail-section"><div class="detail-label">Quirk of Character</div><div class="detail-body">${escHtml(personalityObj.quirk_of_character)}</div></div>` : ''}
    ${dmNotesHtml(c.dm_notes)}
    ${bonus ? `<div class="detail-section"><div class="detail-label">Bonus Features / Notes</div><div class="detail-body">${escHtml(bonus)}</div></div>` : ''}
    ${(c.tags||[]).length ? `<div class="detail-section"><div class="detail-label">Tags</div><div class="detail-body">${c.tags.map(t => `<span class="tag-chip">${escHtml(t)}</span>`).join(' ')}</div></div>` : ''}
    <div class="modal-actions">
      ${canEdit(charKey(c)) ? `
      <button class="action-btn" onclick="openEditModal(${idx})">Edit</button>
      <button class="action-btn" style="color:var(--red-text);border-color:rgba(239,68,68,0.4);" onclick="deleteCharacter(${idx})">Delete</button>
      ` : ''}
    </div>
  `;
  document.getElementById('modal-overlay').classList.add('open');
  focusModal();
}

let modalLastFocusedEl = null;
// Called right after each modal template is injected + '.open' is toggled on,
// so keyboard/screen-reader users land inside the dialog instead of it just
// appearing silently, and so we can hand focus back on close.
function focusModal() {
  modalLastFocusedEl = document.activeElement;
  const modal = document.getElementById('modal');
  const focusable = modal.querySelector('input, textarea, select, button, [tabindex]');
  (focusable || modal).focus({ preventScroll: true });
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
  if (modalLastFocusedEl && typeof modalLastFocusedEl.focus === 'function') modalLastFocusedEl.focus();
  modalLastFocusedEl = null;
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('modal-overlay').classList.contains('open')) closeModal();
});

let abilityRowCount = 0;

function characterFormHtml(c, defaultFolderId) {
  c = c || {};
  const folderId = c.folderId !== undefined ? c.folderId : (defaultFolderId || '');
  const gender = c.gender || 'Female';
  const physiology = c.physiology || 'Standard';
  const appearanceObj = typeof c.appearance === 'object' ? c.appearance : {};
  const appearanceFlat = typeof c.appearance === 'string' ? c.appearance : '';
  const personalityObj = typeof c.personality === 'object' ? c.personality : {};
  const personalityFlat = typeof c.personality === 'string' ? c.personality : (c.personality_tag || '');
  const dmNotes = c.dm_notes || {};
  const mech = c.quirk_mechanics || {};
  const abilities = mech.abilities || [];
  abilityRowCount = 0;

  return `
    <div class="form-fieldset">
      <div class="form-fieldset-label">Basics</div>
      <div class="form-row"><label>Name</label><input class="form-input" id="nc-name" type="text" placeholder="Character name" value="${escHtml(c.name||'')}"></div>
      <div class="form-row"><label>Gender</label>
        <select class="form-select" id="nc-gender">
          ${['Female','Male','Other'].map(g => `<option value="${g}" ${g===gender?'selected':''}>${g}</option>`).join('')}
        </select>
      </div>
      <div class="form-row"><label>Physiology</label>
        <select class="form-select" id="nc-physiology">
          ${['Standard','Heteromorph','Mutant'].map(p => `<option value="${p}" ${p===physiology?'selected':''}>${p}</option>`).join('')}
        </select>
      </div>
      <div class="form-row"><label>Height</label><input class="form-input" id="nc-height" type="text" placeholder="e.g. 5'9&quot;" value="${escHtml(c.height||'')}"></div>
      <div class="form-row checkbox-row"><input type="checkbox" id="nc-ispc" ${c.is_pc?'checked':''}><label style="margin:0;" for="nc-ispc">Player Character</label></div>
      <div class="form-row"><label>Folder</label>
        <select class="form-select" id="nc-folder">
          <option value="">— Unfiled —</option>
          ${allFolders.map(f => `<option value="${escHtml(f.id)}" ${f.id===folderId?'selected':''}>${escHtml(f.name)}</option>`).join('')}
        </select>
      </div>
    </div>

    <div class="form-fieldset">
      <div class="form-fieldset-label">Quirk</div>
      <div class="form-row"><label>Quirk Name</label><input class="form-input" id="nc-quirk" type="text" placeholder="Quirk name" value="${escHtml(c.quirk||'')}"></div>
      <div class="form-row"><label>Quirk Type</label>
        <select class="form-select" id="nc-quirk-type">
          ${['', 'Emitter', 'Transformation', 'Mutant'].map(t => `<option value="${t}" ${t===(c.quirk_type||'')?'selected':''}>${t||'—'}</option>`).join('')}
        </select>
      </div>
      <div class="form-row"><label>Quirk Rarity</label>
        <select class="form-select" id="nc-quirk-rarity">
          ${['', 'Common', 'Uncommon', 'Rare', 'Very Rare'].map(r => `<option value="${r}" ${r===(c.quirk_rarity||'')?'selected':''}>${r||'—'}</option>`).join('')}
        </select>
      </div>
      <div class="form-row"><label>Quirk Weakness</label><textarea class="form-textarea" id="nc-weakness" placeholder="The drawback or cost of using this quirk">${escHtml(mech.weakness||'')}</textarea></div>
      <div class="form-row"><label>Quirk Abilities</label></div>
      <div id="nc-abilities-list">
        ${abilities.map(a => abilityRowHtml(a)).join('')}
      </div>
      <datalist id="dl-nc-damage-type">${['bludgeoning','piercing','slashing','fire','cold','lightning','thunder','acid','poison','radiant','necrotic','force','psychic'].map(v => `<option value="${v}">`).join('')}</datalist>
      <button type="button" class="action-btn add-ability-btn" onclick="addAbilityRow()">+ Add Ability</button>
    </div>

    <div class="form-fieldset">
      <div class="form-fieldset-label">Appearance</div>
      <div class="form-row"><label>Hair</label><input class="form-input" id="nc-app-hair" type="text" placeholder="Hair description" value="${escHtml(appearanceObj.hair||'')}"></div>
      <div class="form-row"><label>Build</label><input class="form-input" id="nc-app-build" type="text" placeholder="Body build / silhouette" value="${escHtml(appearanceObj.build||'')}"></div>
      <div class="form-row"><label>Other</label><textarea class="form-textarea" id="nc-app-other" placeholder="Quirk-related features, distinguishing marks, etc.">${escHtml(appearanceObj.other||appearanceFlat)}</textarea></div>
    </div>

    <div class="form-fieldset">
      <div class="form-fieldset-label">Personality</div>
      <div class="form-row"><label>Summary</label><textarea class="form-textarea" id="nc-pers-summary" placeholder="Overall personality">${escHtml(personalityObj.summary||personalityFlat)}</textarea></div>
      <div class="form-row"><label>In Class</label><textarea class="form-textarea" id="nc-pers-inclass" placeholder="How they behave day-to-day at school">${escHtml(personalityObj.in_class||'')}</textarea></div>
      <div class="form-row"><label>In Combat</label><textarea class="form-textarea" id="nc-pers-incombat" placeholder="How they behave/think mid-fight">${escHtml(personalityObj.in_combat||'')}</textarea></div>
      <div class="form-row"><label>Quirk of Character</label><textarea class="form-textarea" id="nc-pers-quirkchar" placeholder="A personal quirk/habit unrelated to their Quirk power">${escHtml(personalityObj.quirk_of_character||'')}</textarea></div>
    </div>

    <div class="form-fieldset">
      <div class="form-fieldset-label">DM Notes — Roles &amp; Arc</div>
      <div class="form-row"><label>Combat Role</label><textarea class="form-textarea" id="nc-combat-role" placeholder="Their function/value in a fight">${escHtml(dmNotes.combat_role||c.role||'')}</textarea></div>
      <div class="form-row"><label>Social Role</label><textarea class="form-textarea" id="nc-social-role" placeholder="Their function/dynamic within the class">${escHtml(dmNotes.social_role||'')}</textarea></div>
      <div class="form-row"><label>Growth Arc</label><textarea class="form-textarea" id="nc-growth-arc" placeholder="Where this character is headed over time">${escHtml(dmNotes.growth_arc||'')}</textarea></div>
      <div class="form-row"><label>Weakness to Exploit</label><textarea class="form-textarea" id="nc-weakness-exploit" placeholder="A narrative/tactical weakness an enemy could use">${escHtml(dmNotes.weakness_to_exploit||'')}</textarea></div>
    </div>

    <div class="form-fieldset">
      <div class="form-fieldset-label">Misc</div>
      <div class="form-row"><label>Bonus Features / Notes</label><textarea class="form-textarea" id="nc-bonus" placeholder="Anything else — notable traits, etc.">${escHtml(c.bonus_features||c.notable_trait||'')}</textarea></div>
      <div class="form-row"><label>Tags</label><input class="form-input" id="nc-tags" type="text" placeholder="Comma-separated, e.g. villain-arc, recurring, sports-festival" value="${escHtml((c.tags||[]).join(', '))}"></div>
    </div>
  `;
}

// Keyed by the row's DOM counter, this holds the ability object each row was
// built from. readCharacterForm() spreads it back so fields this form does not
// render -- the stable `id` above all -- survive a save. Without it, editing a
// character here stripped every id, and the next save from the Class 1-A
// toolkit regenerated fresh ones, which is exactly the duplicate-item hazard
// described in CLASS-1A/relationships.js (see genId / ensureCharIds).
const abilityRowSource = new Map();

function abilityRowHtml(a) {
  a = a || {};
  const id = abilityRowCount++;
  abilityRowSource.set(String(id), a);
  return `<div class="ability-row" data-ability-id="${id}">
    <button type="button" class="ability-remove-btn" onclick="removeAbilityRow(${id})">✕</button>
    <div class="form-row"><label>Ability Name</label><input class="form-input" id="nc-ability-name-${id}" type="text" placeholder="e.g. Iron Claws" value="${escHtml(a.name||'')}"></div>
    <div class="form-row"><label>Type</label><input class="form-input" id="nc-ability-type-${id}" type="text" placeholder="e.g. Action, Bonus Action, Passive" value="${escHtml(a.type||'')}"></div>
    <div class="form-row form-row-quad">
      <div><label>Range</label><input class="form-input" id="nc-ability-range-${id}" type="text" placeholder="80 ft / Melee" value="${escHtml(a.range||'')}"></div>
      <div><label>Damage</label><input class="form-input" id="nc-ability-dmg-${id}" type="text" placeholder="3d8" value="${escHtml(a.damage||'')}"></div>
      <div><label>Dmg type</label><input class="form-input" id="nc-ability-dmgtype-${id}" type="text" list="dl-nc-damage-type" placeholder="radiant" value="${escHtml(a.damageType||'')}"></div>
      <div><label>To hit / DC</label><input class="form-input" id="nc-ability-hit-${id}" type="text" placeholder="+5" value="${escHtml(a.attackBonus||'')}"></div>
    </div>
    <div class="form-row"><label>Description</label><textarea class="form-textarea" id="nc-ability-desc-${id}" placeholder="What it does mechanically">${escHtml(a.description||'')}</textarea></div>
  </div>`;
}

function addAbilityRow() {
  document.getElementById('nc-abilities-list').insertAdjacentHTML('beforeend', abilityRowHtml());
}

function removeAbilityRow(id) {
  document.querySelector(`.ability-row[data-ability-id="${id}"]`)?.remove();
}

function readCharacterForm() {
  const abilityRows = [...document.querySelectorAll('#nc-abilities-list .ability-row')];
  const abilities = abilityRows.map(row => {
    const id = row.dataset.abilityId;
    const val = (part) => (document.getElementById(`nc-ability-${part}-${id}`)?.value || '').trim();
    // Spread the original first so anything this form does not render --
    // notably the stable `id` used to merge these arrays across clients --
    // is carried through rather than dropped on save.
    const original = abilityRowSource.get(String(id)) || {};
    const merged = {
      ...original,
      name: val('name'),
      type: val('type'),
      range: val('range'),
      damage: val('dmg'),
      damageType: val('dmgtype'),
      attackBonus: val('hit'),
      description: val('desc'),
    };
    // Drop empty optional fields so untouched abilities don't gain a wall of
    // empty strings the moment someone opens this dialog.
    for (const k of ['range','damage','damageType','attackBonus','type']) {
      if (!merged[k]) delete merged[k];
    }
    if (merged.attackBonus && !merged.hitMode) merged.hitMode = 'attack';
    return merged;
  }).filter(a => a.name || a.description);

  const weakness = document.getElementById('nc-weakness').value.trim();
  const quirk_mechanics = (weakness || abilities.length) ? { weakness, abilities } : undefined;

  const appearance = {
    hair: document.getElementById('nc-app-hair').value.trim(),
    build: document.getElementById('nc-app-build').value.trim(),
    other: document.getElementById('nc-app-other').value.trim(),
  };

  const personality = {
    summary: document.getElementById('nc-pers-summary').value.trim(),
    in_class: document.getElementById('nc-pers-inclass').value.trim(),
    in_combat: document.getElementById('nc-pers-incombat').value.trim(),
    quirk_of_character: document.getElementById('nc-pers-quirkchar').value.trim(),
  };

  const dm_notes = {
    combat_role: document.getElementById('nc-combat-role').value.trim(),
    social_role: document.getElementById('nc-social-role').value.trim(),
    growth_arc: document.getElementById('nc-growth-arc').value.trim(),
    weakness_to_exploit: document.getElementById('nc-weakness-exploit').value.trim(),
  };

  const result = {
    name: document.getElementById('nc-name').value.trim(),
    quirk: document.getElementById('nc-quirk').value.trim(),
    quirk_type: document.getElementById('nc-quirk-type').value,
    quirk_rarity: document.getElementById('nc-quirk-rarity').value,
    gender: document.getElementById('nc-gender').value,
    physiology: document.getElementById('nc-physiology').value,
    height: document.getElementById('nc-height').value.trim(),
    appearance,
    personality,
    dm_notes,
    bonus_features: document.getElementById('nc-bonus').value.trim(),
    is_pc: document.getElementById('nc-ispc').checked,
    tags: document.getElementById('nc-tags').value.split(',').map(t => t.trim()).filter(Boolean),
    folderId: document.getElementById('nc-folder').value,
  };
  if (quirk_mechanics) result.quirk_mechanics = quirk_mechanics;
  return result;
}

function openCreateModal() {
  document.getElementById('modal').innerHTML = `
    <span class="modal-close" onclick="closeModal()" role="button" tabindex="0" aria-label="Close">✕</span>
    <h2 id="modal-title">New Character</h2>
    <div class="modal-sub">Adds a new Class 1-A style character to the archive.</div>
    ${characterFormHtml(null, currentFolderId)}
    <div class="form-actions">
      <button class="action-btn primary" onclick="submitCreate()">Create Character</button>
      <button class="action-btn" onclick="closeModal()">Cancel</button>
    </div>
  `;
  document.getElementById('modal-overlay').classList.add('open');
  focusModal();
}

async function submitCreate() {
  const fields = readCharacterForm();
  if (!fields.name) { alert('Name is required.'); return; }

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const payload = Object.assign({}, fields, { _type: 'Custom' });

  try {
    await fbAuthReady;
    await FS_CHARACTERS.doc(id).set(payload);
    closeModal();
    showSavedNotice('Character created ✓');
    await init();
  } catch (e) {
    alert('Could not create character: ' + e.message);
  }
}

function openEditModal(idx) {
  const c = allChars[idx];
  document.getElementById('modal').innerHTML = `
    <span class="modal-close" onclick="closeModal()" role="button" tabindex="0" aria-label="Close">✕</span>
    <h2 id="modal-title">Edit ${escHtml(c.name)}</h2>
    <div class="modal-sub">${isCustom(c) ? 'Custom character' : 'Edits are saved as an override on top of the bundled data.'}</div>
    ${characterFormHtml(c)}
    <div class="form-actions">
      <button class="action-btn primary" onclick="submitEdit(${idx})">Save Changes</button>
      <button class="action-btn" onclick="closeModal()">Cancel</button>
    </div>
  `;
  document.getElementById('modal-overlay').classList.add('open');
  focusModal();
}

async function submitEdit(idx) {
  const c = allChars[idx];
  const fields = readCharacterForm();
  if (!fields.name) { alert('Name is required.'); return; }

  try {
    await fbAuthReady;
    if (isCustom(c)) {
      // merge:true, not a bare .set() — a bare set replaces the whole
      // document, so if someone else's edit landed on this character since
      // this modal was opened, saving here would silently erase it instead
      // of just overwriting the fields this form actually touched.
      await FS_CHARACTERS.doc(c._id).set(Object.assign({}, fields, { _type: 'Custom' }), { merge: true });
    } else {
      await FS_CHARACTERS.doc(c._staticId).set({ fields }, { merge: true });
    }
    closeModal();
    showSavedNotice('Changes saved ✓');
    await init();
  } catch (e) {
    alert('Could not save changes: ' + e.message);
  }
}

async function deleteCharacter(idx) {
  const c = allChars[idx];
  if (!confirm(`Delete ${c.name}? This removes them from the Characters page.`)) return;

  try {
    await fbAuthReady;
    if (isCustom(c)) {
      await FS_CHARACTERS.doc(c._id).delete();
    } else {
      await FS_CHARACTERS.doc(c._staticId).set({ deleted: true }, { merge: true });
    }
    closeModal();
    showSavedNotice('Character deleted');
    await init();
  } catch (e) {
    alert('Could not delete character: ' + e.message);
  }
}

let selectedFolderColor = FOLDER_COLORS[0][0];

function colorSwatchesHtml(selected) {
  return FOLDER_COLORS.map(([hex, label]) =>
    `<div class="color-swatch ${hex===selected?'selected':''}" data-color="${hex}" style="background:${hex};" role="button" tabindex="0" title="${label}" aria-label="${label}" onclick="selectFolderColor('${hex}', this)"></div>`
  ).join('');
}

function selectFolderColor(hex, el) {
  selectedFolderColor = hex;
  el.parentElement.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
  el.classList.add('selected');
}

function openCreateFolderModal() {
  selectedFolderColor = FOLDER_COLORS[0][0];
  document.getElementById('modal').innerHTML = `
    <span class="modal-close" onclick="closeModal()" role="button" tabindex="0" aria-label="Close">✕</span>
    <h2 id="modal-title">New Folder</h2>
    <div class="modal-sub">Organize characters into a named, colored folder.</div>
    <div class="form-row"><label>Folder Name</label><input class="form-input" id="nf-name" type="text" placeholder="e.g. Class 1-A, Villains, Story Arc NPCs"></div>
    <div class="form-row"><label>Colour</label><div class="color-swatch-row">${colorSwatchesHtml(selectedFolderColor)}</div></div>
    <div class="form-actions">
      <button class="action-btn primary" onclick="submitCreateFolder()">Create Folder</button>
      <button class="action-btn" onclick="closeModal()">Cancel</button>
    </div>
  `;
  document.getElementById('modal-overlay').classList.add('open');
  focusModal();
}

async function submitCreateFolder() {
  const name = document.getElementById('nf-name').value.trim();
  if (!name) { alert('Folder name is required.'); return; }
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  try {
    await fbAuthReady;
    await FS_FOLDERS_DOC.set({ folders: { [id]: { name, color: selectedFolderColor } } }, { merge: true });
    closeModal();
    showSavedNotice('Folder created ✓');
    currentFolderId = id;
    await init();
  } catch (e) {
    alert('Could not create folder: ' + e.message);
  }
}

function openEditFolderModal(id) {
  const folder = allFolders.find(f => f.id === id);
  if (!folder) return;
  selectedFolderColor = folder.color || FOLDER_COLORS[0][0];
  document.getElementById('modal').innerHTML = `
    <span class="modal-close" onclick="closeModal()" role="button" tabindex="0" aria-label="Close">✕</span>
    <h2 id="modal-title">Edit Folder</h2>
    <div class="form-row"><label>Folder Name</label><input class="form-input" id="nf-name" type="text" value="${escHtml(folder.name)}"></div>
    <div class="form-row"><label>Colour</label><div class="color-swatch-row">${colorSwatchesHtml(selectedFolderColor)}</div></div>
    <div class="form-actions">
      <button class="action-btn primary" onclick="submitEditFolder('${id}')">Save Changes</button>
      <button class="action-btn" style="color:var(--red-text);border-color:rgba(239,68,68,0.4);" onclick="deleteFolder('${id}')">Delete Folder</button>
      <button class="action-btn" onclick="closeModal()">Cancel</button>
    </div>
  `;
  document.getElementById('modal-overlay').classList.add('open');
  focusModal();
}

async function submitEditFolder(id) {
  const name = document.getElementById('nf-name').value.trim();
  if (!name) { alert('Folder name is required.'); return; }
  try {
    await fbAuthReady;
    await FS_FOLDERS_DOC.set({ folders: { [id]: { name, color: selectedFolderColor } } }, { merge: true });
    closeModal();
    showSavedNotice('Folder updated ✓');
    await init();
  } catch (e) {
    alert('Could not update folder: ' + e.message);
  }
}

async function deleteFolder(id) {
  const folder = allFolders.find(f => f.id === id);
  if (!folder) return;
  if (!confirm(`Delete folder "${folder.name}"? Characters inside will become unfiled (not deleted).`)) return;

  try {
    await fbAuthReady;
    const members = allChars.filter(c => c.folderId === id);
    await Promise.all(members.map(c => {
      return isCustom(c)
        ? FS_CHARACTERS.doc(c._id).update({ folderId: '' })
        : FS_CHARACTERS.doc(c._staticId).update({ 'fields.folderId': '' });
    }));
    await FS_FOLDERS_DOC.update({ [`folders.${id}`]: firebase.firestore.FieldValue.delete() });
    if (currentFolderId === id) currentFolderId = null;
    closeModal();
    showSavedNotice('Folder deleted');
    await init();
  } catch (e) {
    alert('Could not delete folder: ' + e.message);
  }
}

function openAddToFolderModal() {
  const folder = allFolders.find(f => f.id === currentFolderId);
  if (!folder) return;
  // Built once — only #atf-rows gets re-rendered on search/add below, so the
  // search input itself is never replaced and never loses focus mid-type.
  document.getElementById('modal').innerHTML = `
    <span class="modal-close" onclick="closeModal()" role="button" tabindex="0" aria-label="Close">✕</span>
    <h2 id="modal-title">Add to ${escHtml(folder.name)}</h2>
    <div class="modal-sub">Pick characters to add to this folder. Characters already filed in a folder aren't shown here.</div>
    <input class="form-input" id="atf-search" type="text" placeholder="Search characters…" oninput="renderAddToFolderRows(this.value)" style="margin-bottom:12px;">
    <div id="atf-rows" style="display:flex;flex-direction:column;max-height:340px;overflow-y:auto;"></div>
    <div class="form-actions"><button class="action-btn" onclick="closeModal()">Done</button></div>
  `;
  document.getElementById('modal-overlay').classList.add('open');
  renderAddToFolderRows('');
  focusModal();
}

function renderAddToFolderRows(query) {
  const rowsEl = document.getElementById('atf-rows');
  if (!rowsEl || !allFolders.some(f => f.id === currentFolderId)) return;
  const q = (query||'').toLowerCase();
  // Only unfiled characters are candidates — anyone already sitting in a
  // folder (this one or another) is left out, per how folder membership
  // should work: file once, not "addable" everywhere else too.
  const candidates = allChars.filter(c => !c.folderId && (!q || (c.name||'').toLowerCase().includes(q)));

  rowsEl.innerHTML = candidates.length ? candidates.map(c => {
    const idx = allChars.indexOf(c);
    const editable = canEdit(charKey(c));
    return `<div class="picker-row">
      <div>
        <div style="font-weight:700;">${escHtml(c.name)}</div>
        <div style="font-size:11px;color:var(--text-dim);">Unfiled</div>
      </div>
      ${editable ? `<button class="action-btn primary" onclick="addCharacterToFolder(${idx})">Add</button>` : `<span style="font-size:11px;color:var(--text-dim);">No permission</span>`}
    </div>`;
  }).join('') : `<div style="color:var(--text-dim);font-size:12px;padding:12px 0;">No matching characters.</div>`;
}

async function addCharacterToFolder(idx) {
  const c = allChars[idx];
  try {
    await fbAuthReady;
    if (isCustom(c)) {
      await FS_CHARACTERS.doc(c._id).set({ folderId: currentFolderId }, { merge: true });
    } else {
      await FS_CHARACTERS.doc(c._staticId).set({ fields: { folderId: currentFolderId } }, { merge: true });
    }
    // Update in place instead of a full init() reload — that refetch-and-
    // rebuild-everything used to reset the picker list's scroll position
    // after every single add, which made bulk-adding painful.
    c.folderId = currentFolderId;
    const rowsEl = document.getElementById('atf-rows');
    const scrollTop = rowsEl ? rowsEl.scrollTop : 0;
    renderAddToFolderRows(document.getElementById('atf-search')?.value || '');
    if (rowsEl) rowsEl.scrollTop = scrollTop;
    renderGrid();
    showSavedNotice('Added to folder ✓');
  } catch (e) {
    alert('Could not add character: ' + e.message);
  }
}

function showSavedNotice(text) {
  const notice = document.getElementById('saved-notice');
  notice.textContent = text;
  notice.classList.add('show');
  setTimeout(() => notice.classList.remove('show'), 2000);
}

document.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role="button"][tabindex]')) {
    e.preventDefault();
    e.target.click();
  }
});

init();
