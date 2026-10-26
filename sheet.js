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
// charLoadAll in char-data.js — a script tag above this one, shared with the
// party table. It reads the live character bundle first and the bundled JSON
// files only as a fallback, and reports which it used, because a sheet
// printed from stale data is worse than no sheet. The same file carries the
// number helpers (charModifier, charProfBonus, charSigned), so the sheet and
// the party table cannot disagree about a character's modifier.
//
// Read-only throughout. This page has no save path of any kind.

const db = firebase.firestore();

let CHARS = [];
let current = null;
let dataSource = 'loading'; // 'firestore' | 'local' — printed on the sheet
let showNotes = true;

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// charNum, charSigned, charModifier, charProfBonus and charLabel come from
// char-data.js. They were written here first and moved there when the party
// table needed the same four decisions — the empty-string guard in charNum
// especially, which is the one that stops a missing field reading as zero.

// A save bonus is the modifier plus proficiency where the character is
// proficient. Nothing in the data records save proficiencies, so this prints
// the plain modifier and the sheet leaves a box to tick — honest about what
// the toolkit knows rather than inventing proficiencies it doesn't.
function saveFor(c, key) {
  return charModifier(c, key);
}

/* ── The sheet ── */

function scoreGridHtml(c) {
  return CHAR_ABILITIES.map(key => {
    const score = charNum((c.ability_scores || {})[key]);
    const mod = charModifier(c, key);
    return `<div class="sh-score">
      <div class="sh-score-key">${escHtml(key)}</div>
      <div class="sh-score-num">${score == null ? '—' : score}</div>
      <div class="sh-score-mod">${charSigned(mod)}</div>
      <div class="sh-score-name">${escHtml(CHAR_ABILITY_NAMES[key] || key)}</div>
    </div>`;
  }).join('');
}

function savesHtml(c) {
  return CHAR_ABILITIES.map(key => `<div class="sh-save">
      <span class="sh-save-box" aria-hidden="true"></span>
      <span class="sh-save-key">${escHtml(key)}</span>
      <span class="sh-save-val">${charSigned(saveFor(c, key))}</span>
    </div>`).join('');
}

function statsHtml(c) {
  const stats = [
    ['HP', c.HP], ['AC', c.AC], ['Speed', c.speed],
    ['Prof.', charSigned(charProfBonus(c))],
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
  const yen = charNum(purse.yen);
  const coins = ['pp', 'gp', 'ep', 'sp', 'cp']
    .map(k => [k, charNum(purse[k])]).filter(([, v]) => v);

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
      <h2 class="sh-h2">Saving throws <span class="sh-h2-note">tick where proficient and add ${escHtml(charSigned(charProfBonus(c)))}</span></h2>
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

// The whole of this used to live here — the live-bundle-first order, the
// roster name fallback, the inventories merge. It is charLoadAll in
// char-data.js now, shared with the party table, so the two pages cannot come
// to different conclusions about who is in the class or what they are worth.
async function loadChars() {
  const { chars, source } = await charLoadAll(db, { authReady: fbAuthReady });
  CHARS = chars;
  dataSource = source;
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
