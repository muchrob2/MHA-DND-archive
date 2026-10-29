#!/usr/bin/env node
// Regression check for table.html — the fight from a player's seat.
//
// Why it needs one: this page is read at arm's length while something is
// happening, and it makes two promises that are easy to break silently.
//
//   1. It will tell you whose turn it is and whether you are next. The
//      Encounter Manager keeps `combatants` sorted and points `currentIndex`
//      into it, so this page must NOT re-sort — re-sorting renumbers the
//      turns and the index then points at somebody else.
//   2. It will not tell you an enemy's exact hit points. The DM has those;
//      a player screen printing "14 of 30" takes the guessing out of every
//      fight. Enemies get a band and the page says so.
//
// It also guards the thing the condition work was for: where a condition
// changes an attack roll, the page says so for whoever is up now, out of the
// same table the DM's tracker rolls against.

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

const pageJs = read('table.js');
const pageHtml = read('table.html');
const pageCss = read('css/pages/table.css');

const els = {};
const mk = () => ({ innerHTML: '', textContent: '', style: {} });
for (const id of ['tb-header', 'tb-order', 'tb-log', 'tb-hp-note', 'tb-exact-btn', 'tb-count']) {
  els[id] = mk();
}
const ACCESS = { admin: false, owned: [] };

const env = new Function('sandbox', `
  const { document, console } = sandbox;
  ${read('rules-data.js')}
  const firebase = { firestore: () => ({ collection: () => ({ doc: () => ({
    get: () => Promise.resolve({ exists: false }), onSnapshot() {} }) }) }) };
  const fbAuthReady = Promise.resolve();
  const window = { isAdmin: () => sandbox.admin(), canEdit: (k) => sandbox.owned().includes(k) };
  function fbCharacterKey(t, n) { return t + '::' + n; }
  const fetch = () => Promise.reject(new Error('no network in the harness'));
  ${pageJs.slice(0, pageJs.lastIndexOf('(async () => {'))}
  return { render, toggleExact, order, current, upNext, currentIdx, isMine, hpBand,
           hpText, hpFraction, attackAdviceOn, conditionTitle, HP_BANDS,
           get enc() { return enc; }, set enc(v) { enc = v; },
           set loaded(v) { loaded = v; }, set mine(v) { mineNames = v; },
           set dm(v) { isDm = v; }, set exact(v) { showExact = v; },
           get exact() { return showExact; } };
`)({
  document: { getElementById: (i) => els[i] || null },
  console: { error() {}, log() {} },
  admin: () => ACCESS.admin,
  owned: () => ACCESS.owned,
});

const C = (name, init, hp, max, team, pc, conds) =>
  ({ id: name, name, initiative: init, hp, maxHp: max, ac: 13, team, isPC: pc, conditions: conds || [] });

const H = () => els['tb-header'].innerHTML;
const O = () => els['tb-order'].innerHTML;
const L = () => els['tb-log'].innerHTML;

env.loaded = true;

/* ── 1. whose turn, and the order ── */
{
  env.enc = { round: 1, currentIndex: 0, combatants: [], attackLog: [] };
  env.render();
  check('with no fight running the page says so rather than showing an empty list',
    /No fight running/.test(H()) && /leave this open/i.test(H()));

  const fight = {
    round: 3,
    currentIndex: 1,
    attackLog: [],
    combatants: [
      C('First', 18, 37, 37, 0, true),
      C('Second', 15, 9, 30, 0, true, ['Prone']),
      C('Third', 12, 14, 30, 1, false, ['Restrained']),
      C('Fourth', 9, 0, 40, 1, false, ['Unconscious']),
      C('Fifth', 4, 30, 30, 1, false),
    ],
  };
  env.enc = fight;
  env.mine = ['Second'];
  env.render();

  check('the round is shown', /Round 3/.test(H()));
  check('and whose turn it is', /tb-now-name">Second</.test(H().replace(/\s+/g, '')));
  check('when it is yours the page says so and marks itself',
    /Your turn/.test(H()) && /is-yours/.test(H()));
  check('and names who is next', /Next · Third/.test(H().replace(/\s+/g, ' ')));

  // The order is the array as it arrives. Re-sorting here would renumber the
  // turns and currentIndex would then point at somebody else.
  check('the order is not re-sorted — it is the DM\'s array as it arrives',
    env.order().map(c => c.name).join() === 'First,Second,Third,Fourth,Fifth'
    && !/\.sort\(/.test(pageJs),
    'currentIndex points into the DM\'s own ordering');
  check('every combatant gets a row',
    (O().match(/class="tb-row/g) || []).length === 5,
    (O().match(/class="tb-row/g) || []).length + ' rows');
  check('your own row is marked, and only yours',
    (O().match(/is-mine/g) || []).length === 1 && (O().match(/tb-you/g) || []).length === 1);
  check('a combatant on 0 hit points is dimmed rather than hidden',
    /is-down/.test(O()), 'they are still in the order and still a target');

  // The index can go out of range: the DM removes a combatant mid-fight and
  // the Encounter Manager's index is briefly past the end.
  env.enc = Object.assign({}, fight, { currentIndex: 99 });
  env.render();
  check('an index past the end wraps instead of breaking the page',
    env.current() && env.current().name === 'Fifth', String(env.currentIdx()));
  env.enc = Object.assign({}, fight, { currentIndex: -3 });
  env.render();
  check('and so does a negative one',
    env.current() && env.current().name === 'Third', String(env.currentIdx()));
  env.enc = Object.assign({}, fight, { currentIndex: 'nonsense' });
  check('and something that is not a number at all',
    env.currentIdx() === 0);

  env.enc = { round: 1, currentIndex: 0, combatants: [C('Alone', 10, 5, 5, 0, true)], attackLog: [] };
  env.render();
  check('one combatant gets no "next", because there is nobody to be next',
    env.upNext() === null && !/tb-next/.test(H()));
  env.enc = fight;
  env.render();
}

/* ── 2. hit points, and what is not shown ── */
{
  const them = env.order().find(c => !c.isPC);
  const ours = env.order().find(c => c.isPC);
  ACCESS.admin = false;
  env.dm = false;
  env.exact = false;
  check('your own side shows real numbers',
    /^\d+ \/ \d+/.test(env.hpText(ours)), env.hpText(ours));
  check('and an enemy shows a band instead',
    !/\d+ \/ \d+/.test(env.hpText(them))
    && env.HP_BANDS.some(b => b.label === env.hpText(them)),
    env.hpText(them) + ' — the DM has their hit points');
  check('the page says that is what it is doing',
    /band/.test(els['tb-hp-note'].textContent) && /DM/.test(els['tb-hp-note'].textContent));
  check('and the exact-numbers toggle is not offered to a player',
    els['tb-exact-btn'].style.display === 'none');

  const bands = [
    [30, 30, 'untouched'],  // full
    [29, 30, 'grazed'],     // a scratch
    [20, 30, 'grazed'],     // two thirds — the case the first version of
    [16, 30, 'grazed'],     // this check had no example of at all
    [15, 30, 'bloodied'],   // exactly half, which is what bloodied means
    [14, 30, 'bloodied'],
    [8, 30, 'bloodied'],
    [7, 30, 'critical'],    // a quarter or less
    [1, 30, 'critical'],
    [0, 30, 'down'],
  ];
  const wrong = bands.filter(([hp, max, id]) => env.hpBand({ hp, maxHp: max }).id !== id);
  check('the bands are the ones a table says out loud — bloodied is half, down is nothing',
    wrong.length === 0,
    wrong.map(([h, m, id]) => `${h}/${m} → ${env.hpBand({ hp: h, maxHp: m }).id}, want ${id}`).join(' | '));
  check('a combatant with no maximum recorded is Unknown rather than a divide by zero',
    env.hpBand({ hp: 5 }).id === 'unknown' && env.hpFraction({ hp: 5 }) === null
    && env.hpBand({ hp: 5, maxHp: 0 }).id === 'unknown');

  ACCESS.admin = true;
  env.dm = true;
  env.exact = true;
  env.render();
  check('the DM sees exact numbers for everybody',
    /^\d+ \/ \d+/.test(env.hpText(them)), env.hpText(them));
  check('and can turn them off, for a table that would rather not know',
    els['tb-exact-btn'].style.display === '' && (env.toggleExact(), !/\d+ \/ \d+/.test(env.hpText(them))));
  ACCESS.admin = false;
  env.dm = false;
  env.exact = false;
  env.render();
}

/* ── 3. what a condition means for the attack ── */
{
  check('a condition carries its own rule as a tooltip',
    /Prone — Can only crawl/.test(env.conditionTitle('Prone')),
    'out of rules-data.js, the same text the Rules page prints');
  check('and an unknown one is printed rather than dropped',
    env.conditionTitle('Soggy') === 'Soggy');

  // Second is up, and Second is Prone — so their attacks have disadvantage.
  env.enc = Object.assign({}, env.enc, { currentIndex: 1 });
  env.render();
  const vsPlain = env.attackAdviceOn(env.order()[4]);
  check('a prone attacker is told their attacks have disadvantage',
    vsPlain && vsPlain.mode === 'dis', JSON.stringify(vsPlain));
  const vsRestrained = env.attackAdviceOn(env.order()[2]);
  check('and against a restrained target the two cancel, which the page says',
    vsRestrained && vsRestrained.mode === 'none' && vsRestrained.cancelled === true
    && /cancel/.test(O()),
    JSON.stringify(vsRestrained && vsRestrained.mode));
  check('an ally is not given attack advice at all',
    env.attackAdviceOn(env.order()[0]) === null, 'they are on your team');
  check('and neither is the character whose turn it is',
    env.attackAdviceOn(env.order()[1]) === null);

  // A stunned attacker cannot attack, and the page should say that rather
  // than offering advice about a roll that will not happen.
  env.enc = Object.assign({}, env.enc, {
    combatants: env.order().map((c, i) => i === 1 ? Object.assign({}, c, { conditions: ['Stunned'] }) : c),
  });
  env.render();
  const stunned = env.attackAdviceOn(env.order()[4]);
  check('a stunned attacker is told they cannot attack',
    stunned && stunned.mode === 'cannot' && /stunned/.test(stunned.reasons[0]),
    JSON.stringify(stunned));
  check('it comes from the same table the DM\'s tracker rolls against',
    /rulesAttackMode\(/.test(pageJs) && /rules-data\.js/.test(pageHtml));
}

/* ── 4. the attack log ── */
{
  env.enc = Object.assign({}, env.enc, { attackLog: [
    { attacker: 'A', target: 'B', roll: 19, ac: 13, advMode: 'adv', dropped: 4, reasons: ['target is restrained'] },
    { attacker: 'C', target: 'D', roll: 1, ac: 13 },
    { attacker: 'E', target: 'F', roll: 20, ac: 13 },
    { attacker: 'G', target: null, roll: null, ac: null },
    { attacker: 'H', target: 'I', cannot: 'attacker is unconscious' },
  ] });
  env.render();
  check('every kind of log entry renders',
    ['adv 19 / 4 · hit', 'd20 1 · fumble', 'd20 20 · crit', 'no valid targets', 'no attack']
      .every(frag => L().includes(frag)),
    ['adv 19 / 4 · hit', 'd20 1 · fumble', 'd20 20 · crit', 'no valid targets', 'no attack']
      .filter(frag => !L().includes(frag)).join(' | '));
  check('and an advantage says why it had one',
    /target is restrained/.test(L()));
  check('a hit and a miss are told apart',
    /is-hit/.test(L()) && /is-miss|is-fumble/.test(L()));
}

/* ── 5. read-only, and escaping ── */
{
  check('the page has no write path of any kind',
    !/\.set\(|\.update\(|fsMergeSave|\.add\(|\.delete\(/.test(pageJs),
    'watching a fight is a read');
  const rules = read('firestore.rules');
  check('and the database would refuse one anyway',
    /doc != 'encounter-state'/.test(rules),
    'encounter-state is admin-only to write');
  check('it ignores a cached snapshot, which is this tab\'s own stale copy',
    /fromCache/.test(pageJs));
  check('and says out loud if it cannot read the encounter',
    /console\.error/.test(pageJs) && /could not read the encounter/.test(pageJs));

  env.enc = {
    round: '<b>3</b>',
    currentIndex: 0,
    attackLog: [{ attacker: '<img src=x onerror=alert(1)>', target: '<script>y</script>', roll: 10, ac: 5 }],
    combatants: [{ id: 'x', name: '<iframe>', initiative: '<svg/>', hp: 1, maxHp: 1,
      ac: '<b>9</b>', team: 0, isPC: true, conditions: ['<script>c</script>'] }],
  };
  env.render();
  const page = H() + O() + L();
  // An attribute cannot exist outside a tag, so the test is whether a tag
  // survived. <b> is excluded because this page's own markup uses none of it
  // — any <b> here would be injected, so it IS included.
  const tags = page.match(/<(script|img|iframe|svg|b)[ >/]/g) || [];
  check('nothing in the encounter can become a tag on this page',
    tags.length === 0, [...new Set(tags)].join(' '));
  check('and it comes back as entities',
    page.includes('&lt;iframe&gt;') && page.includes('&lt;img src=x'));
}

/* ── the page ── */
{
  check('the page loads the conditions before its own script',
    pageHtml.indexOf('src="rules-data.js"') !== -1
    && pageHtml.indexOf('src="rules-data.js"') < pageHtml.indexOf('src="table.js"'));
  const reachedFor = [...new Set([...pageJs.matchAll(/getElementById\('([^'${]+)'\)/g)].map(m => m[1]))];
  const nowhere = reachedFor.filter(id =>
    !pageHtml.includes(`id="${id}"`) && !pageJs.includes(`id="${id}"`));
  check('every element it reaches for exists in the markup', nowhere.length === 0, nowhere.join(', '));
  for (const sel of ['.tb-now.is-yours', '.tb-row.is-now', '.band-bloodied', '.tb-cond',
    '.tb-advice.mode-adv', '.tb-row[data-team="1"]']) {
    check(`${sel} is styled`, pageCss.includes(sel));
  }
  const index = read('index.html');
  const dmStart = index.indexOf('<div id="dm-only">');
  const link = index.indexOf('href="table.html"');
  check('the dashboard links to it outside the DM block — it is a player page',
    link !== -1 && dmStart !== -1 && link < dmStart);
  check('and it points at the board, which answers the other half of the question',
    /board\.html/.test(pageHtml), 'the board shows where; this shows when');
}

console.log(failures ? `\n>>> at the table FAILED (${failures})`
  : '\n>>> at the table OK');
process.exit(failures ? 1 : 0);
