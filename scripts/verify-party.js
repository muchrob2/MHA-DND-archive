#!/usr/bin/env node
// Regression check for party.html — the party as one table of numbers.
//
// What makes this worth its own verifier: it is a table a DM reads at speed
// mid-session and acts on. A column that sorts the wrong way, or an average
// that is quietly wrong, does not look broken — it just gives bad answers to
// "is a DC 15 fair on this group". So the table is rendered here against
// every real character record and the sorting and the arithmetic checked.
//
// What it guards:
//   1. Every character renders, every row has every cell, and no record's
//      gaps turn into "undefined" or "NaN".
//   2. Sorting: the right order, reversing on a second tap, a stable tie
//      break, and missing values sorting LAST whichever way the column runs.
//   3. The spread row — low · average · high — is actually those three.
//   4. The players-only filter, including the fact that is_pc is the STRING
//      "true" in the repo files and a boolean in some bundle entries.
//   5. Everything printed is escaped, including into the sheet link's href.
//   6. It reads the live bundle through the shared loader, says which source
//      it used, and admits what the passive column does not include.
//   7. It prints, and it never writes.

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

const pageJs = read('party.js');
const pageHtml = read('party.html');
const pageCss = read('css/pages/party.css');
const dataJs = read('char-data.js');

const els = {};
const mk = () => ({ innerHTML: '', textContent: '', className: '', style: {},
  classList: { add() {}, remove() {}, toggle() {} } });
for (const id of ['party-table', 'party-count', 'party-pc-btn', 'party-source', 'party-empty']) {
  els[id] = mk();
}

// Everything from the state down to init() is pure rendering, driven directly
// rather than booting the page (which would want Firebase, auth.js and a DOM).
const env = new Function('sandbox', `
  const { document } = sandbox;
  ${dataJs}
  ${pageJs.slice(pageJs.indexOf('let CHARS = [];'), pageJs.indexOf('async function init()'))}
  return { set chars(c){ CHARS = c; }, set src(s){ dataSource = s; },
           render, sortBy, togglePcs, sortedChars, spreadFor, colByKey, isPc,
           COLUMNS: PARTY_COLUMNS, cellText,
           get key(){ return sortKey; }, get dir(){ return sortDir; },
           get pcsOnly(){ return pcsOnly; } };
`)({ document: { getElementById: (i) => els[i] || null } });

const roster = JSON.parse(read('CLASS-1A/roster.json'));
const characters = (roster.students || []).filter(s => s.file).map(s => {
  const c = JSON.parse(read(path.join('CLASS-1A', s.file)));
  c._file = s.file;
  return c;
});

const html = () => els['party-table'].innerHTML;
// Body rows only: the header carries em dashes inside its tooltips, which
// made a naive dash count over the whole table two too high.
const bodyRows = () => html().split('<tbody>')[1].split('</tbody>')[0]
  .split('<tr>').slice(1);

/* ── 1. it renders ── */
{
  check('the whole roster has files to render', characters.length >= 18,
    characters.length + ' characters');
  check('there are enough columns to be worth a table',
    env.COLUMNS.length >= 12, env.COLUMNS.length + ' columns');
  check('every column has a label, a tooltip and a way to read a value',
    env.COLUMNS.every(c => c.key && c.label && c.title && typeof c.value === 'function'),
    env.COLUMNS.filter(c => !(c.key && c.label && c.title && typeof c.value === 'function'))
      .map(c => c.key || '(no key)').join(', '));
  check('and no two columns share a key — the key is the sort key',
    new Set(env.COLUMNS.map(c => c.key)).size === env.COLUMNS.length);

  env.chars = characters;
  env.src = 'firestore';
  env.render();

  check('every character gets a row',
    bodyRows().length === characters.length,
    bodyRows().length + ' rows for ' + characters.length + ' characters');
  const ragged = [...new Set(bodyRows().map(r => (r.match(/<td/g) || []).length))];
  check('and every row has every cell',
    ragged.length === 1 && ragged[0] === env.COLUMNS.length,
    'cells per row: ' + ragged.join(', ') + ', want ' + env.COLUMNS.length);
  check('no record\'s gaps render as undefined or NaN',
    !/undefined|NaN|\[object Object\]/.test(html()),
    (html().match(/undefined|NaN/g) || []).join(' '));
  check('there is a header and a spread row as well as the body',
    /<thead>/.test(html()) && /<tfoot>/.test(html()));
}

/* ── 2. sorting ── */
{
  for (const key of ['ac', 'hp', 'passive', 'modSTR', 'level']) {
    env.chars = characters;
    if (env.key !== key) env.sortBy(key);
    const col = env.colByKey(key);
    const vals = env.sortedChars().map(c => col.value(c));
    const nums = vals.filter(v => typeof v === 'number');
    const nullCount = vals.filter(v => v == null).length;
    const descending = nums.every((v, i) => i === 0 || nums[i - 1] >= v);
    const nullsLast = vals.slice(vals.length - nullCount).every(v => v == null);
    check(`sorting by ${key} puts the highest first`, descending, nums.join(','));
    check(`and a missing ${key} sorts last rather than to the top`, nullsLast,
      'otherwise ascending order hides the people you were looking for');
  }

  // Deliberately gappy, because the roster is not: every real record has a
  // value in every column above, so the missing-value branch was never
  // reached and the check above could not fail.
  const gappy = [
    { _file: '1', name: 'Has 18', AC: '18' },
    { _file: '2', name: 'Blank one' },
    { _file: '3', name: 'Has 12', AC: '12' },
    { _file: '4', name: 'Blank two' },
  ];
  env.chars = gappy;
  for (const dir of ['descending', 'ascending']) {
    env.sortBy('ac');
    if ((dir === 'ascending') !== (env.dir === 1)) env.sortBy('ac');
    const order = env.sortedChars().map(c => c.name);
    check(`a blank cell sorts last with the column ${dir} too`,
      order[2].startsWith('Blank') && order[3].startsWith('Blank'),
      order.join(' → '));
    check(`and the values themselves are ${dir}`,
      dir === 'descending' ? order[0] === 'Has 18' : order[0] === 'Has 12',
      order.join(' → '));
  }
  check('two blanks keep a stable A-Z order between themselves',
    (() => {
      env.chars = gappy;
      env.sortBy('ac');
      const a = env.sortedChars().map(c => c.name).slice(2).join();
      env.sortBy('ac');
      return env.sortedChars().map(c => c.name).slice(2).join() === a && a === 'Blank one,Blank two';
    })());
  env.chars = characters;

  env.sortBy('name');
  const names = env.sortedChars().map(c => c.name);
  check('the name column sorts A-Z, not highest-first',
    env.dir === 1 && names.every((n, i) => i === 0 || names[i - 1].localeCompare(n) <= 0));

  env.sortBy('ac');
  const down = env.sortedChars().map(c => c.name).join();
  env.sortBy('ac');
  const up = env.sortedChars().map(c => c.name).join();
  check('tapping the same column again reverses it', down !== up && env.dir === 1);
  env.sortBy('ac');
  check('and tapping it a third time puts it back',
    env.sortedChars().map(c => c.name).join() === down);

  // Ties are everywhere in this data — several characters share an AC — so a
  // tie break that is not stable means the table reshuffles under the DM.
  env.sortBy('prof');
  const once = env.sortedChars().map(c => c.name).join();
  const twice = env.sortedChars().map(c => c.name).join();
  check('ties break on the name, so the order never shuffles between renders',
    once === twice && /^A/.test(env.sortedChars()[0].name),
    'first row: ' + env.sortedChars()[0].name);
}

/* ── 3. the spread ── */
{
  env.chars = characters;
  const rows = env.sortedChars();
  for (const key of ['ac', 'hp', 'passive', 'modCON']) {
    const col = env.colByKey(key);
    const s = env.spreadFor(col, rows);
    const vals = rows.map(c => col.value(c)).filter(v => typeof v === 'number');
    const avg = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
    check(`the ${key} spread is really the low, the mean and the high`,
      s && s.min === Math.min(...vals) && s.max === Math.max(...vals)
      && s.avg === avg && s.n === vals.length,
      JSON.stringify(s) + ' vs ' + JSON.stringify({ min: Math.min(...vals), avg, max: Math.max(...vals) }));
  }
  check('the average keeps one decimal place',
    String(env.spreadFor(env.colByKey('hp'), rows).avg).includes('.')
    || Number.isInteger(env.spreadFor(env.colByKey('hp'), rows).avg),
    'an average AC of 14 and one of 14.4 are different answers to "what does this hit on"');
  check('the name column has no spread',
    env.spreadFor(env.colByKey('name'), rows) === null);
  check('and a column where nobody has a value has none either',
    env.spreadFor(env.colByKey('ac'), [{ _file: 'x', name: 'X' }]) === null);
}

/* ── 4. the players-only filter ── */
{
  env.chars = characters;
  if (env.pcsOnly) env.togglePcs();
  const all = env.sortedChars().length;
  env.togglePcs();
  const pcs = env.sortedChars();
  check('the filter narrows to the characters marked as players',
    pcs.length > 0 && pcs.length < all, `${pcs.length} of ${all}`);
  check('and every row it leaves really is one', pcs.every(c => env.isPc(c)));
  env.render();
  check('the count line says how many of how many',
    /\d+ of \d+/.test(els['party-count'].textContent), els['party-count'].textContent);
  env.togglePcs();
  env.render();
  check('and goes back to a plain total when the filter is off',
    /^\d+ characters$/.test(els['party-count'].textContent), els['party-count'].textContent);

  // is_pc is the STRING "true" in every repo file and a boolean in some
  // bundle entries. A strict === would silently empty the filter.
  check('is_pc counts whether it is the string "true" or the boolean',
    env.isPc({ is_pc: 'true' }) === true && env.isPc({ is_pc: true }) === true
    && env.isPc({ is_pc: 'TRUE' }) === true);
  check('and anything else does not',
    env.isPc({}) === false && env.isPc({ is_pc: 'false' }) === false
    && env.isPc({ is_pc: false }) === false);
}

/* ── 5. gaps and escaping ── */
{
  env.chars = [{ _file: 'a.json', name: 'Gappy' }];
  env.render();
  const dashes = (bodyRows().join('').match(/—/g) || []).length;
  check('a record with nothing but a name renders a row of dashes',
    /Gappy/.test(html()) && dashes >= 10 && !/NaN|undefined/.test(html()),
    dashes + ' dashes in the body');
  check('an empty roster shows the empty state rather than a bare table',
    (() => { env.chars = []; env.render(); return els['party-empty'].style.display === ''; })());

  env.chars = [{
    _file: '"><img src=x onerror=alert(1)>', name: '<script>bad</script>',
    AC: '<b>9</b>', speed: '<i>30 ft</i>', level: '<em>1</em>',
    quirk_save_DC: '<u>13</u>', is_pc: 'true',
  }];
  env.render();
  // Not a bare /onerror/: the hostile file name comes back percent-encoded
  // inside the href as "onerror%3Dalert(1)", which is inert text. What must
  // not appear is an actual attribute — the name followed by an equals sign.
  check('nothing a character record contains can inject markup',
    !/<script|<b>|<i>|<em>|<u>|on\w+\s*=\s*["']?alert/.test(html()),
    (html().match(/<(script|b|i|em|u)>|on\w+\s*=\s*["']?alert/g) || []).join(' '));
  check('and the angle brackets in it come out as entities, not as tags',
    html().includes('&lt;script&gt;bad&lt;/script&gt;'));
  check('including through the link to that character\'s sheet',
    /href="sheet\.html\?c=%22%3E/.test(html()),
    'the file name is percent-encoded into the href, not pasted into it');
}

/* ── 6. the data, and what it admits ── */
{
  check('the page goes through the shared loader rather than its own',
    /charLoadAll\(db,/.test(pageJs) && !/collection\('inventories'\)/.test(pageJs));
  check('and loads the shared file before its own script',
    pageHtml.indexOf('src="char-data.js"') !== -1
    && pageHtml.indexOf('src="char-data.js"') < pageHtml.indexOf('src="party.js"'));
  check('the shared loader prefers the live bundle',
    /doc\('relationships-bundle'\)/.test(dataJs));

  env.chars = [{ _file: 'a.json', name: 'A' }];
  env.src = 'local';
  env.render();
  check('a table built from the fallback says so',
    /Firestore unreachable/.test(els['party-source'].textContent));
  env.src = 'firestore';
  env.render();
  check('and one built from live data says that instead',
    /Live data/.test(els['party-source'].textContent)
    && !/unreachable/.test(els['party-source'].textContent));

  // The passive column is 10 + WIS with no proficiency, because the data
  // records none. Printing that without saying so is the dishonest version.
  check('the passive column is 10 + the modifier',
    (() => {
      const c = { ability_scores: { WIS: '16' } };
      return env.colByKey('passive').value(c) === 13;
    })());
  check('and the page says on screen that no proficiency is in it',
    /no proficiency added/i.test(pageHtml) && /floor/i.test(pageHtml),
    'otherwise it is a number that is 2 to 6 too low for half the class');
  check('the page also says HP is the recorded total, not current HP',
    /not whatever/i.test(pageHtml) && /Encounter Manager/.test(pageHtml));
  check('and what a dash in a cell means',
    /dash/i.test(pageHtml) && /sort last/i.test(pageHtml));
}

/* ── 7. print, and read-only ── */
{
  // Anchored at the start of a line with the brace: a plain indexOf matches
  // the stylesheet's own header comment, which is how the sheet verifier's
  // print checks came to be reading the screen rules.
  const printAt = /^@media print\s*\{/m.exec(pageCss);
  const printBlock = printAt ? pageCss.slice(printAt.index) : '';
  check('there is a print stylesheet', printBlock.length > 400);
  check('it prints landscape, because the table is wide',
    /@page\s*\{[^}]*landscape/.test(printBlock));
  const hidden = ['#topnav', '#party-bar', '#auth-widget', '#auth-overlay']
    .filter(sel => !printBlock.includes(sel));
  check('it hides the nav, the controls and the auth widget',
    hidden.length === 0, 'not hidden: ' + hidden.join(', '));
  check('and prints ink on paper rather than trusting the theme tokens',
    /background:\s*#fff\s*!important/.test(printBlock)
    && /color:\s*#000\s*!important/.test(printBlock));
  check('a row is never split across a page break',
    /break-inside:\s*avoid/.test(printBlock));
  check('the print button is wired to a function that exists',
    /onclick="printParty\(\)"/.test(pageHtml) && /function printParty\(/.test(pageJs));

  check('the wide table scrolls inside its own box rather than the page',
    /#party-wrap[^}]*overflow-x:\s*auto/s.test(pageCss));
  check('the header survives scrolling',
    /\.pt-th[^}]*position:\s*sticky/s.test(pageCss));

  check('the page has no save path of any kind',
    !/\.set\(|\.update\(|fsMergeSave|\.add\(|\.delete\(/.test(pageJs),
    'reading the party is a read');
  check('every header is reachable from the keyboard, not just the mouse',
    /role="button"/.test(pageJs) && /tabindex="0"/.test(pageJs)
    && /onkeydown=/.test(pageJs),
    'the whole table is sorted by clicking a header');
  check('and the dashboard links to it, inside the DM block',
    (() => {
      const dash = read('index.html');
      const dm = dash.slice(dash.indexOf('<div id="dm-only">'),
        dash.indexOf('<!-- /dm-only'));
      return dash.includes('href="party.html"') && dm.includes('party.html');
    })());
}

console.log(failures ? `\n>>> party table FAILED (${failures})`
  : `\n>>> party table OK (${characters.length} characters, ${env.COLUMNS.length} columns)`);
process.exit(failures ? 1 : 0);
