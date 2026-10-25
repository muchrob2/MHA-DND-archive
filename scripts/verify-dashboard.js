#!/usr/bin/env node
// Regression check for the dashboard's "where you left off" strip
// (index.html + index.js).
//
// What it guards:
//   1. The strip is inside #dm-only. "Next time" is the DM's note to
//      themselves and routinely a spoiler; on a shared screen in player mode
//      it must not render at all.
//   2. The Firestore REST payload is unwrapped correctly. This page loads no
//      Firebase SDK on purpose, so the typed-value shape is parsed by hand —
//      which is exactly the kind of code that silently returns undefined.
//   3. The latest session is the latest one, including when nobody numbered
//      them.
//   4. Nothing a human typed into the log comes back out as markup.
//   5. A failed request leaves the strip hidden rather than showing an error
//      where a recap should be.

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

function makeEl() {
  return {
    style: {}, dataset: {}, innerHTML: '', textContent: '', title: '', value: '',
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); },
      toggle(c, on) { if (on === undefined ? this._set.has(c) : !on) this._set.delete(c); else this._set.add(c); },
      contains(c) { return this._set.has(c); },
    },
    addEventListener() {},
  };
}

function boot({ fetchImpl } = {}) {
  const els = new Map();
  for (const m of read('index.html').matchAll(/id="([^"${]+)"/g)) els.set(m[1], makeEl());
  const sandbox = {
    document: {
      getElementById: (id) => { if (!els.has(id)) els.set(id, makeEl()); return els.get(id); },
      querySelectorAll: () => [],
      addEventListener() {},
      body: { classList: makeEl().classList },
    },
    window: { scrollTo() {}, location: { href: '' } },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: fetchImpl || (() => Promise.reject(new Error('offline'))),
    setTimeout: (fn) => fn,
    console,
  };
  const api = new Function('sandbox', `
    const { document, window, sessionStorage, fetch, setTimeout, console } = sandbox;
    ${read('index.js')}
    return { fsValue, latestSession, renderLastSession, loadLastSession };
  `)(sandbox);
  api._els = els;
  return api;
}

/* ── 1. the strip is DM-only ── */
{
  const page = read('index.html');
  const dmStart = page.indexOf('<div id="dm-only">');
  const strip = page.indexOf('id="last-session"');
  check('the dashboard has a slot for the strip', strip !== -1);
  check('and it is inside the DM-only block, so a player screen never renders it',
    dmStart !== -1 && strip > dmStart, `dm-only at ${dmStart}, strip at ${strip}`);
  check('the strip starts hidden', /id="last-session" class="hidden"/.test(page));
  check('the dashboard still loads no Firebase SDK for this',
    !/firebasejs/.test(page) && !/auth\.js/.test(page),
    'the point of reading the log over REST is that this page stays dependency-free');
}

/* ── 2. the REST shape ── */
{
  const env = boot();
  check('a string comes back as a string', env.fsValue({ stringValue: 'Dockside' }) === 'Dockside');
  check('an integer comes back as a number', env.fsValue({ integerValue: '7' }) === 7);
  check('a null comes back as null', env.fsValue({ nullValue: null }) === null);
  check('an unknown wrapper comes back as undefined rather than as an object',
    env.fsValue({ timestampValue: '2026-10-25T00:00:00Z' }) === undefined);
  const payload = {
    arrayValue: {
      values: [
        { mapValue: { fields: {
          id: { stringValue: 's1' }, number: { integerValue: '6' },
          title: { stringValue: 'The Cage' }, date: { stringValue: '2026-10-17' },
          next: { stringValue: 'The Black Corner wants a word' },
          present: { arrayValue: { values: [{ integerValue: '4' }, { integerValue: '9' }] } },
        } } },
      ],
    },
  };
  const sessions = env.fsValue(payload);
  check('a session array unwraps into plain objects',
    Array.isArray(sessions) && sessions.length === 1 && sessions[0].title === 'The Cage'
    && sessions[0].number === 6, JSON.stringify(sessions));
  check('and a nested array of ids inside one of them unwraps too',
    JSON.stringify(sessions[0].present) === '[4,9]', JSON.stringify(sessions[0].present));
  check('an empty document unwraps to nothing rather than throwing',
    env.fsValue(undefined) === undefined && env.fsValue({}) === undefined);
}

/* ── 3. which session is the latest ── */
{
  const env = boot();
  const pick = (arr) => env.latestSession(arr);
  check('the highest session number wins',
    pick([{ number: 2, title: 'b' }, { number: 11, title: 'k' }, { number: 7, title: 'g' }]).title === 'k');
  check('a tie on number falls back to the later date',
    pick([{ number: 3, date: '2026-01-02', title: 'early' }, { number: 3, date: '2026-05-02', title: 'late' }]).title === 'late');
  check('an unnumbered log still picks something rather than nothing',
    pick([{ title: 'only one' }]).title === 'only one');
  check('and a log of nothing picks nothing', pick([]) === null);
}

/* ── 4. rendering, and escaping ── */
{
  const env = boot();
  const el = env._els.get('last-session');
  env.renderLastSession({ number: 6, date: '2026-10-17', title: 'The Cage', next: 'The Black Corner wants a word' });
  check('the strip shows the number, the title and the next-time line',
    el.innerHTML.includes('Session 6') && el.innerHTML.includes('The Cage')
    && el.innerHTML.includes('Next time') && el.innerHTML.includes('Black Corner'),
    el.innerHTML.replace(/\s+/g, ' ').slice(0, 220));
  check('and it is shown rather than left hidden', !el.classList.contains('hidden'));
  check('it links to the log', el.innerHTML.includes('href="session-log.html"'));

  env.renderLastSession({ number: 7, title: 'No hook yet' });
  check('a session with no next-time note shows no next-time block',
    !env._els.get('last-session').innerHTML.includes('Next time'));

  env.renderLastSession({ number: 8, title: '<img src=x onerror=alert(1)>', next: '5 < 6 & "quoted"' });
  const html = env._els.get('last-session').innerHTML;
  check('nothing a human typed into the log comes back out as markup',
    !html.includes('<img') && html.includes('&lt;img'), html.slice(0, 200));
  check('and the characters survive as text', html.includes('&amp;') && html.includes('&quot;'));
}

/* ── 5. when the request fails ── */
{
  const env = boot({ fetchImpl: () => Promise.reject(new Error('offline')) });
  // loadLastSession already ran at load against the rejecting fetch.
  const el = env._els.get('last-session');
  check('a failed request leaves the strip hidden and empty',
    el.innerHTML === '', JSON.stringify(el.innerHTML).slice(0, 80));

  const env2 = boot({ fetchImpl: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ fields: { sessions: { arrayValue: {} } } }) }) });
  check('and so does a log with no sessions in it yet',
    env2._els.get('last-session').innerHTML === '');

  const src = read('index.js');
  check('the REST read is world-readable data only — the session log doc',
    /documents\/mha-dnd\/session-log/.test(src));
  check('and it does not send credentials it has not got',
    !/Authorization/i.test(src));
}

console.log(failures ? `\n>>> dashboard FAILED (${failures})` : '\n>>> dashboard OK');
process.exit(failures ? 1 : 0);
