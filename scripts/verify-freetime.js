#!/usr/bin/env node
// Regression check for freetime.html — the job board and the slot counter.
//
// Two things here are worth guarding closely.
//
// THE JOB BOARD IS PARSED out of the campaign's own "Free Time — odd jobs"
// appendix rather than retyped, which is the right call and also a standing
// risk: if a line stops matching the parser, the page silently drops that
// job and nobody notices a missing option. So every bullet in that section
// has to parse, and the wage and the check have to come out right.
//
// THIS PAGE MUST NOT PAY ANYBODY. firestore.rules refuses a write to an
// inventory that increases the purse — that is the rule stopping a player
// handing themselves ten thousand yen — so the page works out what a job
// owes, writes it in the log, and says to go and ask. A future version that
// "helpfully" credited the purse would be defeating a deliberate rule.

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

const pageJs = read('freetime.js');
const pageHtml = read('freetime.html');
const pageCss = read('css/pages/freetime.css');

const els = {};
const mk = () => ({ innerHTML: '', textContent: '', value: '' });
for (const id of ['ft-chars', 'ft-slots', 'ft-roll', 'ft-flash', 'ft-extras', 'ft-jobs',
  'ft-log', 'ft-save-state', 'ft-source', 'ft-written']) els[id] = mk();
const store = {};
const writes = [];
const ACCESS = { admin: false, owned: [] };

const env = new Function('sandbox', `
  const { document, localStorage, console, confirm } = sandbox;
  ${read('dice.js')}
  ${read('char-data.js')}
  const firebase = { firestore: () => ({ collection: () => ({ doc: (n) => ({
    get: () => Promise.resolve({ exists: false }),
    set: (d, o) => { sandbox.writes.push([n, JSON.parse(JSON.stringify(d)), o]); return Promise.resolve(); },
  }) }) }) };
  const fbAuthReady = Promise.resolve();
  const window = { isAdmin: () => sandbox.admin(), canEdit: (k) => sandbox.owned().includes(k) };
  function fbCharacterKey(t, n) { return t + '::' + n; }
  const fetch = (p) => sandbox.fetch(p);
  ${pageJs.slice(0, pageJs.lastIndexOf('(async () => {'))}
  return { render, loadJobs, doJob, doExtra, doWritten, undoEntry, setSlots, setWindow,
           newWindow, pickChar, freetimeParseJobs, freetimeCheckOf, freetimePayOf,
           left, spent, earned, currentChar, FT_EXTRA,
           get jobs() { return jobs; }, set jobs(v) { jobs = v; },
           set mine(v) { mine = v; charFile = v.length ? v[0]._file : null; },
           set chars(v) { chars = v; }, set canWrite(v) { canWrite = v; },
           set isDm(v) { isDm = v; }, set charsLoaded(v) { charsLoaded = v; },
           set jobsLoaded(v) { jobsLoaded = v; },
           get sheet() { return sheet; }, set sheet(v) { sheet = v; } };
`)({
  document: { getElementById: (i) => els[i] || null },
  localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } },
  console: { error() {}, log() {} },
  confirm: () => true,
  admin: () => ACCESS.admin,
  owned: () => ACCESS.owned,
  writes,
  fetch: (p) => Promise.resolve({ json: () => Promise.resolve(JSON.parse(read(p))) }),
});

const pc = {
  _file: 'test.json', name: 'Test Character', quirk: 'q',
  ability_scores: { STR: '14', DEX: '18', CON: '20', INT: '13', WIS: '10', CHA: '10', TECH: '4' },
  modifiers: { STR: '2', DEX: '4', CON: '5', INT: '1', WIS: '0', CHA: '0', TECH: '-3' },
};
const J = () => els['ft-jobs'].innerHTML.replace(/\s+/g, ' ');
const R = () => els['ft-roll'].innerHTML.replace(/\s+/g, ' ');

(async () => {
  /* ── 1. every line of the appendix parses ── */
  const appendix = JSON.parse(read('CAMPAIGN/campaigns.json')).campaigns
    .flatMap(c => c.appendix || [])
    .find(a => /Free Time — odd jobs/.test(a.heading || ''));
  check('the campaign still has an odd-jobs appendix to read', !!appendix);

  const bullets = appendix.body.split('\n').filter(l => /^·/.test(l.trim()));
  const parsed = env.freetimeParseJobs(appendix.body);
  check('every bullet in it parses into a job',
    parsed.length === bullets.length,
    `${parsed.length} parsed of ${bullets.length} bullets — a line that stops `
    + 'matching is a job the page silently drops');
  check('and there are enough of them to be a board',
    parsed.length >= 20, parsed.length + ' jobs');
  check('every job has a name, an id and its original line',
    parsed.every(j => j.name && j.id && j.raw));
  check('ids are unique — they are what a button sends back',
    new Set(parsed.map(j => j.id)).size === parsed.length);

  // The second block is second-years only, from Chapter 7. A first-year
  // seeing those as plain options is the one thing the campaign would mind.
  check('the appendix\'s two blocks are kept apart',
    parsed.some(j => j.block === 'first') && parsed.some(j => j.block === 'second')
    && parsed.filter(j => j.block === 'second').length >= 8,
    JSON.stringify({ first: parsed.filter(j => j.block === 'first').length,
      second: parsed.filter(j => j.block === 'second').length }));
  check('and the fame-gated ones are marked',
    parsed.filter(j => j.fame).length >= 3, parsed.filter(j => j.fame).length + ' marked ★');

  // Spot-checks against the appendix's own numbers.
  const byName = (n) => parsed.find(j => j.name === n);
  const cases = [
    ['KONBINI NIGHT SHIFT', 'CON', 10, 6000],
    ['RAMEN STALL', 'DEX', 11, 5000],
    ['TUTORING MIDDLE-SCHOOLERS', 'INT', 12, 8000],
    ['MOVING COMPANY', 'STR', 13, 7000],
    ['EVENT SECURITY', 'WIS', 12, 10000],
    ['TRANSLATING FOR A FOREIGN AGENCY', 'INT', 15, 20000],
  ];
  const wrong = cases.filter(([name, ability, dc, pay]) => {
    const job = byName(name);
    if (!job) return true;
    const c = env.freetimeCheckOf(job);
    return !c || c.dc !== dc || !c.abilities.includes(ability) || env.freetimePayOf(job) !== pay;
  });
  check('the check and the wage come out of six lines exactly as written',
    wrong.length === 0,
    wrong.map(([n]) => {
      const job = byName(n);
      return `${n}: ${JSON.stringify(job && env.freetimeCheckOf(job))} ${job && env.freetimePayOf(job)}`;
    }).join(' | '));
  check('"DEX or CHA DC 11" is read as a choice of two',
    (env.freetimeCheckOf(byName('RAMEN STALL')).abilities || []).join() === 'DEX,CHA');
  check('a job with no check gives no roll rather than an invented DC',
    env.freetimeCheckOf(byName('SWING TOWN ATTENDANT')) === null
    && env.freetimeCheckOf(byName('THE RING (ILLEGAL)')) === null,
    '"no check" and "a fight" are not DCs');
  check('and an unpaid one has no wage',
    env.freetimePayOf(byName('FORGE\'S LAB ASSISTANT')) === null);
  check('the whole line is kept rather than having its middle cut out',
    byName('RAMEN STALL').raw === 'DEX or CHA DC 11. ¥5,000 and a free meal.',
    JSON.stringify(byName('RAMEN STALL').raw));

  /* ── 2. the page renders it ── */
  await env.loadJobs();
  env.mine = [pc];
  env.chars = [pc];
  env.charsLoaded = true;
  env.canWrite = true;
  env.render();
  check('every job gets a row on the page',
    (J().match(/class="ft-job[ "]/g) || []).length === env.jobs.length,
    `${(J().match(/class="ft-job[ "]/g) || []).length} of ${env.jobs.length}`);
  check('the two blocks are headed separately',
    (J().match(/ft-block-name/g) || []).length === 2);
  check('and your own modifier for the check is shown beside it',
    /you roll \+/.test(J()), 'so you know what you are rolling before you spend the slot');

  /* ── 3. spending, and the campaign's halving rule ── */
  env.sheet = { slots: 3, window: '', entries: [] };
  env.doJob('konbini-night-shift');
  check('spending a slot rolls the check and logs it',
    env.sheet.entries.length === 1 && env.left() === 2
    && env.sheet.entries[0].roll && env.sheet.entries[0].roll.dc === 10);
  check('the roll is shown with what it needed and whether it got there',
    /ft-roll-num/.test(R()) && /against DC 10/.test(R()) && /passed|failed/.test(R()));

  // "A failed check halves the pay" — the appendix's own rule.
  let pass = 0; let fail = 0; let full = 0; let halved = 0; let other = 0;
  for (let i = 0; i < 600; i++) {
    env.sheet = { slots: 99, window: '', entries: [] };
    env.doJob('konbini-night-shift');
    const e = env.sheet.entries[0];
    if (e.passed) pass++; else fail++;
    if (e.pay === 6000) full++;
    else if (e.pay === 3000) halved++;
    else other++;
  }
  check('a failed check halves the pay, and a passed one does not',
    full === pass && halved === fail && other === 0,
    JSON.stringify({ pass, fail, full, halved, other }));
  // CON +5 against DC 10 needs a 5 or better: 16 faces in 20.
  check('and the roll really is the character\'s own modifier',
    Math.abs(pass / 600 - 0.8) < 0.06,
    `${(pass / 6).toFixed(1)}% passed — CON +5 against DC 10 should pass 80% of the time`);

  let ramenPass = 0;
  for (let i = 0; i < 800; i++) {
    env.sheet = { slots: 99, window: '', entries: [] };
    env.doJob('ramen-stall');
    if (env.sheet.entries[0].passed) ramenPass++;
  }
  check('a job offering two abilities rolls the better of them',
    Math.abs(ramenPass / 800 - 0.7) < 0.055,
    `${(ramenPass / 8).toFixed(1)}% passed — DEX +4 against DC 11 is 70%; `
    + 'taking CHA +0 instead would be 50%');

  env.sheet = { slots: 3, window: '', entries: [] };
  env.doJob('swing-town-attendant');
  check('a job with no check is logged with no roll at all',
    env.sheet.entries.length === 1 && env.sheet.entries[0].roll === null
    && env.sheet.entries[0].pay === 6000 && !/ft-roll-num/.test(R()));

  /* ── 4. the slot budget ── */
  env.sheet = { slots: 3, window: '', entries: [] };
  env.doExtra('training-half');
  check('half a training slot costs half a slot',
    env.spent() === 0.5 && env.left() === 2.5, String(env.left()));
  env.doExtra('hangout');
  check('a hangout costs one and rolls nothing',
    env.spent() === 1.5 && env.sheet.entries[0].kind === 'hangout'
    && env.sheet.entries[0].roll === undefined);
  els['ft-written'].value = 'Sat on the dock.';
  env.doWritten();
  check('and something written down keeps the words',
    /Sat on the dock/.test(env.sheet.entries[0].name));
  els['ft-written'].value = '   ';
  const beforeBlank = env.sheet.entries.length;
  env.doWritten();
  check('a blank one is refused with a reason',
    env.sheet.entries.length === beforeBlank && /Write what you did/.test(els['ft-flash'].textContent));

  env.sheet = { slots: 1, window: '', entries: [] };
  env.doJob('ramen-stall');
  const atLimit = env.sheet.entries.length;
  env.doJob('ramen-stall');
  check('a slot you do not have is refused, and the page says so',
    env.sheet.entries.length === atLimit && /No slots left/.test(els['ft-flash'].textContent));
  check('and the counter never goes below zero',
    (() => {
      env.sheet = { slots: 3, window: '', entries: [] };
      env.isDm = true;
      env.doExtra('training');
      env.doExtra('training');
      env.doExtra('training');
      env.setSlots(1);     // the DM decides it was one slot, not three
      return env.left() === 0 && env.spent() === 3;
    })(),
    'the case that can actually happen: the DM lowering the count after slots '
    + 'have been spent. Over-spending is refused, so that path never goes negative.');
  // A fresh sheet: the clamp check above deliberately leaves this one
  // over-spent, and an undo there would not be measuring anything.
  env.sheet = { slots: 2, window: '', entries: [] };
  env.doJob('ramen-stall');
  check('taking one back returns the slot',
    (() => {
      const spentFirst = env.left() === 1;
      env.undoEntry(env.sheet.entries[0].id);
      return spentFirst && env.sheet.entries.length === 0 && env.left() === 2;
    })(), String(env.left()));

  /* ── 5. who may change what ── */
  env.isDm = false;
  env.setSlots(9);
  env.setWindow('a player wrote this');
  check('a player cannot set their own slots or name the window',
    env.sheet.slots !== 9 && env.sheet.window !== 'a player wrote this',
    JSON.stringify({ slots: env.sheet.slots, window: env.sheet.window }));
  env.isDm = true;
  env.setSlots(5);
  check('the DM can', env.sheet.slots === 5);
  env.setSlots(-4);
  check('a negative is refused rather than clamped silently', env.sheet.slots === 5);
  env.setSlots(999);
  check('and an absurd one is capped', env.sheet.slots === 20);
  env.setSlots(2.5);
  check('halves are allowed, because half a training slot is a real thing',
    env.sheet.slots === 2.5);
  env.doExtra('hangout');
  env.newWindow();
  check('a new window clears the log and keeps the slot count',
    env.sheet.entries.length === 0 && env.sheet.slots === 2.5);
  check('and it asks first, because a player may have logged six of them',
    /confirm\(/.test(pageJs));
  check('clearing is the DM\'s, not a player\'s',
    /function newWindow\(\) \{\s*if \(!isDm\) return;/.test(pageJs));

  /* ── 6. it does not pay anybody ── */
  check('the page never writes an inventory',
    !/collection\('inventories'\)/.test(pageJs) && !/currency/.test(pageJs),
    'firestore.rules refuses a write that increases a purse, and that is a good rule');
  const rules = read('firestore.rules');
  check('and the rule it would be defeating is still there',
    /purseValue\(request\.resource\.data\) <= purseValue\(resource\.data\)/.test(rules));
  check('so it says out loud that it does not pay you',
    /does not pay you/.test(pageJs) && /Nothing on this page pays you/.test(pageHtml));

  /* ── 7. storage ── */
  await new Promise(r => setTimeout(r, 800));
  const own = writes.filter(w => /^freetime-/.test(w[0]));
  check('the sheet is one document per character, like the Heropad\'s pads',
    own.length > 0 && own[0][0] === 'freetime-test',
    own.length ? own[0][0] : 'nothing written');
  check('merged rather than replacing the document',
    own.every(w => w[2] && w[2].merge === true));
  check('and kept in this browser too, so a reload remembers',
    Object.keys(store).some(k => /^mha-freetime-v1-/.test(k)));
  const beforeRead = writes.length;
  env.canWrite = false;
  env.doExtra('training');
  await new Promise(r => setTimeout(r, 800));
  check('a reader sends nothing to the server',
    writes.length === beforeRead, `${writes.length - beforeRead} writes`);
  check('and a failed save is said out loud rather than swallowed',
    /console\.error/.test(pageJs) && /could not save/.test(pageJs));

  /* ── 8. nobody assigned, and escaping ── */
  env.mine = [];
  env.charsLoaded = true;
  env.render();
  check('with no character assigned the page says so and says what to ask for',
    /No character is assigned to you yet/.test(els['ft-chars'].innerHTML)
    && /admin page/.test(els['ft-chars'].innerHTML));
  check('and the job board is still worth reading',
    (J().match(/class="ft-job[ "]/g) || []).length > 0);

  env.mine = [Object.assign({}, pc, { name: '<img src=x onerror=alert(1)>' })];
  env.charsLoaded = true;
  env.jobs = [{ id: 'x', name: '<script>j</script>', fame: true, block: 'first',
    check: '<b>c</b>', pay: '<i>p</i>', raw: '<iframe>' }];
  env.sheet = { slots: 2, window: '<svg/>', entries: [
    { id: 'e', at: 1, cost: 1, kind: 'other', name: '<script>e</script>', pay: 5 }] };
  env.isDm = true;
  env.render();
  const page = Object.values(els).map(e => e.innerHTML).join('');
  // A surviving tag is what decides it; <b> and <i> are included because this
  // page's own markup uses neither.
  const tags = page.match(/<(script|img|iframe|svg|b|i)[ >/]/g) || [];
  check('nothing in a job, a character or the log can become a tag',
    tags.length === 0, [...new Set(tags)].join(' '));
  check('and it all comes back as entities',
    page.includes('&lt;iframe&gt;') && page.includes('&lt;script&gt;'));

  /* the page */
  check('the page loads the dice engine and the character loader first',
    ['dice.js', 'char-data.js'].every(f =>
      pageHtml.indexOf('src="' + f + '"') !== -1
      && pageHtml.indexOf('src="' + f + '"') < pageHtml.indexOf('src="freetime.js"')));
  const reachedFor = [...new Set([...pageJs.matchAll(/getElementById\('([^'${]+)'\)/g)].map(m => m[1]))];
  const nowhere = reachedFor.filter(id =>
    !pageHtml.includes(`id="${id}"`) && !pageJs.includes(`id="${id}"`));
  check('every element it reaches for exists somewhere it renders',
    nowhere.length === 0, nowhere.join(', '));
  for (const sel of ['.ft-pip.is-spent', '.ft-job.is-fame', '.ft-roll.is-fail', '.ft-do:disabled', '.ft-tag.ft-second']) {
    check(`${sel} is styled`, pageCss.includes(sel));
  }
  const index = read('index.html');
  const dmStart = index.indexOf('<div id="dm-only">');
  const link = index.indexOf('href="freetime.html"');
  check('the dashboard links to it outside the DM block — it is a player page',
    link !== -1 && dmStart !== -1 && link < dmStart);

  console.log(failures ? `\n>>> free time FAILED (${failures})`
    : `\n>>> free time OK (${parsed.length} jobs off the campaign's own board)`);
  process.exit(failures ? 1 : 0);
})().catch(err => {
  console.error('FAIL — the free time checks threw rather than reporting\n        '
    + (err && err.stack || err));
  console.error('\n>>> free time FAILED (threw)');
  process.exit(1);
});
