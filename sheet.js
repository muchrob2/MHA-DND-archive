// Page logic for sheet.html. Extracted from the HTML so it can be linted,
// diffed and tested directly rather than regex-scraped out of markup.
// Loaded as a CLASSIC script, not a module: the page wires controls with
// inline onclick= handlers that resolve against globals.
//
// Runs after auth.js, so fbAuthReady is already defined.
//
// ── What this page is ───────────────────────────────────────────────
// A character sheet you can print. Everything the toolkit knows about a
// character already lives in the Class 1-A profile view, but that view is a
// web page — dark, interactive, three columns wide — and it prints as a mess.
// Players at a physical table wanted paper and there was no way to get any.
//
// So: one character per page, laid out for A4 and Letter, black on white,
// with the ability scores, the saves, the quirk's abilities, the inventory
// and the purse, and ruled space for notes. The screen version is the same
// layout in the site's colours, so what you see is what comes out.
//
// ── Where the data comes from ───────────────────────────────────────
// The same places the Class 1-A toolkit reads, in the same order, because a
// sheet printed from stale data is worse than no sheet:
//
//   1. mha-dnd/relationships-bundle — the live character bundle. This is
//      authoritative: several characters have been edited in the browser and
//      exist in Firestore in a form the repo files do not match.
//   2. The bundled CLASS-1A/*.json files, if Firestore is unreachable. The
//      page says so on screen when it falls back, so nobody prints a sheet
//      believing it is current when it isn't.
//   3. The `inventories` collection for the purse and the carried items,
//      which the Shop and the admin page write and the bundle does not hold.
//
// Read-only throughout. This page has no save path of any kind.

const db = firebase.firestore();
const FS_BUNDLE = db.collection('mha-dnd').doc('relationships-bundle');
const FS_INVENTORIES = db.collection('inventories');

const ABILITY_ORDER = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA', 'TECH'];
const ABILITY_NAMES = {
  STR: 'Strength', DEX: 'Dexterity', CON: 'Constitution', INT: 'Intelligence',
  WIS: 'Wisdom', CHA: 'Charisma', TECH: 'Tech',
};

let ROSTER = [];
let CHARS = [];
let current = null;
let dataSource = 'loading'; // 'firestore' | 'local' — printed on the sheet
let showNotes = true;

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Scores and modifiers are strings in some records and numbers in others —
// both forms are in the repo right now — so everything is read through this.
function num(v) {
  const raw = String(v == null ? '' : v).trim();
  // The empty-string guard is not decoration: Number('') is 0, not NaN, so
  // without it a missing field read as a real zero. Every character whose
  // record had no `modifiers` block printed +0 across all seven abilities,
  // and a level with no proficiency_bonus printed +0 instead of deriving one.
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function signed(n) {
  if (n == null) return '—';
  return (n >= 0 ? '+' : '−') + Math.abs(n);
}

// A modifier is taken from the record when it has one and derived when it
// does not, rather than left blank: floor((score - 10) / 2) is the rule, and
// a sheet with an empty modifier column is useless at the table.
function modifierFor(c, key) {
  const given = num((c.modifiers || {})[key]);
  if (given != null) return given;
  const score = num((c.ability_scores || {})[key]);
  return score == null ? null : Math.floor((score - 10) / 2);
}

// A save bonus is the modifier plus proficiency where the character is
// proficient. Nothing in the data records save proficiencies, so this prints
// the plain modifier and the sheet leaves a box to tick — honest about what
// the toolkit knows rather than inventing proficiencies it doesn't.
function saveFor(c, key) {
  return modifierFor(c, key);
}

function profBonus(c) {
  const given = num(c.proficiency_bonus);
  if (given != null) return given;
  const level = num(c.level) || 1;
  return 2 + Math.floor((level - 1) / 4);
}

function charLabel(c) {
  return c.name || c._file || 'Unnamed';
}

/* ── The sheet ── */

function scoreGridHtml(c) {
  return ABILITY_ORDER.map(key => {
    const score = num((c.ability_scores || {})[key]);
    const mod = modifierFor(c, key);
    return `<div class="sh-score">
      <div class="sh-score-key">${escHtml(key)}</div>
      <div class="sh-score-num">${score == null ? '—' : score}</div>
      <div class="sh-score-mod">${signed(mod)}</div>
      <div class="sh-score-name">${escHtml(ABILITY_NAMES[key] || key)}</div>
    </div>`;
  }).join('');
}

function savesHtml(c) {
  return ABILITY_ORDER.map(key => `<div class="sh-save">
      <span class="sh-save-box" aria-hidden="true"></span>
      <span class="sh-save-key">${escHtml(key)}</span>
      <span class="sh-save-val">${signed(saveFor(c, key))}</span>
    </div>`).join('');
}

function statsHtml(c) {
  const stats = [
    ['HP', c.HP], ['AC', c.AC], ['Speed', c.speed],
    ['Prof.', signed(profBonus(c))],
    ['Quirk DC', c.quirk_save_DC], ['Quirk save', c.quirk_ability],
    ['Level', c.level],
  ];
  return stats.filter(([, v]) => v != null && String(v).trim() !== '')
    .map(([k, v]) => `<div class="sh-stat">
      <div class="sh-stat-key">${escHtml(k)}</div>
      <div class="sh-stat-val">${escHtml(v)}</div>
    </div>`).join('');
}

function abilitiesHtml(c) {
  const list = (c.quirk_mechanics || {}).abilities;
  if (!Array.isArray(list) || !list.length) {
    return '<p class="sh-empty">No quirk abilities recorded.</p>';
  }
  return list.map(a => `<div class="sh-ability">
    <div class="sh-ability-head">
      <span class="sh-ability-name">${escHtml(a.name || 'Unnamed')}</span>
      ${a.type ? `<span class="sh-ability-type">${escHtml(a.type)}</span>` : ''}
      ${a.attackBonus ? `<span class="sh-ability-stat">to hit ${escHtml(a.attackBonus)}</span>` : ''}
      ${a.damage ? `<span class="sh-ability-stat">${escHtml(a.damage)}</span>` : ''}
    </div>
    ${a.description ? `<p class="sh-ability-text">${escHtml(a.description)}</p>` : ''}
  </div>`).join('');
}

function inventoryHtml(c) {
  const inv = c.inventory || {};
  const items = Array.isArray(inv.items) ? inv.items : [];
  const purse = inv.currency || {};
  const yen = num(purse.yen);
  const coins = ['pp', 'gp', 'ep', 'sp', 'cp']
    .map(k => [k, num(purse[k])]).filter(([, v]) => v);

  const rows = items.length
    ? items.map(it => `<tr>
        <td class="sh-item-qty">${escHtml(it.qty == null ? '1' : it.qty)}</td>
        <td class="sh-item-name">${escHtml(it.name || '')}</td>
        <td class="sh-item-notes">${escHtml(it.notes || '')}</td>
      </tr>`).join('')
    : '<tr><td colspan="3" class="sh-empty">Carrying nothing on record.</td></tr>';

  return `<table class="sh-items">
      <thead><tr><th>#</th><th>Item</th><th>Notes</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="sh-purse">
      <span class="sh-purse-yen">¥${yen == null ? 0 : yen.toLocaleString()}</span>
      ${coins.map(([k, v]) => `<span class="sh-coin">${v} ${escHtml(k)}</span>`).join('')}
    </div>`;
}

// Ruled lines, not a blank area: the whole reason to print a sheet is to
// write on it, and a box with no lines gets used for nothing.
function notesHtml() {
  return `<div class="sh-rules">${'<span class="sh-rule"></span>'.repeat(8)}</div>`;
}

function renderSheet() {
  const wrap = document.getElementById('sheet');
  if (!wrap) return;
  if (!current) {
    wrap.innerHTML = '<p class="sh-empty">Pick a character.</p>';
    return;
  }
  const c = current;
  const sub = [c.quirk, c.suggested_class, c.physiology && c.physiology !== 'Standard' ? c.physiology : null]
    .filter(Boolean).join(' · ');

  wrap.innerHTML = `
    <header class="sh-head">
      <div class="sh-head-main">
        <h1 class="sh-name">${escHtml(charLabel(c))}</h1>
        <p class="sh-sub">${escHtml(sub)}</p>
      </div>
      <div class="sh-head-meta">
        <div>U.A. High — Class 1-A</div>
        <div>${escHtml(c.quirk_type || '')}${c.quirk_rarity ? ' · ' + escHtml(c.quirk_rarity) : ''}</div>
      </div>
    </header>

    <div class="sh-stats">${statsHtml(c)}</div>

    <section class="sh-block">
      <h2 class="sh-h2">Ability scores</h2>
      <div class="sh-scores">${scoreGridHtml(c)}</div>
      <h2 class="sh-h2">Saving throws <span class="sh-h2-note">tick where proficient and add ${escHtml(signed(profBonus(c)))}</span></h2>
      <div class="sh-saves">${savesHtml(c)}</div>
    </section>

    <section class="sh-block">
      <h2 class="sh-h2">Quirk — ${escHtml(c.quirk || 'none recorded')}</h2>
      ${(c.quirk_mechanics || {}).weakness
        ? `<p class="sh-weakness"><strong>Weakness.</strong> ${escHtml(c.quirk_mechanics.weakness)}</p>` : ''}
      ${abilitiesHtml(c)}
    </section>

    <section class="sh-block">
      <h2 class="sh-h2">Carried</h2>
      ${inventoryHtml(c)}
    </section>

    ${c.additional_features ? `<section class="sh-block">
      <h2 class="sh-h2">Other features</h2>
      <p class="sh-para">${escHtml(c.additional_features)}</p>
    </section>` : ''}

    ${showNotes ? `<section class="sh-block sh-notes">
      <h2 class="sh-h2">Notes</h2>
      ${notesHtml()}
    </section>` : ''}

    <footer class="sh-foot">
      ${escHtml(charLabel(c))} · printed from the MHA D&amp;D toolkit ·
      ${dataSource === 'firestore' ? 'live data' : 'bundled data — Firestore was unreachable'}
    </footer>`;
}

/* ── Controls ── */

function pickChar(file) {
  current = CHARS.find(c => c._file === file) || null;
  if (current) {
    try { localStorage.setItem('mha-sheet-last', file); } catch {}
    // So a reload, or a link sent to a player, lands on the same sheet.
    if (history.replaceState) history.replaceState(null, '', '?c=' + encodeURIComponent(file));
  }
  renderPicker();
  renderSheet();
}

function toggleNotes() {
  showNotes = !showNotes;
  renderPicker();
  renderSheet();
}

function printSheet() {
  window.print();
}

function renderPicker() {
  const sel = document.getElementById('sheet-picker');
  if (sel) {
    sel.innerHTML = CHARS.map(c =>
      `<option value="${escHtml(c._file)}"${current && c._file === current._file ? ' selected' : ''}>${escHtml(charLabel(c))}</option>`).join('');
  }
  const notesBtn = document.getElementById('sheet-notes-btn');
  if (notesBtn) {
    notesBtn.textContent = showNotes ? 'Notes lines: on' : 'Notes lines: off';
    notesBtn.classList.toggle('sel', showNotes);
  }
  const src = document.getElementById('sheet-source');
  if (src) {
    src.textContent = dataSource === 'firestore'
      ? 'Live data'
      : dataSource === 'local' ? 'Bundled data — Firestore unreachable' : 'Loading…';
    src.className = 'sheet-source ' + dataSource;
  }
}

/* ── Load ── */

// The live bundle first, the repo files second — the same order and the same
// reasoning as the Class 1-A toolkit. A character edited in the browser
// exists in Firestore in a form the repo file does not match, and printing
// the repo copy of one of those would be printing a different character.
async function loadChars() {
  const roster = await fetch('CLASS-1A/roster.json').then(r => r.json()).catch(() => null);
  ROSTER = (roster && roster.students || []).filter(s => s.file);

  let bundle = null;
  try {
    await fbAuthReady;
    const snap = await FS_BUNDLE.get();
    const data = snap.exists ? snap.data() : null;
    if (data && data.version === 1 && data.characters) bundle = data;
  } catch {}

  if (bundle) {
    dataSource = 'firestore';
    CHARS = ROSTER.map(s => {
      const c = Object.assign({}, bundle.characters[s.file] || {});
      c._file = s.file;
      c.name = c.name || s.name;
      c.quirk = c.quirk || s.quirk;
      return c;
    }).filter(c => c.name);
  } else {
    dataSource = 'local';
    const loaded = await Promise.all(ROSTER.map(s =>
      fetch('CLASS-1A/' + s.file).then(r => r.json())
        .then(c => { c._file = s.file; return c; })
        .catch(() => null)));
    CHARS = loaded.filter(Boolean);
  }

  // The purse and the carried items live in their own collection, written by
  // the Shop and the admin page — the bundle's copy of them goes stale the
  // first time anyone buys anything.
  try {
    const snap = await FS_INVENTORIES.get();
    const byFile = {};
    snap.forEach(d => { byFile[d.id] = d.data(); });
    for (const c of CHARS) {
      const live = byFile[c._file];
      if (!live) continue;
      c.inventory = Object.assign({}, c.inventory, live);
    }
  } catch {}

  CHARS.sort((a, b) => charLabel(a).localeCompare(charLabel(b)));
}

async function init() {
  await loadChars();
  if (!CHARS.length) {
    document.getElementById('sheet').innerHTML =
      '<p class="sh-empty">No characters could be loaded. Reload to try again.</p>';
    renderPicker();
    return;
  }
  // ?c=file wins, then the last one printed on this device, then the first.
  const wanted = new URLSearchParams(location.search).get('c');
  let last = null;
  try { last = localStorage.getItem('mha-sheet-last'); } catch {}
  current = CHARS.find(c => c._file === wanted)
    || CHARS.find(c => c._file === last)
    || CHARS[0];
  renderPicker();
  renderSheet();
}

init();
