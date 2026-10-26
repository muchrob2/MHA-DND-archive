#!/usr/bin/env node
// Regression check for sheet.html — the printable character sheet.
//
// What makes this page worth a verifier of its own: it is the only page whose
// real output is on paper, where nobody will notice a wrong number until the
// session has already started, and where "it looked fine on screen" proves
// nothing. So the sheet is rendered here for EVERY character in the roster
// and the output inspected, and the print rules are checked as rules rather
// than taken on trust.
//
// What it guards:
//   1. Every one of the twenty characters renders with no gaps, no NaN and no
//      "undefined" — against their real repo records, not a fixture.
//   2. The arithmetic the page derives: a modifier from a score when the
//      record has no modifiers block, a proficiency bonus from a level.
//   3. Empty-string fields are not read as zero. Number('') is 0, and that
//      one fact silently printed +0 across all seven abilities for any
//      character whose record lacked a modifiers block.
//   4. Everything printed is escaped. A character name is editable from the
//      browser, so it is untrusted text by the time it reaches here.
//   5. The page reads the LIVE bundle first and says on the sheet which
//      source it used — a sheet printed from stale data is worse than none.
//   6. The print stylesheet hides the controls, sets ink on paper, and avoids
//      splitting a block across a page break.
//   7. It is read-only: no save path of any kind.

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log('PASS — ' + label); return; }
  failures++;
  console.error('FAIL — ' + label + (detail ? '\n        ' + detail : ''));
}

const pageJs = read('sheet.js');
const pageHtml = read('sheet.html');
const pageCss = read('css/pages/sheet.css');

// Everything from the ability tables to the loader is pure rendering, so it
// is lifted out and driven directly rather than the page being booted (which
// would want Firebase, auth.js and a DOM).
const els = {};
const mk = () => ({ innerHTML: '', textContent: '', className: '',
  classList: { add() {}, remove() {}, toggle() {} } });
for (const id of ['sheet', 'sheet-picker', 'sheet-notes-btn', 'sheet-source']) els[id] = mk();

const env = new Function('sandbox', `
  const { document, localStorage, history, location } = sandbox;
  function escHtml(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
  ${pageJs.slice(pageJs.indexOf('const ABILITY_ORDER'), pageJs.indexOf('/* ── Load ── */'))}
  return { setChars(c, s){ CHARS = c; current = c[0]; dataSource = s; },
           pick: pickChar, toggleNotes, renderSheet, renderPicker,
           modifierFor, profBonus, signed, num, saveFor };
`)({
  document: { getElementById: (i) => els[i] || null },
  localStorage: { setItem() {}, getItem: () => null },
  history: {},
  location: { search: '' },
});

const roster = JSON.parse(read('CLASS-1A/roster.json'));
const characters = (roster.students || []).filter(s => s.file).map(s => {
  const c = JSON.parse(read(path.join('CLASS-1A', s.file)));
  c._file = s.file;
  return c;
});

/* ── 1. every character, against their real record ── */
{
  check('the whole roster has files to render', characters.length >= 18,
    characters.length + ' characters');

  env.setChars(characters, 'firestore');
  const problems = [];
  for (const c of characters) {
    env.pick(c._file);
    const html = els.sheet.innerHTML;
    if (!html.includes(c.name)) problems.push(c._file + ': name missing');
    if ((html.match(/sh-score"/g) || []).length !== 7) problems.push(c._file + ': not seven ability boxes');
    if ((html.match(/sh-save"/g) || []).length !== 7) problems.push(c._file + ': not seven save rows');
    if (/undefined|NaN|\[object Object\]/.test(html)) problems.push(c._file + ': printed undefined/NaN');
    if (!/sh-foot/.test(html)) problems.push(c._file + ': no footer');
  }
  check('every character in the roster renders a complete sheet',
    problems.length === 0, problems.join(' | '));

  // A dash in the modifier column means the page could not work one out, and
  // a sheet with a blank modifier column is useless at the table.
  const dashed = characters.filter(c => {
    env.pick(c._file);
    return /sh-score-mod">—/.test(els.sheet.innerHTML);
  });
  check('and every one has all seven modifiers, derived where not recorded',
    dashed.length === 0, dashed.map(c => c._file).join(', '));
}

/* ── 2. the arithmetic ── */
{
  const bare = {
    _file: 'x.json', name: 'Test', level: '9',
    ability_scores: { STR: '14', DEX: 7, CON: '20', INT: 10, WIS: '11', CHA: 1, TECH: '4' },
  };
  const want = { STR: 2, DEX: -2, CON: 5, INT: 0, WIS: 0, CHA: -5, TECH: -3 };
  const wrong = Object.entries(want)
    .filter(([k, v]) => env.modifierFor(bare, k) !== v)
    .map(([k, v]) => `${k}: got ${env.modifierFor(bare, k)}, want ${v}`);
  check('a modifier is derived from the score when the record has none',
    wrong.length === 0, wrong.join(' | '));

  check('a recorded modifier wins over the derived one',
    env.modifierFor({ ability_scores: { STR: 20 }, modifiers: { STR: '+1' } }, 'STR') === 1,
    'the record is the character; the formula is only the fallback');

  check('the proficiency bonus is derived from the level when not recorded',
    [[1, 2], [4, 2], [5, 3], [8, 3], [9, 4], [13, 5], [17, 6], [20, 6]]
      .every(([lvl, b]) => env.profBonus({ level: String(lvl) }) === b));
  check('and a recorded proficiency bonus wins',
    env.profBonus({ level: '1', proficiency_bonus: '5' }) === 5);

  check('a negative modifier prints with a sign, and zero prints as +0',
    env.signed(-3) === '−3' && env.signed(0) === '+0' && env.signed(null) === '—');
}

/* ── 3. the empty-string trap ── */
{
  // Number('') is 0. This is the single fact that made every modifier on a
  // record without a `modifiers` block print as +0.
  check('an empty or missing field reads as nothing, not as zero',
    env.num('') === null && env.num('   ') === null && env.num(null) === null
    && env.num(undefined) === null && env.num({}) === null,
    JSON.stringify([env.num(''), env.num('   '), env.num(null)]));
  check('but a real zero still reads as zero',
    env.num(0) === 0 && env.num('0') === 0);
  check('and the page keeps the guard that makes that true',
    /if \(raw === ''\) return null;/.test(pageJs));
}

/* ── 4. escaping ── */
{
  const nasty = {
    _file: 'n.json', name: '<img src=x onerror=alert(1)>', quirk: '"><script>bad</script>',
    speed: '<b>30</b>', additional_features: '<u>hm</u>',
    ability_scores: {}, suggested_class: '<em>x</em>',
    quirk_mechanics: { weakness: '<s>w</s>', abilities: [{ name: '<b>x</b>', type: '<i>t</i>', description: 'a & b' }] },
    inventory: { items: [{ name: '<i>y</i>', qty: '<br>', notes: '<u>z</u>' }], currency: { yen: 5 } },
  };
  env.setChars([nasty], 'local');
  env.renderSheet();
  const html = els.sheet.innerHTML;
  check('nothing a character record contains can inject markup',
    !/<img|<script|<b>|<i>|<u>|<s>|<em>|<br>/.test(html),
    (html.match(/<(img|script|b|i|u|s|em|br)>/g) || []).join(' '));
  check('and an ampersand survives as an ampersand',
    html.includes('a &amp; b'));

  // A roster entry whose file is missing or empty must still produce a sheet.
  env.setChars([{ _file: 'e.json', name: 'Empty' }], 'local');
  env.renderSheet();
  const empty = els.sheet.innerHTML;
  check('an empty record renders a sheet that says what it is missing',
    empty.includes('Empty') && /No quirk abilities/.test(empty)
    && /Carrying nothing/.test(empty) && !/NaN|undefined/.test(empty));
}

/* ── 5. the source of the data ── */
{
  check('the page reads the live character bundle',
    /doc\('relationships-bundle'\)/.test(pageJs),
    'the same document the Class 1-A toolkit writes');
  check('and the inventories collection for the purse and the carried items',
    /collection\('inventories'\)/.test(pageJs),
    'the Shop writes there, not into the bundle');
  // Driven, not read: comparing where two strings sit in the source was true
  // however the loader actually behaved, and stayed true with the bundle
  // forced to null. So loadChars is run against a stubbed Firestore and fetch
  // and asked which copy it came back with.
  function runLoader({ bundleExists, bundleCharacters, inventories }) {
    const out = { fetched: [] };
    const loader = new Function('sandbox', `
      const { fetch, fbAuthReady, FS_BUNDLE, FS_INVENTORIES, out } = sandbox;
      let ROSTER = [], CHARS = [], dataSource = 'loading';
      ${pageJs.slice(pageJs.indexOf('function num('), pageJs.indexOf('/* ── The sheet ── */'))}
      function charLabel(c){ return c.name || c._file || 'Unnamed'; }
      ${pageJs.slice(pageJs.indexOf('async function loadChars()'), pageJs.indexOf('async function init()'))}
      return async () => { await loadChars(); return { CHARS, dataSource }; };
    `)({
      out,
      fetch: (url) => {
        out.fetched.push(url);
        if (url.endsWith('roster.json')) {
          return Promise.resolve({ json: () => Promise.resolve({ students: [{ id: 1, name: 'Repo Name', quirk: 'Q', file: 'a.json' }] }) });
        }
        return Promise.resolve({ json: () => Promise.resolve({ name: 'Repo Name', HP: '1' }) });
      },
      fbAuthReady: Promise.resolve(),
      FS_BUNDLE: { get: () => Promise.resolve({ exists: bundleExists, data: () => bundleCharacters }) },
      FS_INVENTORIES: { get: () => Promise.resolve({ forEach: (fn) => (inventories || []).forEach(fn) }) },
    });
    return loader();
  }

  return runLoader({
    bundleExists: true,
    bundleCharacters: { version: 1, characters: { 'a.json': { name: 'Live Name', HP: '99' } } },
  }).then(live => runLoader({ bundleExists: false }).then(fallback => runLoader({
    bundleExists: true,
    bundleCharacters: { version: 1, characters: { 'a.json': { name: 'Live Name', HP: '99' } } },
    inventories: [{ id: 'a.json', data: () => ({ currency: { yen: 4200 }, items: [{ name: 'From the Shop' }] }) }],
  }).then(withInv => runLoader({
    // A bundle entry that carries stats but no name of its own — the roster
    // has to fill that in, or the character vanishes from the picker.
    bundleExists: true,
    bundleCharacters: { version: 1, characters: { 'a.json': { HP: '7' } } },
  }).then(nameless => {
    check('the live bundle is used when it is there',
      live.dataSource === 'firestore' && live.CHARS[0].name === 'Live Name' && live.CHARS[0].HP === '99',
      JSON.stringify(live.CHARS[0]));
    check('and the bundled JSON files only when it is not',
      fallback.dataSource === 'local' && fallback.CHARS[0].name === 'Repo Name',
      JSON.stringify(fallback.CHARS[0]));
    check('the purse and the carried items come from the inventories collection',
      withInv.CHARS[0].inventory && withInv.CHARS[0].inventory.currency
      && withInv.CHARS[0].inventory.currency.yen === 4200
      && withInv.CHARS[0].inventory.items[0].name === 'From the Shop',
      'the Shop writes there, and the bundle\'s copy goes stale the first time anyone buys anything');
    check('a bundle entry with no name of its own takes the roster\'s',
      nameless.CHARS.length === 1 && nameless.CHARS[0].name === 'Repo Name'
      && nameless.CHARS[0].HP === '7',
      JSON.stringify(nameless.CHARS));
    finish();
  })))).catch(err => {
    // Without this, a throw inside the chain — an undefined property on a
    // character the loader failed to build — exited 0 with no FAIL printed,
    // and the run looked clean. Deleting the inventory merge did exactly that.
    console.error('FAIL — the loader checks threw rather than reporting\n        ' + (err && err.stack || err));
    console.error('\n>>> character sheet FAILED (threw)');
    process.exit(1);
  });

  // Sections 6 and 7 run inside this callback because section 5 drives the
  // loader, which is async. The process exit code is set here, at the end of
  // the chain, so a failure in any section still fails the run.
  function finish() {
    env.setChars([{ _file: 'a.json', name: 'A' }], 'local');
    env.renderSheet();
    check('a sheet printed from the fallback says so on the paper',
      /Firestore was unreachable/.test(els.sheet.innerHTML));
    env.setChars([{ _file: 'a.json', name: 'A' }], 'firestore');
    env.renderSheet();
    check('and one printed from live data says that instead',
      /live data/.test(els.sheet.innerHTML) && !/unreachable/.test(els.sheet.innerHTML));
    check('the nav shows which source is in use before anything is printed',
      /id="sheet-source"/.test(pageHtml) && /dataSource === 'firestore'/.test(pageJs));

    /* ── 6. the print rules ── */
    // Anchored at the start of a line, with the brace: the stylesheet's own
    // header comment contains the words "@media print", and a plain indexOf
    // matched THAT — so printBlock was the whole file and every check below
    // passed by reading the screen rules. Deleting a print rule changed nothing.
    const printAt = /^@media print\s*\{/m.exec(pageCss);
    const printBlock = printAt ? pageCss.slice(printAt.index) : '';
    check('there is a print stylesheet at all', printBlock.length > 400);
    check('it sets a page size and margins', /@page\s*\{[^}]*size:/.test(printBlock));
    const hidden = ['#topnav', '#sheet-bar', '#auth-widget', '#auth-overlay']
      .filter(sel => !printBlock.includes(sel));
    check('it hides the nav, the controls and the auth widget',
      hidden.length === 0, 'not hidden: ' + hidden.join(', '));
    check('it prints ink on paper rather than trusting the theme tokens',
      (printBlock.match(/background:\s*#fff\s*!important/g) || []).length >= 2
      && /color:\s*#000\s*!important/.test(printBlock),
      'a token redefined for a future theme must not be able to print white on white');
    check('and it keeps a block from being split across a page break',
      /break-inside:\s*avoid/.test(printBlock) && /page-break-inside:\s*avoid/.test(printBlock));
    check('the page offers a print button wired to a function that exists',
      /onclick="printSheet\(\)"/.test(pageHtml) && /function printSheet\(/.test(pageJs));
    check('the notes area is ruled lines rather than a blank box',
      /sh-rule/.test(pageJs) && /\.sh-rule\s*\{[^}]*height:/.test(pageCss),
      'the reason to print a sheet is to write on it');

    /* ── 7. read-only ── */
    check('the page has no save path of any kind',
      !/\.set\(|\.update\(|fsMergeSave|\.add\(|\.delete\(/.test(pageJs),
      'printing is a read; this page must never write a character');
    check('and the dashboard links to it',
      /href="sheet\.html"/.test(read('index.html')));
    check('a sheet can be linked to directly, so one can be sent to a player',
      /URLSearchParams\(location\.search\)/.test(pageJs) && /'\?c=' \+ encodeURIComponent/.test(pageJs));

    console.log(failures ? `\n>>> character sheet FAILED (${failures})`
      : `\n>>> character sheet OK (${characters.length} characters rendered)`);
    process.exit(failures ? 1 : 0);
  }
}
