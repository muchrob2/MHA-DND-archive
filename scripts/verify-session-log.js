#!/usr/bin/env node
// Regression check for the session log (session-log.html + session-log.js).
// Same shape as the other verify-* scripts here: no test runner, no
// dependencies, run it with `node scripts/verify-session-log.js`.
//
// What it guards:
//   1. The richer session entry — who was at the table, which arc, who they
//      met, where they went, what opens the next one — round-trips from the
//      form to the card, and an entry written before any of those fields
//      existed still renders.
//   2. Attendance is stored as roster ids and resolved to names at render
//      time, so renaming a character in the roster reads correctly on every
//      session they were ever at. The archive has form on renames.
//   3. The per-player counts are derived from those ids and never stored.
//   4. Search matches across every field, and needs every word.
//   5. Everything a human typed is escaped on the way back out.
//   6. Sessions still merge per item on save, so two people logging different
//      sessions at once don't overwrite each other.

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

/* ── a DOM thin enough to run the real page logic against ── */
function makeEl(id) {
  return {
    id, style: {}, dataset: {}, innerHTML: '', textContent: '', value: '', checked: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, appendChild() {}, focus() {},
  };
}

function boot() {
  const els = new Map();
  // Every id the real page has, plus the per-session ids the form writes,
  // which are created on demand below.
  for (const m of read('session-log.html').matchAll(/id="([^"${]+)"/g)) els.set(m[1], makeEl(m[1]));

  const sandbox = {
    document: {
      getElementById: (id) => {
        if (!els.has(id)) els.set(id, makeEl(id));   // form fields, per session
        return els.get(id);
      },
      querySelectorAll: () => [],
      addEventListener() {},
      body: {},
    },
    window: { scrollTo() {} },
    alert() {}, confirm: () => true, console,
    fetch: (url) => Promise.resolve({ json: () => JSON.parse(read(url)) }),
    firebase: {
      firestore: () => ({
        collection: () => ({
          doc: () => ({
            get: async () => ({ exists: false, data: () => ({}) }),
            onSnapshot: () => {},
          }),
        }),
      }),
    },
    fbAuthReady: Promise.resolve(),
    fsMergeSave: async (_doc, data) => JSON.parse(JSON.stringify(data)),
    setTimeout: (fn) => fn,
  };

  const factory = new Function('sandbox', `
    const { document, window, alert, confirm, console, fetch, firebase,
            fbAuthReady, fsMergeSave, setTimeout } = sandbox;
    ${read('session-log.js')}
    return {
      get data() { return data; },
      set data(v) { data = v; },
      get PLAYERS() { return PLAYERS; },
      set PLAYERS(v) { PLAYERS = v; },
      set canWrite(v) { canWrite = v; },
      render, cardHtml, formHtml, readForm, sessionMatches, sessionPresent,
      playerName, renderAttendance, chipsHtml, formatDate, loadPlayers,
    };
  `);
  const api = factory(sandbox);
  api._els = els;
  return api;
}

const roster = JSON.parse(read('CLASS-1A/roster.json'));
const pcs = (roster.students || []).filter(s => s.is_pc);

/* ── 1. the players come from the roster ── */
{
  check('the class roster has player characters to take attendance for',
    pcs.length >= 2, pcs.length + ' marked is_pc');

  const env = boot();
  env.PLAYERS = pcs.map(s => ({ id: s.id, name: s.name }));
  check('a roster id resolves to the name on the roster',
    env.playerName(pcs[0].id) === pcs[0].name, env.playerName(pcs[0].id));
  check('and an id nobody on the roster has degrades to the id rather than to blank',
    env.playerName(9999) === '#9999', env.playerName(9999));
}

/* ── 2. the form round-trips every field ── */
{
  const env = boot();
  env.PLAYERS = pcs.map(s => ({ id: s.id, name: s.name }));
  // Fill the new-session form the way a DM would.
  const set = (name, value) => { env._els.get('f-' + name + '-new') || env._els.set('f-' + name + '-new', makeEl()); env._els.get('f-' + name + '-new').value = value; };
  set('number', '7');
  set('date', '2026-10-24');
  set('title', 'The Cage, floor by floor');
  set('arc', 'After Hours — Chapter 6');
  set('recap', 'They talked their way in and fought their way out.');
  set('npcs', 'Madame Tsuru, Hinge');
  set('places', 'The Cage, Ginza');
  set('xp', '1200');
  set('loot', 'A white van, briefly');
  set('next', 'The Black Corner wants a word');
  const box = makeEl();
  box.checked = true;
  env._els.set(`f-present-new-${pcs[0].id}`, box);

  const fields = env.readForm('new');
  check('the form reads back every field it offers',
    fields.title === 'The Cage, floor by floor' && fields.arc === 'After Hours — Chapter 6'
    && fields.npcs === 'Madame Tsuru, Hinge' && fields.places === 'The Cage, Ginza'
    && fields.next === 'The Black Corner wants a word' && fields.xp === 1200,
    JSON.stringify(fields));
  check('attendance comes back as roster ids, not names',
    JSON.stringify(fields.present) === JSON.stringify([pcs[0].id]), JSON.stringify(fields.present));

  const card = env.cardHtml(Object.assign({ id: 's1' }, fields));
  check('the card shows who was there, by their current name',
    card.includes(pcs[0].name), card.slice(0, 200));
  check('and shows the arc, the people, the places and the next-time note',
    card.includes('After Hours') && card.includes('Madame Tsuru') && card.includes('Ginza')
    && card.includes('Next time') && card.includes('The Black Corner wants a word'));
}

/* ── 3. an entry from before any of this existed ── */
{
  const env = boot();
  env.PLAYERS = pcs.map(s => ({ id: s.id, name: s.name }));
  const old = { id: 'old', number: 1, date: '2026-01-05', title: 'First session', recap: 'It began.', xp: 300, loot: '' };
  let err = null;
  let card = '';
  try { card = env.cardHtml(old); } catch (e) { err = e.message; }
  check('a session logged before attendance existed still renders', err === null, err);
  check('and shows no attendance row rather than an empty one',
    !card.includes('present-row'), card.slice(0, 160));
  check('sessionPresent treats a missing list as nobody',
    JSON.stringify(env.sessionPresent(old)) === '[]');
}

/* ── 4. the per-player counts ── */
{
  const env = boot();
  env.PLAYERS = pcs.map(s => ({ id: s.id, name: s.name }));
  const bar = env._els.get('attendance-bar');
  env.data = { sessions: [
    { id: 'a', number: 1, title: 'One', present: [pcs[0].id, pcs[1].id] },
    { id: 'b', number: 2, title: 'Two', present: [pcs[0].id] },
  ] };
  env.renderAttendance();
  check('the attendance bar counts the sessions each player was at',
    bar.innerHTML.includes('<b>2</b>') && bar.innerHTML.includes('<b>1</b>'),
    bar.innerHTML.replace(/\s+/g, ' ').slice(0, 220));
  check('and is shown once some session records it', bar.style.display === '');

  env.data = { sessions: [{ id: 'a', number: 1, title: 'One' }] };
  env.renderAttendance();
  check('with nobody ticked anywhere it hides itself instead of showing zeroes',
    bar.style.display === 'none', bar.style.display);
}

/* ── 5. the empty state says the right thing ── */
{
  const env = boot();
  env.PLAYERS = [];
  const empty = env._els.get('empty-state');
  env.data = { sessions: [{ id: 'a', number: 1, title: 'Dockside' }] };
  env._els.get('log-search').value = 'helicopter';
  env.render();
  check('a search with no hits says so', /matches that/.test(empty.innerHTML), empty.innerHTML);
  env.data = { sessions: [] };
  env.render();
  check('and an empty log goes back to saying the log is empty — not that the search missed',
    /No sessions logged yet/.test(empty.innerHTML), empty.innerHTML);
}

/* ── 6. search ── */
{
  const env = boot();
  env.PLAYERS = pcs.map(s => ({ id: s.id, name: s.name }));
  const s = { id: 'x', number: 4, date: '2026-05-02', title: 'Dockside',
    recap: 'Containers, and a man with a ledger.', npcs: 'Kajiura', places: 'Musutafu docks',
    present: [pcs[0].id] };
  check('search finds a word from the recap', env.sessionMatches(s, 'ledger'));
  check('and from an NPC', env.sessionMatches(s, 'kajiura'));
  check('and from a place', env.sessionMatches(s, 'docks'));
  check('and from who was there', env.sessionMatches(s, pcs[0].name.split(' ')[0].toLowerCase()));
  check('every word has to match, not just one',
    env.sessionMatches(s, 'ledger docks') && !env.sessionMatches(s, 'ledger helicopter'));
  check('an empty search matches everything', env.sessionMatches(s, ''));
}

/* ── 7. escaping and the save path ── */
{
  const env = boot();
  env.PLAYERS = [];
  const nasty = { id: 'n', number: 9, title: '<img src=x onerror=alert(1)>',
    recap: '5 < 6 & "quoted"', npcs: '<script>', places: '', next: '<b>bold</b>' };
  const card = env.cardHtml(nasty);
  check('nothing a human typed comes back out as markup',
    !card.includes('<img') && !card.includes('<script>') && !card.includes('<b>bold</b>'),
    card.slice(0, 200));
  check('and the characters survive as text',
    card.includes('&lt;img') && card.includes('&amp;') && card.includes('&quot;'));

  const src = read('session-log.js');
  check('sessions still merge per item on save, so two people logging at once do not overwrite each other',
    /\{\s*path:\s*'sessions',\s*idKey:\s*'id'\s*\}/.test(src));
  check('the attendance list is read from the roster rather than hard-coded here',
    /roster\.json/.test(src) && /is_pc/.test(src));
  check('the page has somewhere to search from and somewhere to show the counts',
    read('session-log.html').includes('id="log-search"')
    && read('session-log.html').includes('id="attendance-bar"'));
}

console.log(failures ? `\n>>> session log FAILED (${failures})` : '\n>>> session log OK');
process.exit(failures ? 1 : 0);
