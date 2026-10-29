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

/* ── The grouping ───────────────────────────────────────────────────
   The hub reached seventeen cards in two undifferentiated grids — nine in
   one — and at that size a grid is a wall: nothing for the eye to land on,
   and every card has to be read. They are grouped by WHEN you use them now,
   and the thing worth guarding is that the grouping stays complete: a card
   added to the page and not to a group would simply not appear.
   ─────────────────────────────────────────────────────────────────── */
{
  const page = read('index.html');
  const groups = page.split('<div class="hub-group">').slice(1).map((chunk) => {
    const end = chunk.indexOf('</section>');
    return [null, end === -1 ? chunk : chunk.slice(0, end)];
  });
  check('the cards are grouped rather than in one wall of a grid',
    groups.length >= 5, groups.length + ' groups');

  const named = [...page.matchAll(/hub-group-name">([^<]+)</g)].map(m => m[1]);
  check('every group is named',
    named.length === groups.length, named.join(', '));
  check('and each one says what it is for, because a label alone is not a reason',
    (page.match(/hub-group-hint">/g) || []).length === groups.length);
  check('the groups are the ones a player and a DM actually reach for',
    ['At the table', 'Your character', 'Between sessions',
      'Running a session', 'The campaign'].every(n => named.includes(n)),
    named.join(', '));

  // Every hero card has to be inside a group, or it is on the page and in
  // no grid — which renders nothing.
  const allCards = [...page.matchAll(/<a class="card-hero[^"]*"[^>]*?href="([^"]+)"/g)].map(m => m[1]);
  const grouped = groups.flatMap(g =>
    [...g[1].matchAll(/<a class="card-hero[^"]*"[^>]*?href="([^"]+)"/g)].map(m => m[1]));
  const orphan = allCards.filter(h => !grouped.includes(h));
  check('no card is on the page but outside every group',
    orphan.length === 0, orphan.join(', '));
  check('and none is listed twice',
    new Set(grouped).size === grouped.length,
    grouped.filter((h, i) => grouped.indexOf(h) !== i).join(', '));
  check('there are as many cards as there are pages to reach',
    allCards.length >= 16, allCards.length + ' cards');

  // Every destination has to exist. A card pointing at a page that is not
  // there is the one dashboard fault a reader finds before the DM does.
  const missing = allCards.concat(
    [...page.matchAll(/<a class="card-sm[^"]*"[^>]*?href="([^"]+)"/g)].map(m => m[1]))
    .map(h => decodeURIComponent(h.split('#')[0]))
    .filter(h => !/^https?:/.test(h))
    .filter(h => !fs.existsSync(path.join(repoRoot, h)));
  check('every card points at a page that exists', missing.length === 0, missing.join(', '));

  // The split that matters: a player must not see the DM's cards.
  const dmStart = page.indexOf('<div id="dm-only">');
  // Structural, not a label — see the note in verify-rules.js.
  const dmEnd = page.indexOf('<!-- /dm-only');
  check('the DM block carries an explicit end marker',
    dmEnd > page.indexOf('<div id="dm-only">'),
    'without it indexOf gives -1 and slice(start, -1) runs to the end of the '
    + 'page, so the "DM block" swallows the whole dashboard — which is how '
    + 'three checks in three files broke at once');
  const dmBlock = page.slice(dmStart, dmEnd);
  for (const dmPage of ['tonight.html', 'session-log.html', 'loot.html', 'party.html',
    'campaigns.html', 'campaign-overview.html', 'characters.html', 'CLASS-1A/encounter.html']) {
    check(`${dmPage} is inside the DM block`, dmBlock.includes('href="' + dmPage + '"'));
  }
  for (const playerPage of ['table.html', 'lab.html', 'heat.html', 'freetime.html',
    'sheet.html', 'heropad.html', 'shop.html', 'CLASS-1A/board.html']) {
    check(`${playerPage} is not`, !dmBlock.includes('href="' + playerPage + '"'));
  }

  const css = read('css/pages/index.css');
  check('the sections are given room rather than eight pixels',
    (() => {
      const m = css.match(/\.hub-section \+ \.hub-section \{ margin-top: (\d+)px/);
      return m && Number(m[1]) >= 32;
    })(), (css.match(/\.hub-section \+ \.hub-section \{ margin-top: (\d+)px/) || [])[1] + 'px');
  for (const sel of ['.hub-head', '.hub-group-name', '.hub-group-hint', '.section-sub']) {
    check(`${sel} is styled`, css.includes(sel));
  }
}

/* ── The glance strip ───────────────────────────────────────────────
   Whether a fight is running and how much attention Byakko are paying. It
   is NOT in the DM block: both documents are world-readable by design, and
   those two facts are what a player most wants before opening anything.
   ─────────────────────────────────────────────────────────────────── */
{
  const page = read('index.html');
  const glance = page.indexOf('id="glance"');
  check('the dashboard has a slot for the glance strip', glance !== -1);
  check('it starts hidden, so nothing flashes before the read lands',
    /id="glance" class="glance hidden"/.test(page));
  check('and it is outside the DM block — a player wants these two most',
    glance !== -1 && glance < page.indexOf('<div id="dm-only">'));

  const els = {};
  const mk = () => ({ innerHTML: '', textContent: '', className: '', style: {},
    classList: { _s: new Set(['hidden']), add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); }, toggle() {} } });
  for (const id of ['glance', 'last-session', 'version-badge', 'last-updated',
    'last-updated-text', 'header-label']) els[id] = mk();
  const DOCS = {};
  const strip = new Function('sandbox', `
    const { document, fetch, console, localStorage } = sandbox;
    ${read('index.js').replace(/^\(function[\s\S]*?\{/, '').replace(/\}\)\(\);\s*$/, '')}
    return { loadGlance, heatMood };
  `)({
    document: { getElementById: (i) => els[i] || null, addEventListener() {},
      querySelectorAll: () => [], body: { classList: { add() {}, remove() {} } } },
    fetch: (url) => {
      const name = url.split('/').pop();
      if (!(name in DOCS)) return Promise.resolve({ ok: false });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ fields: DOCS[name] }) });
    },
    console: { error() {}, log() {} },
    localStorage: { getItem: () => null, setItem() {} },
  });

  const S = (v) => ({ stringValue: v });
  const I = (v) => ({ integerValue: String(v) });
  const A = (v) => ({ arrayValue: { values: v } });
  const M = (v) => ({ mapValue: { fields: v } });
  const G = () => els.glance.innerHTML.replace(/\s+/g, ' ');
  const reset = () => { els.glance.innerHTML = ''; els.glance.classList.add('hidden'); };
  const clearDocs = () => { for (const k of Object.keys(DOCS)) delete DOCS[k]; };

  return (async () => {
    reset(); clearDocs();
    await strip.loadGlance();
    check('with nothing happening the strip is absent, not empty',
      els.glance.classList.contains('hidden') && G() === '',
      'a quiet strip must mean a quiet table rather than a failed read');

    reset(); clearDocs();
    DOCS['encounter-state'] = { round: I(3), currentIndex: I(1), combatants: A([
      M({ name: S('First'), id: S('a') }), M({ name: S('Second'), id: S('b') })]) };
    await strip.loadGlance();
    check('a running fight says whose turn it is and which round',
      /Second\u2019s turn/.test(G()) && /round 3/.test(G()), G().slice(0, 110));
    check('and links to the page that shows the order',
      /href="table\.html"/.test(G()));

    // The index points into the DM's own ordering and can be out of range
    // when a combatant is removed mid-fight.
    reset(); clearDocs();
    DOCS['encounter-state'] = { round: I(1), currentIndex: I(99), combatants: A([M({ name: S('Only One') })]) };
    await strip.loadGlance();
    check('an index past the end wraps rather than blanking the row',
      /Only One/.test(G()));
    reset(); clearDocs();
    DOCS['encounter-state'] = { round: I(1), currentIndex: I(0), combatants: A([]) };
    DOCS.heat = { heat: I(0) };
    await strip.loadGlance();
    check('an encounter with nobody in it shows no fight row',
      !/table\.html/.test(G()) && /heat\.html/.test(G()));

    const bands = [[0, 'quiet'], [3, 'quiet'], [4, 'warm'], [7, 'warm'], [8, 'hot'], [10, 'hot']];
    const wrongBand = bands.filter(([h, want]) => strip.heatMood(h) !== want);
    check('the Heat row is coloured by band — quiet, warming, hot',
      wrongBand.length === 0,
      wrongBand.map(([h, w]) => `${h} → ${strip.heatMood(h)}, want ${w}`).join(' | '));

    reset(); clearDocs();
    DOCS.heat = { heat: I(9), beaten: M({ a: M({ at: I(1) }), b: M({ at: I(2) }) }) };
    await strip.loadGlance();
    check('and says the level and how many named Byakko are beaten',
      /9 of 10/.test(G()) && /2 beaten/.test(G()), G().slice(0, 110));

    reset(); clearDocs();
    DOCS['encounter-state'] = { round: I(2), currentIndex: I(0), combatants: A([M({ name: S('Somebody') })]) };
    DOCS.heat = { heat: I(5) };
    await strip.loadGlance();
    check('both rows together, the fight first',
      (G().match(/glance-item/g) || []).length === 2
      && G().indexOf('table.html') < G().indexOf('heat.html'));

    reset(); clearDocs();
    DOCS['encounter-state'] = { round: S('<b>3</b>'), currentIndex: I(0),
      combatants: A([M({ name: S('<img src=x onerror=alert(1)>') })]) };
    await strip.loadGlance();
    const tags = G().match(/<(script|img|b|i)[ >/]/g) || [];
    check('nothing in the encounter can become a tag on the dashboard',
      tags.length === 0, [...new Set(tags)].join(' '));
    check('and it comes back as entities', G().includes('&lt;img src=x'));

    check('the dashboard still loads no Firebase SDK for any of this',
      !/firebasejs/.test(page), 'two live numbers are not worth an SDK');
    for (const sel of ['.glance', '.glance-item.mood-hot', '.glance-value']) {
      check(`${sel} is styled`, read('css/pages/index.css').includes(sel));
    }

    console.log(failures ? `\n>>> dashboard FAILED (${failures})` : '\n>>> dashboard OK');
    process.exit(failures ? 1 : 0);
  })();
}

console.log(failures ? `\n>>> dashboard FAILED (${failures})` : '\n>>> dashboard OK');
process.exit(failures ? 1 : 0);
