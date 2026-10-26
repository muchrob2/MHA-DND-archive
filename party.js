// Page logic for party.html. Extracted from the HTML so it can be linted,
// diffed and tested directly rather than regex-scraped out of markup.
// Loaded as a CLASSIC script, not a module: the page wires controls with
// inline onclick= handlers that resolve against globals.
//
// Runs after auth.js, so fbAuthReady is already defined.
//
// ── What this page is ───────────────────────────────────────────────
// The party, as one table of numbers.
//
// There was nowhere on the site to see every character's AC side by side.
// The Characters tab is cards of names and quirks; the Class 1-A profile view
// is one character at a time; the printable sheet is one character to a page.
// So "what's the lowest AC in the room" or "will they notice that" meant
// clicking through twenty profiles and holding the answers in your head.
//
// One row per character, the columns a DM actually asks for mid-session —
// AC, HP, speed, the quirk save DC, the passive scores, and all seven
// modifiers — sortable by any of them, with the party's spread underneath.
//
// ── The passive column, honestly ────────────────────────────────────
// It is 10 + the WIS modifier, with no proficiency added, because nothing in
// the character data records which skills anybody is proficient in. The page
// says so under the table rather than quietly printing a number that is 2 to
// 6 too low for half the class — read it as the floor.
//
// It is one column rather than separate Perception and Insight ones for the
// same reason: both are WIS, and without proficiencies they are the same
// number. Two identical columns would be noise in a table whose whole point
// is being readable at a glance.
//
// ── Where the data comes from ───────────────────────────────────────
// charLoadAll in char-data.js, shared with the printable sheet: the live
// character bundle first, the bundled JSON files only as a fallback, and the
// purse from the inventories collection the Shop writes. The page reports
// which source it used — a table of stale numbers is worse than none.
//
// Read-only. No save path of any kind.

const db = firebase.firestore();

let CHARS = [];
let dataSource = 'loading';
let sortKey = 'name';
let sortDir = 1;        // 1 ascending, -1 descending
let pcsOnly = false;

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ── The columns ────────────────────────────────────────────────────
   One place names a column, says how to read it out of a character, and how
   to sort it. Adding a column is one entry here and nothing else.

     key    stable id; also the sort key and the header's data attribute
     label  the header, kept short — this table is read at a glance
     title  the tooltip, where the explanation goes
     value  (c) => the raw value, for sorting. null sorts last, always.
     text   (c) => what is printed. Defaults to the value, or '—' for null.
   ─────────────────────────────────────────────────────────────────── */
const PARTY_COLUMNS = [
  { key: 'name', label: 'Name', title: 'Character name', align: 'left',
    value: c => charLabel(c), text: c => charLabel(c) },
  { key: 'level', label: 'Lv', title: 'Level',
    value: c => charNum(c.level) },
  { key: 'hp', label: 'HP', title: 'Hit points as recorded on the character',
    value: c => charNum(c.HP) },
  { key: 'ac', label: 'AC', title: 'Armour class — the number to beat',
    value: c => charNum(c.AC) },
  { key: 'speed', label: 'Speed', title: 'Walking speed',
    value: c => charNum(String(c.speed || '').replace(/[^\d-]/g, '')),
    text: c => c.speed || '—' },
  { key: 'prof', label: 'Prof', title: 'Proficiency bonus, derived from level where not recorded',
    value: c => charProfBonus(c), text: c => charSigned(charProfBonus(c)) },
  { key: 'dc', label: 'Quirk DC', title: 'The DC of this character\'s own quirk effects',
    value: c => charNum(c.quirk_save_DC) },
  { key: 'passive', label: 'Passive', title: '10 + WIS — what they notice without looking. Covers Perception and Insight both, because no proficiency is recorded for either; read it as the floor',
    value: c => charPassive(c, 'WIS') },
  ...CHAR_ABILITIES.map(k => ({
    key: 'mod' + k, label: k, title: CHAR_ABILITY_NAMES[k] + ' modifier', ability: true,
    value: c => charModifier(c, k), text: c => charSigned(charModifier(c, k)),
  })),
];

function colByKey(key) {
  return PARTY_COLUMNS.find(c => c.key === key) || PARTY_COLUMNS[0];
}

function cellText(col, c) {
  if (col.text) return col.text(c);
  const v = col.value(c);
  return v == null ? '—' : String(v);
}

/* ── Sorting ────────────────────────────────────────────────────────
   A missing number always sorts last, whichever direction the column is in.
   Sorting ascending and finding four dashes at the top would hide the people
   you were looking for behind the people whose records have a gap.
   ─────────────────────────────────────────────────────────────────── */
function sortedChars() {
  const col = colByKey(sortKey);
  const rows = CHARS.filter(c => !pcsOnly || isPc(c));
  return rows.slice().sort((a, b) => {
    const av = col.value(a);
    const bv = col.value(b);
    if (av == null && bv == null) return charLabel(a).localeCompare(charLabel(b));
    if (av == null) return 1;
    if (bv == null) return -1;
    const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
    if (cmp) return cmp * sortDir;
    // Ties always fall back to A-Z, and the direction is NOT applied to the
    // fallback: it used to be, so flipping the AC column also reversed the
    // names inside every band of equal AC. The whole class shares a
    // proficiency bonus, so that column was nothing but ties.
    return charLabel(a).localeCompare(charLabel(b));
  });
}

// is_pc is "true" (a string) in the repo files and true in some bundle
// entries, so both forms have to count.
function isPc(c) {
  return c.is_pc === true || String(c.is_pc).toLowerCase() === 'true';
}

function sortBy(key) {
  if (sortKey === key) {
    sortDir = -sortDir;
  } else {
    sortKey = key;
    // Names read best A-Z; numbers read best highest-first, because the
    // question is almost always "who has the most/least of this".
    sortDir = key === 'name' ? 1 : -1;
  }
  render();
}

function togglePcs() {
  pcsOnly = !pcsOnly;
  render();
}

/* ── The spread ─────────────────────────────────────────────────────
   Under each numeric column: the lowest, the average and the highest in the
   party. This is the row a DM is really after — "is a DC 15 fair on this
   group" is answered by the average, and "will this one-shot anybody" by
   the lowest.
   ─────────────────────────────────────────────────────────────────── */
function spreadFor(col, rows) {
  if (col.key === 'name') return null;
  const vals = rows.map(c => col.value(c)).filter(v => typeof v === 'number');
  if (!vals.length) return null;
  const sum = vals.reduce((a, b) => a + b, 0);
  return {
    min: Math.min(...vals),
    max: Math.max(...vals),
    // One decimal place: an average AC of 14 and one of 14.4 are different
    // answers to "what should this hit on".
    avg: Math.round((sum / vals.length) * 10) / 10,
    n: vals.length,
  };
}

function fmtSpread(col, s) {
  if (!s) return '';
  const f = (v) => (col.ability || col.key === 'prof') ? charSigned(v) : String(v);
  return `${f(s.min)} · ${f(s.avg)} · ${f(s.max)}`;
}

/* ── Render ── */

function render() {
  const rows = sortedChars();
  const table = document.getElementById('party-table');
  if (table) {
    table.innerHTML = `
      <thead>
        <tr>${PARTY_COLUMNS.map(col => `
          <th class="pt-th${col.align === 'left' ? ' pt-left' : ''}${sortKey === col.key ? ' pt-sorted' : ''}"
              title="${escHtml(col.title)}" data-key="${escHtml(col.key)}"
              onclick="sortBy('${escHtml(col.key)}')" role="button" tabindex="0"
              onkeydown="if(event.key==='Enter'||event.key===' ')sortBy('${escHtml(col.key)}')">
            ${escHtml(col.label)}${sortKey === col.key ? `<span class="pt-arrow">${sortDir > 0 ? '▲' : '▼'}</span>` : ''}
          </th>`).join('')}</tr>
      </thead>
      <tbody>
        ${rows.map(c => `<tr>${PARTY_COLUMNS.map(col => `
          <td class="${col.align === 'left' ? 'pt-left pt-name' : ''}${col.ability ? ' pt-mod' : ''}${sortKey === col.key ? ' pt-sorted' : ''}">
            ${col.key === 'name'
              ? `<a href="sheet.html?c=${encodeURIComponent(c._file || '')}" title="Open ${escHtml(charLabel(c))}'s printable sheet">${escHtml(cellText(col, c))}</a>${isPc(c) ? '<span class="pt-pc">PC</span>' : ''}`
              : escHtml(cellText(col, c))}
          </td>`).join('')}</tr>`).join('')}
      </tbody>
      <tfoot>
        <tr>${PARTY_COLUMNS.map(col => `
          <td class="pt-spread${col.align === 'left' ? ' pt-left' : ''}">
            ${col.key === 'name' ? 'low · avg · high' : escHtml(fmtSpread(col, spreadFor(col, rows)))}
          </td>`).join('')}</tr>
      </tfoot>`;
  }

  const count = document.getElementById('party-count');
  if (count) {
    count.textContent = pcsOnly
      ? `${rows.length} of ${CHARS.length}`
      : `${CHARS.length} characters`;
  }
  const pcBtn = document.getElementById('party-pc-btn');
  if (pcBtn) {
    pcBtn.textContent = pcsOnly ? 'Players only' : 'Everyone';
    pcBtn.classList.toggle('sel', pcsOnly);
  }
  const src = document.getElementById('party-source');
  if (src) {
    src.textContent = dataSource === 'firestore' ? 'Live data'
      : dataSource === 'local' ? 'Bundled data — Firestore unreachable' : 'Loading…';
    src.className = 'party-source ' + dataSource;
  }
  const empty = document.getElementById('party-empty');
  if (empty) empty.style.display = rows.length ? 'none' : '';
}

function printParty() {
  window.print();
}

async function init() {
  const { chars, source } = await charLoadAll(db, { authReady: fbAuthReady });
  CHARS = chars;
  dataSource = source;
  render();
}

init();
