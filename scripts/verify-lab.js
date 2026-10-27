#!/usr/bin/env node
// Regression check for lab.html — the workbench and the quirk database.
//
// Why this needs a verifier: the workbench's whole value is four numbers, and
// a wrong number here is invisible. A player builds an ability, the page says
// it is worth 9 a turn, and nobody at the table has any way to tell that it
// is really worth 6. So the hit chance is checked against an independent
// calculation at thirty-six bonus/AC combinations, and the measured averages
// against the exact expectations of six expressions.
//
// What it guards:
//   1. The probability. A natural 1 always misses and a natural 20 always
//      hits, so no ability is ever a certainty or an impossibility.
//   2. The damage averages, measured by rolling rather than derived — which
//      is the only approach that is right for "4d6kh3".
//   3. Per-use damage: the crit adds the DICE again, not the flat modifier,
//      and a save-based ability gets no per-use number at all rather than an
//      invented one.
//   4. The JSON it hands over is the shape a character file takes, and
//      carries none of the workbench's own working-out fields.
//   5. The quirk database reads every source it claims to, merges a
//      character who appears in several, and says which ones failed.
//   6. Everything printed is escaped, and nothing on the page writes a
//      character.

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

const pageJs = read('lab.js');
const pageHtml = read('lab.html');
const pageCss = read('css/pages/lab.css');
const quirkJs = read('quirk-data.js');

const els = {};
const mk = () => ({ innerHTML: '', textContent: '', value: '', style: {}, dataset: {},
  focus() {}, select() {} });
for (const id of ['lab-tabs', 'lab-body', 'lab-maths', 'lab-preview', 'lab-drafts', 'lab-json',
  'lab-roll-out', 'lab-save-feedback', 'lab-quirk-count', 'lab-quirks-list', 'lab-facets',
  'lab-sources', 'lab-quirk-search']) els[id] = mk();
const store = {};

const env = new Function('sandbox', `
  const { document, localStorage, console } = sandbox;
  ${read('dice.js')}
  ${quirkJs}
  const firebase = { firestore: () => ({ collection: () => ({
    doc: () => ({ get: () => Promise.resolve({ exists: false }) }),
    get: () => Promise.resolve({ forEach() {} }) }) }) };
  const fbAuthReady = Promise.resolve();
  ${pageJs.slice(0, pageJs.lastIndexOf('(() => {'))}
  return { render, setView, setField, rollIt, saveDraft, loadDraft, deleteDraft, showJson,
           labReset, hitChance, critChance, damageProfile, expectedDamage, abilityJson,
           abilityProse, benchFrom, setQuirkQuery, filterQuirkType, filterQuirkFrom,
           visibleQuirks, quirkMatches, quirkDedupe, quirkRecord, quirkUsable,
           quirkNormaliseType, quirkFacets,
           get a() { return ability; }, set a(v) { ability = v; },
           set quirks(q) { labQuirks = q; labQuirksLoaded = true; },
           get drafts() { return labDrafts; } };
`)({
  document: { getElementById: (i) => els[i] || null },
  localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } },
  console: { error() {}, log() {} },
});

/* ── 1. the probability ── */
{
  // Faces that hit, over 20, with 1 never hitting and 20 always hitting.
  const expected = (bonus, ac) => Math.max(1, Math.min(19, 21 - (ac - bonus))) / 20;
  const wrong = [];
  for (const bonus of [-5, -2, 0, 3, 5, 8, 12]) {
    for (const ac of [8, 10, 12, 13, 14, 16, 18, 22, 30]) {
      const got = env.hitChance(bonus, ac, 'none');
      if (Math.abs(got - expected(bonus, ac)) > 1e-12) {
        wrong.push(`+${bonus} v AC ${ac}: ${got}, want ${expected(bonus, ac)}`);
      }
    }
  }
  check('the hit chance matches an independent calculation at 63 bonus/AC pairs',
    wrong.length === 0, wrong.slice(0, 4).join(' | '));

  check('nothing is ever a certainty — a natural 1 always misses',
    env.hitChance(20, 2, 'none') === 19 / 20 && env.hitChance(99, 1, 'adv') < 1);
  check('and nothing is ever impossible — a natural 20 always hits',
    env.hitChance(-20, 40, 'none') === 1 / 20 && env.hitChance(-99, 99, 'dis') > 0);

  const p = env.hitChance(5, 14, 'none');
  check('advantage is 1 minus both missing',
    Math.abs(env.hitChance(5, 14, 'adv') - (1 - (1 - p) ** 2)) < 1e-12);
  check('and disadvantage is both hitting',
    Math.abs(env.hitChance(5, 14, 'dis') - p * p) < 1e-12);
  check('a crit is one face in twenty, and advantage nearly doubles that',
    env.critChance('none') === 0.05
    && Math.abs(env.critChance('adv') - 0.0975) < 1e-9
    && Math.abs(env.critChance('dis') - 0.0025) < 1e-9);
}

/* ── 2. the damage averages ── */
{
  // Exact expectations. 4d6kh3 is the one a formula gets wrong, which is why
  // the page measures instead of deriving.
  const cases = [['2d6', 7, 2, 12], ['2d6+3', 10, 5, 15], ['1d8+1d4', 7, 2, 12],
    ['4d6kh3', 12.2446, 3, 18], ['1d20', 10.5, 1, 20], ['8d8+8', 44, 16, 72],
    ['1d6-1', 2.5, 0, 5]];
  const off = [];
  for (const [expr, avg, min, max] of cases) {
    const d = env.damageProfile(expr, 60000);
    if (!d) { off.push(expr + ': unreadable'); continue; }
    if (d.min !== min || d.max !== max) off.push(`${expr}: range ${d.min}–${d.max}, want ${min}–${max}`);
    if (Math.abs(d.avg - avg) > 0.2) off.push(`${expr}: avg ${d.avg}, want ${avg}`);
  }
  check('seven expressions measure to their exact expectations and ranges',
    off.length === 0, off.join(' | '));
  check('an unreadable expression produces no numbers rather than wrong ones',
    env.damageProfile('nonsense') === null && env.damageProfile('') === null);
  check('and the page says so instead of printing a figure',
    /Can't read/.test(pageJs) && /lb-maths is-bad/.test(pageJs));
}

/* ── 3. per use ── */
{
  env.a = Object.assign(env.a, { damage: '2d6+3', attackBonus: '+5', targetAc: '14',
    hitMode: 'attack', advantage: 'none' });
  const e = env.expectedDamage();
  const hit = env.hitChance(5, 14, 'none');
  // p(hit) × average, plus p(crit) × the DICE half only: a critical rolls
  // the dice twice and the flat modifier once.
  const want = hit * 10 + 0.05 * 7;
  check('per use is the hit chance times the average, plus the crit\'s extra dice',
    Math.abs(e.perUse - Math.round(want * 10) / 10) < 0.2,
    `${e.perUse} vs ${want.toFixed(2)}`);
  check('the flat modifier is separated out, because a crit does not double it',
    e.flat === 3, String(e.flat));

  // A lopsided expression, chosen so the right answer and the wrong one are a
  // whole point apart. With 2d6+3 they differ by 0.15 — inside any tolerance
  // a measured average needs — so doubling the flat modifier by mistake
  // passed every check above.
  env.a.damage = '1d4+20';
  const lop = env.expectedDamage();
  const lopWant = hit * 22.5 + 0.05 * 2.5;
  const lopWrong = hit * 22.5 + 0.05 * 22.5;
  check('and that is provable: with 1d4+20 the crit adds 2.5, not 22.5',
    Math.abs(lop.perUse - lopWant) < 0.3 && Math.abs(lop.perUse - lopWrong) > 0.7,
    `${lop.perUse} — right is ${lopWant.toFixed(2)}, doubling the flat part would give ${lopWrong.toFixed(2)}`);
  check('the flat part of a lopsided expression is read correctly',
    lop.flat === 20, String(lop.flat));
  env.a.damage = '2d6+3';

  env.a.hitMode = 'save';
  env.a.onSave = 'half';
  const s = env.expectedDamage();
  // Tolerances, not equalities: these averages are measured by rolling, so
  // demanding exactly 10 is demanding the sampling wobble be zero.
  check('a save-based ability gives both ends rather than a made-up middle',
    s.perUse === null && Math.abs(s.failed - 10) < 0.3 && Math.abs(s.saved - 5) < 0.3,
    JSON.stringify({ perUse: s.perUse, failed: s.failed, saved: s.saved }));
  env.a.onSave = 'none';
  check('and nothing on a success means nothing',
    env.expectedDamage().saved === 0);
  env.a.hitMode = 'none';
  check('an ability with nothing to miss with is just its average',
    Math.abs(env.expectedDamage().perUse - 10) < 0.3,
    String(env.expectedDamage().perUse));

  // Advantage has to raise it and disadvantage lower it, or the control is
  // decoration.
  env.a.hitMode = 'attack';
  env.a.advantage = 'none';
  const plain = env.expectedDamage().perUse;
  env.a.advantage = 'adv';
  const adv = env.expectedDamage().perUse;
  env.a.advantage = 'dis';
  const dis = env.expectedDamage().perUse;
  check('advantage raises the per-use figure and disadvantage lowers it',
    adv > plain && plain > dis, `${dis} < ${plain} < ${adv}`);
}

/* ── 4. what it hands over ── */
{
  env.a = Object.assign(env.a, {
    name: 'Laser Beam', type: 'Action', range: '80 feet',
    target: 'One creature you can see', hitMode: 'attack', attackBonus: '+5',
    damage: '3d8', uses: 'Three times per short rest',
    description: 'The beam pierces half and three-quarters cover.',
    targetAc: '14', advantage: 'adv',
  });
  const json = env.abilityJson();
  check('the JSON is the shape a character file\'s abilities take',
    ['name', 'type', 'attackBonus', 'damage', 'description'].every(k => k in json),
    Object.keys(json).join(', '));
  check('and carries none of the workbench\'s own working-out',
    !('targetAc' in json) && !('advantage' in json) && !('hitMode' in json)
    && !('onSave' in json) && !('range' in json),
    'targetAc and advantage are for the maths, not for a character record');
  check('the damage is stored in the engine\'s canonical form',
    json.damage === '3d8');
  // An expression the engine cannot read must not be exported at all: a
  // character file carrying "3d8ish" is a Roll button that does nothing.
  env.a.damage = 'about three d8';
  check('and an unreadable one is left out rather than passed through',
    !('damage' in env.abilityJson()), JSON.stringify(env.abilityJson()));
  env.a.damage = '3d8';

  const prose = env.abilityProse();
  check('the prose assembles the fields in one order every time',
    /^Range 80 feet\. One creature you can see\. Attack \+5 to hit, 3d8 on a hit\./.test(prose),
    prose);
  env.a.hitMode = 'save';
  env.a.onSave = 'half';   // set explicitly: an earlier check left it on 'none'
  check('a save reads as a save, with what a success still does',
    /DEX save DC 13, 3d8 on a failure half as much on a success\./.test(env.abilityProse()),
    env.abilityProse());

  // Drafts.
  env.a.name = 'First';
  env.saveDraft();
  env.a.name = 'Second';
  env.saveDraft();
  check('drafts save, newest first', env.drafts.length === 2 && env.drafts[0].ability.name === 'Second');
  env.saveDraft();
  check('and saving the same name again replaces rather than duplicates',
    env.drafts.length === 2, env.drafts.map(d => d.ability.name).join(', '));
  env.loadDraft(env.drafts[1].id);
  check('loading one puts it back on the bench', env.a.name === 'First');
  env.deleteDraft(env.drafts[0].id);
  check('and deleting one removes it', env.drafts.length === 1);
  env.a.name = '   ';
  const before = env.drafts.length;
  env.saveDraft();
  check('a nameless draft is refused with a reason',
    env.drafts.length === before && /name/i.test(els['lab-save-feedback'].textContent));
  check('drafts live in this browser only — nothing here writes a character',
    /localStorage\.setItem\(LS_LAB/.test(pageJs)
    && !/\.set\(|\.update\(|fsMergeSave|\.add\(/.test(pageJs),
    'the Copy button is the only way anything leaves this page');
}

/* ── 5. the quirk database ── */
{
  check('it knows every place a character can be hiding',
    ['relationships-bundle', "collection('characters')", 'class1b.json', 'teachers.json',
      'npcs.json', 'villains.json', 'roster.json'].every(s => quirkJs.includes(s)),
    ['relationships-bundle', "collection('characters')", 'class1b.json', 'teachers.json',
      'npcs.json', 'villains.json', 'roster.json'].filter(s => !quirkJs.includes(s)).join(', '));
  check('and the live ones are read before the bundled files',
    quirkJs.indexOf('relationships-bundle') < quirkJs.indexOf('class1b.json'));

  check('Mutation and Heteromorph fold into Mutant',
    env.quirkNormaliseType('Mutation') === 'Mutant'
    && env.quirkNormaliseType('Heteromorph') === 'Mutant'
    && env.quirkNormaliseType('Emitter') === 'Emitter',
    'a filter that offers both spellings hides half the heteromorphs');
  check('and a blank or N/A type is called Unrecorded rather than left empty',
    env.quirkNormaliseType('') === 'Unrecorded' && env.quirkNormaliseType('N/A') === 'Unrecorded');

  check('a record with no name or no quirk is not usable',
    env.quirkUsable({ name: '', quirk: 'x' }) === false
    && env.quirkUsable({ name: 'y', quirk: '' }) === false
    && env.quirkUsable({ name: 'y', quirk: 'x' }) === true);

  // The merge: the same person from several sources, live winning on every
  // field it has, the repo filling gaps.
  const merged = env.quirkDedupe([
    env.quirkRecord({ name: 'Test One', quirk: 'Live quirk', quirk_type: 'Emitter' }, 'live'),
    env.quirkRecord({ name: 'test one', quirk: 'Repo quirk', quirk_type: 'Mutant',
      quirk_rarity: 'Rare',
      quirk_mechanics: { weakness: 'from the repo', abilities: [{ name: 'A', description: 'x' }] } }, 'repo'),
  ]);
  check('a character in two sources merges into one record',
    merged.length === 1, merged.length + ' records');
  check('the live copy wins on every field it has filled in',
    merged[0].quirk === 'Live quirk' && merged[0].type === 'Emitter');
  check('and the repo fills in the gaps rather than being discarded',
    merged[0].weakness === 'from the repo' && merged[0].rarity === 'Rare'
    && merged[0].abilities.length === 1);
  check('the record says it was in both places',
    merged[0].alsoFrom.join() === 'repo');

  // The repo, for real: every bundled source, read off disk.
  const repoEnv = new Function('sandbox', `
    const { fetch, db } = sandbox;
    ${quirkJs}
    return quirkLoadAll;
  `)({
    fetch: (p) => Promise.resolve({ ok: true,
      json: () => Promise.resolve(JSON.parse(read(p))) }),
    db: { collection: (name) => name === 'characters'
      ? { get: () => Promise.resolve({ forEach() {} }) }
      : { doc: () => ({ get: () => Promise.resolve({ exists: false }) }) } },
  });

  return repoEnv(null, {}).then(({ quirks, sources, failed }) => {
    check('the bundled files alone make a database worth searching',
      quirks.length >= 50, quirks.length + ' characters with a quirk');
    check('and it covers more than one class',
      new Set(quirks.map(q => q.from)).size >= 4,
      [...new Set(quirks.map(q => q.from))].join(', '));
    check('a source that could not be reached is reported, not hidden',
      failed.includes('the live cast') && sources.length >= 4,
      'a database that quietly lost two of seven sources looks complete');
    check('and the page prints that report',
      /Could not reach/.test(pageJs) && /lab-sources/.test(pageJs));

    check('every record carries what the page needs to show',
      quirks.every(q => q.name && q.quirk && q.type && Array.isArray(q.abilities)));
    const withAbilities = quirks.filter(q => q.abilities.length);
    check('and a good number of them have abilities recorded',
      withAbilities.length >= 25, withAbilities.length + ' with abilities');

    const q = quirks[0];
    check('search is an AND across every field of a record',
      env.quirkMatches(q, q.name.split(' ')[0].toLowerCase()) === true
      && env.quirkMatches(q, q.name + ' definitelynotinthere') === false);
    check('and an empty query matches everything',
      quirks.every(x => env.quirkMatches(x, '')));

    const f = env.quirkFacets(quirks);
    check('the facets count the types and the sources',
      f.types.length >= 3 && f.froms.length >= 3
      && f.types.reduce((n, [, c]) => n + c, 0) === quirks.length,
      JSON.stringify(f.types));

    /* ── 6. escaping, and taking one to the bench ── */
    env.quirks = [{ name: 'Ren Suzuki', alias: '', quirk: 'Beams From His Eyes',
      type: 'Transformation', rarity: 'Rare', summary: '', weakness: 'Burns stamina.',
      source: '', from: 'Class 1-A (live)', role: '', alsoFrom: [],
      abilities: [{ name: 'Laser Beam', type: 'Action', text: 'Fires a beam.',
        damage: '3d8', attackBonus: '+6' }] }];
    env.setView('quirks');
    check('the database renders a card per record',
      /Beams From His Eyes/.test(els['lab-quirks-list'].innerHTML));

    env.benchFrom('Ren Suzuki', 'Laser Beam');
    check('a recorded ability can be taken onto the workbench',
      env.a.name === 'Laser Beam' && env.a.damage === '3d8'
      && env.a.attackBonus === '+6' && env.a.hitMode === 'attack',
      JSON.stringify({ n: env.a.name, d: env.a.damage, b: env.a.attackBonus }));
    check('and it computes once it is there',
      env.expectedDamage().dmg.min === 3 && env.expectedDamage().dmg.max === 24);
    const held = env.a.name;
    env.benchFrom('Nobody', 'Nothing');
    check('asking for one that does not exist changes nothing',
      env.a.name === held);

    env.a = Object.assign(env.a, { name: '<img src=x onerror=alert(1)>',
      description: '<script>bad</script>', range: '<b>8</b>', uses: '<u>x</u>',
      target: '<i>y</i>', damage: '2d6' });
    env.setView('bench');
    const page = Object.values(els).map(e => e.innerHTML).join('');
    // An attribute only exists inside a tag, and a regex cannot tell an
    // attribute from the same characters in text — so the test is whether a
    // tag survived, which is what actually decides it.
    // Deliberately NOT <b> or <i>: the facet counts are rendered as <b>42</b>
    // by this page's own markup, and the first version of this check matched
    // that and reported a leak that was not one.
    const tags = page.match(/<(script|img|iframe|svg)[ >/]/g) || [];
    check('nothing a field contains can become a tag',
      tags.length === 0, [...new Set(tags)].join(' '));
    check('and every injected field comes back as entities',
      ['&lt;img src=x', '&lt;script&gt;', '&lt;b&gt;8', '&lt;u&gt;x', '&lt;i&gt;y']
        .every(frag => page.includes(frag)),
      ['&lt;img src=x', '&lt;script&gt;', '&lt;b&gt;8', '&lt;u&gt;x', '&lt;i&gt;y']
        .filter(frag => !page.includes(frag)).join(' | '));

    /* the page */
    check('the page loads the dice engine and the loader before its own script',
      pageHtml.indexOf('src="dice.js"') < pageHtml.indexOf('src="lab.js"')
      && pageHtml.indexOf('src="quirk-data.js"') < pageHtml.indexOf('src="lab.js"'));
    const reachedFor = [...new Set([...pageJs.matchAll(/getElementById\('([^'${]+)'\)/g)].map(m => m[1]))];
    const nowhere = reachedFor.filter(id =>
      !pageHtml.includes(`id="${id}"`) && !pageJs.includes(`id="${id}"`));
    check('every element it reaches for exists somewhere it renders',
      nowhere.length === 0, nowhere.join(', '));
    for (const sel of ['.lb-bench', '.lb-stat-num', '.lb-quirk.is-open', '.lb-qa-bench', '.lb-tab.sel']) {
      check(`${sel} is styled`, pageCss.includes(sel));
    }
    const index = read('index.html');
    const dmStart = index.indexOf('<div id="dm-only">');
    const link = index.indexOf('href="lab.html"');
    check('the dashboard links to it outside the DM block — it is a player page',
      link !== -1 && dmStart !== -1 && link < dmStart);
    check('the page says the averages are measured rather than derived',
      /measured/i.test(pageHtml) && /4d6kh3/.test(pageHtml),
      'because a formula would quietly be wrong for keep-highest');

    console.log(failures ? `\n>>> lab FAILED (${failures})`
      : `\n>>> lab OK (${quirks.length} quirks from the bundled files alone)`);
    process.exit(failures ? 1 : 0);
  }).catch(err => {
    console.error('FAIL — the quirk database checks threw rather than reporting\n        '
      + (err && err.stack || err));
    console.error('\n>>> lab FAILED (threw)');
    process.exit(1);
  });
}
