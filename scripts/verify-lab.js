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
//   5. The quirk database reads every source it claims to, merges two people
//      who share a quirk into one entry, and says which sources failed.
//   5b. NOBODY IS NAMED IN IT. The cast it is assembled from includes the
//      gang, the Underground and the villains, so a name on this page is a
//      spoiler. Every rendered field is checked against every name the
//      campaign knows — the headers are the easy half, and the prose, which
//      is written about people, is the half that needs checking.
//   6. Everything printed is escaped, and nothing on the page writes a
//      character.
//   7. The turn sheet: which characters count as yours, the free-text
//      ability `type` read down to a cost bucket (the live bundle has
//      fourteen distinct values in it), and the first rollable die pulled
//      out of a damage string like "1d12 / 2 heat points".
//   8. The player's own record — the moves they wrote, the equipment they
//      made, the perks they picked up, and the stats they are tracking.
//      Three things matter here: it is a document of its OWN rather than a
//      write into the character, a crafted thing is priced off the real
//      catalogue rather than a number somebody invented, and the stats
//      section records a disagreement with the DM's copy instead of
//      resolving it in either direction.

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
for (const id of ['lab-tabs', 'lab-body', 'lab-mine', 'lab-record', 'lab-maths', 'lab-preview',
  'lab-drafts', 'lab-json', 'lab-roll-out', 'lab-save-feedback', 'lab-quirk-count',
  'lab-quirks-list', 'lab-facets', 'lab-sources', 'lab-quirk-search', 'lab-gear-preview',
  'lab-gear-price', 'lab-gear-roll', 'lab-record-state', 'lab-perk-name', 'lab-perk-from',
  'lab-perk-text']) els[id] = mk();
const store = {};

const charJs = read('char-data.js');
const recordJs = read('player-record.js');
const shopCatalog = JSON.parse(read('CAMPAIGN/shop-catalog.json'));

// Declared before the sandbox is built: its admin/owned getters are called
// during the factory's own first render, and a const in the temporal dead
// zone throws there.
const ACCESS = { admin: false, owned: [] };
const WRITES = [];

const env = new Function('sandbox', `
  const { document, localStorage, console } = sandbox;
  ${read('dice.js')}
  ${quirkJs}
  ${charJs}
  ${read('rules-data.js')}
  ${recordJs}
  const firebase = { firestore: () => ({ collection: () => ({
    doc: (n) => ({ get: () => Promise.resolve({ exists: false }),
      set: (d, o) => { sandbox.writes.push([n, JSON.parse(JSON.stringify(d)), o]); return Promise.resolve(); } }),
    get: () => Promise.resolve({ forEach() {} }) }) }) };
  const fbAuthReady = Promise.resolve();
  const window = { isAdmin: () => sandbox.admin(), canEdit: (k) => sandbox.owned().includes(k) };
  function fbCharacterKey(t, n) { return t + '::' + n; }
  ${pageJs.slice(0, pageJs.lastIndexOf('(() => {'))}
  return { render, setView, setField, rollIt, saveDraft, loadDraft, deleteDraft, showJson,
           labReset, hitChance, critChance, damageProfile, expectedDamage, abilityJson,
           abilityProse, benchFrom, setQuirkQuery, filterQuirkType, filterQuirkFrom,
           visibleQuirks, quirkMatches, quirkDedupe, quirkRecord, quirkUsable,
           quirkNormaliseType, quirkFacets, quirkScrub,
           charCostOf, charDiceIn, charCanDo, labUniversal, rollRow, benchRow,
           labPickChar, mineHtml, CHAR_COSTS, CHAR_COST_LABELS,
           setBenchMode, setGear, saveAsMove, saveAsGear, deleteMove, deleteGear,
           editMove, editGear, addPerk, deletePerk, setStat, clearStat, setRecordNote,
           rollOwn, rollGear, recordHtml, recordEmpty, recordMoveRows, recordGearRows,
           recordComparables, recordSuggestedPrice, recordDiceAverage, recordRef,
           recordKey, RECORD_GEAR_KINDS, kindLabel,
           get record() { return record; }, set record(v) { record = v; },
           set catalog(v) { shopCatalog = v; },
           set canWrite(v) { labCanWrite = v; },
           get gear() { return gear; }, get mode() { return benchMode; },
           get a() { return ability; }, set a(v) { ability = v; },
           set quirks(q) { labQuirks = q; labQuirksLoaded = true; },
           set mine(v) { labMine = v; labCharFile = v.length ? v[0]._file : null; },
           set loaded(v) { labCharsLoaded = v; }, set src(v) { labCharSource = v; },
           get view() { return labView; },
           get drafts() { return labDrafts; } };
`)({
  document: { getElementById: (i) => els[i] || null },
  localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } },
  console: { error() {}, log() {} },
  admin: () => ACCESS.admin,
  owned: () => ACCESS.owned,
  writes: WRITES,
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
  check('workbench drafts stay in this browser',
    /localStorage\.setItem\(LS_LAB/.test(pageJs));
  check('and the only document the page writes is its own labsheet',
    (() => {
      const writes = [...pageJs.matchAll(/(\w+(?:\([^)]*\))?)\.set\(/g)].map(m => m[1]);
      return writes.length > 0 && writes.every(w => /recordRef\(/.test(w));
    })(),
    [...pageJs.matchAll(/(\w+(?:\([^)]*\))?)\.set\(/g)].map(m => m[1]).join(', '));
  check('never the character bundle and never an inventory',
    !/relationships-bundle/.test(pageJs.replace(/\/\/[^\n]*/g, ''))
    && !/collection\('inventories'\)/.test(pageJs)
    && !/fsMergeSave/.test(pageJs),
    'the character is the DM\'s, and the purse has a database rule of its own');
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

  check('a record needs a quirk to be about',
    env.quirkUsable({ quirk: '' }) === false
    && env.quirkUsable({ quirk: 'x' }) === true
    && env.quirkUsable(null) === false);
  check('and a record carries no name field at all',
    (() => {
      const r = env.quirkRecord({ name: 'Somebody Real', alias: 'Nickname',
        hero_name: 'Hero', quirk: 'x' }, 's', ['Somebody Real']);
      return !('name' in r) && !('alias' in r);
    })(),
    'a field that does not exist cannot be printed by mistake');

  // The merge is by QUIRK now: two people who share one are one entry, and
  // their abilities accumulate because they have found different things to
  // do with it.
  const merged = env.quirkDedupe([
    env.quirkRecord({ name: 'One', quirk: 'Shared', quirk_type: 'Emitter',
      quirk_mechanics: { abilities: [{ name: 'A', description: 'x' }] } }, 'live', []),
    env.quirkRecord({ name: 'Two', quirk: 'shared', quirk_type: 'Mutant',
      quirk_rarity: 'Rare',
      quirk_mechanics: { weakness: 'from the repo', abilities: [{ name: 'B', description: 'y' }] } }, 'repo', []),
  ]);
  check('two people with the same quirk become one entry',
    merged.length === 1 && merged[0].held === 2, JSON.stringify(merged.map(m => m.quirk)));
  check('the first source wins on every field it has filled in',
    merged[0].quirk === 'Shared' && merged[0].type === 'Emitter');
  check('the second fills in the gaps rather than being discarded',
    merged[0].weakness === 'from the repo' && merged[0].rarity === 'Rare');
  check('and their abilities accumulate rather than one replacing the other',
    merged[0].abilities.map(a => a.name).join() === 'A,B',
    merged[0].abilities.map(a => a.name).join());
  const thrice = env.quirkDedupe([
    env.quirkRecord({ name: 'One', quirk: 'Shared',
      quirk_mechanics: { abilities: [{ name: 'A', description: 'x' }] } }, 'live', []),
    env.quirkRecord({ name: 'Two', quirk: 'Shared',
      quirk_mechanics: { abilities: [{ name: 'A', description: 'x' }, { name: 'B', description: 'y' }] } }, 'repo', []),
  ]);
  check('but an ability both of them have is listed once',
    thrice[0].abilities.map(a => a.name).join() === 'A,B'
    && thrice[0].abilities.length === 2,
    thrice[0].abilities.map(a => a.name).join());
  check('the entry says which sources it came from',
    merged[0].alsoFrom.join() === 'repo');

  /* ── the scrub ── */
  const scrubCases = [
    ['Once Kakita has studied a target, anything she throws curves.',
      ['Kakita Keiko', 'Kakita', 'Keiko'], 'Once the user has studied'],
    ["Domoto's legs carry more force than her frame suggests.",
      ['Domoto Fumiju', 'Domoto', 'Fumiju'], "The user's legs"],
    ['Dōmeki Daigo runs it, and Daigo is gentle with the kids.',
      ['Dōmeki Daigo', 'Dōmeki', 'Daigo'], 'The user runs it, and the user is gentle'],
  ];
  const scrubbed = scrubCases.filter(([text, names, want]) =>
    !env.quirkScrub(text, [...names].sort((a, b) => b.length - a.length)).includes(want));
  check('the scrub swaps a name for "the user", capitalised at a sentence start',
    scrubbed.length === 0,
    scrubbed.map(([t, n]) => env.quirkScrub(t, n)).join(' | '));
  check('it will not eat a longer word that starts with a name',
    env.quirkScrub('Kotoha holds the street.', ['Koto']) === 'Kotoha holds the street.',
    'word-bounded, or "Koto" rewrites "Kotoha"');
  check('and a fragment shorter than four letters is never used',
    env.quirkScrub('The arm and the leg.', ['arm', 'leg']) === 'The arm and the leg.',
    'a three-letter fragment of a name would rewrite ordinary words');
  check('prose with no name in it comes through untouched',
    env.quirkScrub('A concussive shock through the floor.', ['Kakita'])
      === 'A concussive shock through the floor.');
  check('and nothing is attempted with no names to go on',
    env.quirkScrub('Kakita throws.', []) === 'Kakita throws.'
    && env.quirkScrub(null, ['Kakita']) === '');

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

  return repoEnv(null, {}).then(async ({ quirks, sources, failed, names }) => {
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

    check('every entry carries what the page needs to show',
      quirks.every(q => q.quirk && q.type && Array.isArray(q.abilities)
        && Number.isInteger(q.held) && q.held >= 0),
      JSON.stringify(quirks.filter(q => !(q.quirk && q.type && Array.isArray(q.abilities)
        && Number.isInteger(q.held) && q.held >= 0)).slice(0, 2)));
    check('a quirk somebody in the campaign has is counted as held',
      quirks.filter(q => q.from !== 'The Quirk Compendium').every(q => q.held >= 1),
      quirks.filter(q => q.from !== 'The Quirk Compendium' && q.held < 1)
        .map(q => q.quirk).join(', '));
    check('and one that is only in the book is held by nobody',
      quirks.filter(q => q.from === 'The Quirk Compendium').every(q => q.held === 0),
      '"1 person has it" would be wrong about a quirk nobody in the campaign has');
    check('the book is one of the sources the page reports',
      sources.includes('the Quirk Compendium'), sources.join(', '));
    check('and it is most of the database now',
      quirks.filter(q => q.page).length >= 150,
      quirks.filter(q => q.page).length + ' entries cite a page in the Compendium');
    const withAbilities = quirks.filter(q => q.abilities.length);
    check('and a good number of them have abilities recorded',
      withAbilities.length >= 25, withAbilities.length + ' with abilities');

    const q = quirks[0];
    check('search is an AND across every field of an entry',
      env.quirkMatches(q, q.quirk.split(' ')[0].toLowerCase()) === true
      && env.quirkMatches(q, q.quirk + ' definitelynotinthere') === false);
    check('and an empty query matches everything',
      quirks.every(x => env.quirkMatches(x, '')));

    /* ── 5b. nobody is named ── */
    // Every name the campaign knows, against every field the page renders.
    // This is the check the whole no-names change exists for.
    const everything = quirks.flatMap(x => [x.quirk, x.summary, x.weakness, x.source,
      x.from, ...(x.alsoFrom || []), ...x.abilities.flatMap(a => [a.name, a.text])])
      .filter(Boolean).join('\n');
    const leaked = (names || []).filter(n => {
      if (n.length < 4) return false;
      return new RegExp('(^|[^A-Za-z\\u00c0-\\u024f])'
        + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        + '(?![A-Za-z\\u00c0-\\u024f])').test(everything);
    });
    check('no character name survives anywhere in the database',
      leaked.length === 0, leaked.join(', '));
    check('and the loader knew enough names for that to mean something',
      (names || []).length >= 100, (names || []).length + ' names and name parts');
    for (const who of ['Kakita', 'Domoto', 'Alucard', 'Suzuki']) {
      check(`searching for "${who}" finds nothing`,
        quirks.filter(x => env.quirkMatches(x, who)).length === 0);
    }
    check('while a quirk is still findable',
      quirks.filter(x => env.quirkMatches(x, 'fire')).length > 0
      && quirks.filter(x => env.quirkMatches(x, 'emitter')).length > 0);

    const f = env.quirkFacets(quirks);
    check('the facets count the types and the sources',
      f.types.length >= 3 && f.froms.length >= 3
      && f.types.reduce((n, [, c]) => n + c, 0) === quirks.length,
      JSON.stringify(f.types));

    /* ── 6. escaping, and taking one to the bench ── */
    env.quirks = [{ quirk: 'Beams From The Eyes', type: 'Transformation', rarity: 'Rare',
      summary: '', weakness: 'Burns stamina.', source: '', from: 'Class 1-A (live)',
      alsoFrom: [], held: 1,
      abilities: [{ name: 'Laser Beam', type: 'Action', text: 'Fires a beam.',
        damage: '3d8', attackBonus: '+6' }] }];
    env.setView('quirks');
    check('the database renders a card per entry',
      /Beams From The Eyes/.test(els['lab-quirks-list'].innerHTML));
    check('and the card header carries no name, only the quirk',
      !/lb-quirk-who">[A-Z]/.test(els['lab-quirks-list'].innerHTML),
      (els['lab-quirks-list'].innerHTML.match(/lb-quirk-who">[^<]*/) || [''])[0]);

    env.benchFrom('Beams From The Eyes', 'Laser Beam');
    check('a recorded ability can be taken onto the workbench',
      env.a.name === 'Laser Beam' && env.a.damage === '3d8'
      && env.a.attackBonus === '+6' && env.a.hitMode === 'attack',
      JSON.stringify({ n: env.a.name, d: env.a.damage, b: env.a.attackBonus }));
    check('and it computes once it is there',
      env.expectedDamage().dmg.min === 3 && env.expectedDamage().dmg.max === 24);
    const held = env.a.name;
    env.benchFrom('No such quirk', 'Nothing');
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

    /* ── 7. the turn sheet ── */
    // The cost bucket, against all fourteen distinct `type` values the live
    // bundle actually contains. A turn sheet that files a reaction under
    // actions is a turn sheet that gets somebody killed.
    const costCases = [
      ['Action', 'action'], ['Attack', 'action'], ['Full-turn Action', 'action'],
      ['Action (unlocks at level 10)', 'action'],
      ['Action (Dragon Form only, recharge 5-6)', 'action'],
      ['Action (all 4 cannons, recharge long rest)', 'action'],
      ['Attack (ranged, 60/120 ft)', 'action'],
      ['Attack (requires Dragon Form or natural scale state)', 'action'],
      ['Bonus Action', 'bonus'],
      // Read as a bonus action before the bare "action" test can claim it.
      ['Bonus Action / Reaction', 'bonus'],
      ['Reaction', 'reaction'],
      ['Passive', 'passive'], ['Passive / Unarmed Strike', 'passive'], ['Passive/Action', 'passive'],
      ['', 'other'], [null, 'other'], [undefined, 'other'], ['Something else entirely', 'other'],
    ];
    const miscost = costCases.filter(([t, want]) => env.charCostOf(t) !== want);
    check('every ability type the live bundle contains lands in the right bucket',
      miscost.length === 0,
      miscost.map(([t, w]) => `${JSON.stringify(t)} → ${env.charCostOf(t)}, want ${w}`).join(' | '));

    // The first rollable die out of a damage string that is mostly prose.
    const diceCases = [
      ['1d12 / 2 heat points', '1d12'], ['8d6 / 10 heat points', '8d6'], ['2d6', '2d6'],
      ['3d6 piercing, range 40/120', '3d6'],
      ['2d6 slashing, two-handed, heavy, finesse. A traditional wrap.', '2d6'],
      ['1d8+2 bludgeoning', '1d8+2'], ['d20', '1d20'], ['4d6kh3 somehow', '4d6kh3'],
      // The first DICE expression, not the first number: "10 heat points" is
      // a cost, and offering to roll it would be offering nonsense.
      ['10 heat points then 2d6', '2d6'],
      ['N/A', null], ['n/a', null], ['', null], ['ten damage', null],
      ['2d', null], ['d0', null], [null, null],
    ];
    const misread = diceCases.filter(([t, want]) => env.charDiceIn(t) !== want);
    check('the first rollable die is pulled out of a damage string that is mostly prose',
      misread.length === 0,
      misread.map(([t, w]) => `${JSON.stringify(t)} → ${JSON.stringify(env.charDiceIn(t))}, want ${JSON.stringify(w)}`).join(' | '));

    // The universal options come from the rules reference rather than being
    // written again, so the Lab and the Rules page cannot disagree.
    const universal = env.labUniversal();
    check('the standard options are lifted out of the rules reference',
      universal.length >= 12 && universal.some(u => u.name === 'Disengage')
      && universal.some(u => u.name === 'Opportunity attack'),
      universal.length + ' options');
    check('and each one carries the rule\'s own text rather than a retelling',
      universal.every(u => u.text && u.text.length > 25));
    check('an opportunity attack is filed as a reaction, not an action',
      universal.find(u => u.name === 'Opportunity attack').cost === 'Reaction');

    // A character shaped exactly like a live one, messy fields and all.
    const sheet = {
      _file: 'test.json', name: 'Test Character', quirk: 'Test Quirk', level: '1',
      HP: '35', AC: '14', speed: '30 ft', quirk_save_DC: '13', proficiency_bonus: '2',
      ability_scores: { STR: '14', DEX: '18', CON: '20', INT: '13', WIS: '10', CHA: '10', TECH: '4' },
      modifiers: { STR: '2', DEX: '4', CON: '5', INT: '1', WIS: '0', CHA: '0', TECH: '-3' },
      quirk_mechanics: { weakness: 'Burns stamina fast.', abilities: [
        { name: 'Beam', type: 'Action', damage: '1d12 / 2 heat points', range: '80 feet', description: 'A beam.' },
        { name: 'Charge', type: 'Full-turn Action', damage: 'N/A', description: 'Charges.' },
        { name: 'Shields', type: 'Passive / Unarmed Strike', damage: '', description: 'Always on.' },
        { name: 'Snap', type: 'Bonus Action / Reaction', damage: '2d6', description: 'Once a turn.' },
        { name: 'Reflect', type: 'Reaction', damage: '', description: 'When hit.' },
      ] },
      inventory: { items: [
        { id: 'i1', name: 'Katana', qty: 1, notes: '2d6 slashing, two-handed, heavy, finesse.' },
        { id: 'i2', name: 'Rations', qty: 3, notes: 'Three days of food.' },
      ], currency: { yen: 0 } },
    };
    const can = env.charCanDo(sheet, universal);
    check('an ability with a real die is rollable and one with "N/A" is not',
      can.rows.find(r => r.name === 'Beam').dice === '1d12'
      && can.rows.find(r => r.name === 'Charge').dice === null
      && can.rows.find(r => r.name === 'Charge').damage === '',
      'the page must not offer to roll "N/A"');
    check('carried gear that states a die becomes something you can do',
      can.rows.some(r => r.from === 'gear' && r.name === 'Katana' && r.dice === '2d6'));
    check('and gear that does not is left out rather than listed as an attack',
      !can.rows.some(r => r.name === 'Rations'),
      'three days of food is not an action');
    check('the original type text is kept beside the bucket',
      can.rows.find(r => r.name === 'Charge').costText === 'Full-turn Action',
      '"recharge 5-6" and "Dragon Form only" are the half a bucket throws away');
    check('every row says where it came from',
      can.rows.every(r => ['quirk', 'gear', 'rule'].includes(r.from)));
    check('and the groups cover every row with none lost',
      env.CHAR_COSTS.reduce((n, c) => n + can.grouped[c].length, 0) === can.rows.length);
    check('a character with nothing recorded still gets the standard options',
      env.charCanDo({}, universal).rows.length === universal.length);
    check('and no character at all does not throw',
      env.charCanDo(null, universal).rows.length === universal.length);

    /* which characters are yours */
    env.loaded = true;
    env.src = 'firestore';
    ACCESS.admin = false;
    ACCESS.owned = [];
    env.mine = [];
    env.setView('mine');
    check('with nothing assigned the page says so and says what to ask for',
      /No character is assigned to you yet/.test(els['lab-mine'].innerHTML)
      && /admin page/.test(els['lab-mine'].innerHTML)
      && /workbench, and the quirk database/.test(els['lab-mine'].innerHTML),
      'and that the rest of the Lab works anyway');

    ACCESS.owned = ['Student (1-A)::Test Character'];
    env.mine = [sheet];
    env.setView('mine');
    const mine = () => els['lab-mine'].innerHTML.replace(/\s+/g, ' ');
    check('one character assigned shows that character and no picker',
      /Test Character/.test(mine()) && !/lb-char-tab"/.test(mine()));
    check('grouped by what it costs, with a heading per group that has rows',
      (mine().match(/lb-do-group/g) || []).length === 5,
      (mine().match(/lb-do-group/g) || []).length + ' groups');
    check('every row rendered',
      (mine().match(/class="lb-do /g) || []).length === can.rows.length,
      `${(mine().match(/class="lb-do /g) || []).length} of ${can.rows.length}`);
    check('the seven abilities are there to roll a check or a save against',
      (mine().match(/class="lb-mod"/g) || []).length === 7);
    check('and the quirk\'s weakness is on it',
      /Burns stamina fast/.test(mine()));
    check('with a link to the printable sheet for the same character',
      /sheet\.html\?c=test\.json/.test(mine()));

    env.mine = [sheet, Object.assign({}, sheet, { _file: 'b.json', name: 'Second' })];
    env.setView('mine');
    const tabCount = (mine().match(/class="lb-char-tab[ "]/g) || []).length;
    check('two assigned gets a picker', tabCount === 2,
      tabCount + ' tabs — the container is lb-char-tabS, which a prefix match counts');
    env.labPickChar('b.json');
    check('and picking switches which one is on screen',
      /lb-char-name">Second</.test(els['lab-mine'].innerHTML));

    // An admin sees the class, which is what a DM wants from this page.
    ACCESS.admin = true;
    check('isAdmin is what decides an admin sees everybody',
      /window\.isAdmin && window\.isAdmin\(\)/.test(pageJs)
      && /labMine = admin \? chars/.test(pageJs));
    check('and ownership otherwise goes through canEdit and the one key definition',
      /window\.canEdit\(fbCharacterKey\(/.test(pageJs),
      'three files spelling that key out separately is how the Heropad once matched nothing');

    /* rolling a row */
    env.mine = [sheet];
    env.setView('mine');
    env.rollRow('quirk-0-Beam', '1d12');
    const rolled = els['lab-mine'].innerHTML.match(/lb-do-rolled[^>]*>\s*<strong>(\d+)<\/strong>/);
    check('a row with a die rolls it and shows the result beside it',
      rolled && Number(rolled[1]) >= 1 && Number(rolled[1]) <= 12, rolled ? rolled[1] : 'nothing shown');
    const naturals = new Set();
    for (let i = 0; i < 400; i++) {
      env.rollRow('save-DEX', '1d20+4');
      const m = els['lab-mine'].innerHTML.match(/lb-mod-roll">(\d+)<[\s\S]*?lb-mod-raw">([^<]*)</);
      if (m) naturals.add(Number(String(m[2]).trim().split(' ')[0]));
    }
    check('a save shows the natural roll as well as the total, 1 through 20',
      Math.min(...naturals) === 1 && Math.max(...naturals) === 20,
      `${Math.min(...naturals)}–${Math.max(...naturals)}`);
    check('and a 20 on a save is not called a critical, because only attacks crit',
      !/is-crit/.test(els['lab-mine'].innerHTML.match(/lb-mods[\s\S]*?lb-mods-note/)[0]),
      'the rules reference says so and this page does not disagree with it');
    env.rollRow('quirk-0-Beam', 'not a die');
    check('asking to roll something unreadable does nothing rather than throwing',
      true);

    env.benchRow('Katana', '2d6', 'Attack with it');
    check('a row can be taken onto the workbench',
      env.view === 'bench' && env.a.name === 'Katana' && env.a.damage === '2d6');

    /* escaping, on the turn sheet too */
    env.setView('mine');
    env.mine = [Object.assign({}, sheet, {
      name: '<img src=x onerror=alert(1)>', quirk: '<script>bad</script>', speed: '<b>30</b>',
      quirk_mechanics: { weakness: '<u>w</u>',
        abilities: [{ name: '<i>a</i>', type: 'Action', damage: '2d6', description: '<svg/>' }] },
      inventory: { items: [{ id: 'x', name: '<iframe>', notes: '2d6 <script>x</script>' }], currency: {} },
    })];
    env.setView('mine');
    const sheetTags = els['lab-mine'].innerHTML.match(/<(script|img|iframe|svg)[ >/]/g) || [];
    check('nothing on a character can become a tag on the turn sheet',
      sheetTags.length === 0, [...new Set(sheetTags)].join(' '));
    check('and it comes back as entities',
      els['lab-mine'].innerHTML.includes('&lt;img src=x')
      && els['lab-mine'].innerHTML.includes('&lt;script&gt;'));

    /* ── 8. the player's own record ── */
    const pcSheet = {
      _file: 'test.json', name: 'Test Character', quirk: 'Test Quirk', level: '1',
      HP: '35', AC: '14', speed: '30 ft',
      ability_scores: { STR: '14', DEX: '18', CON: '20', INT: '13', WIS: '10', CHA: '10', TECH: '4' },
      modifiers: { STR: '2', DEX: '4', CON: '5', INT: '1', WIS: '0', CHA: '0', TECH: '-3' },
      quirk_mechanics: { abilities: [{ name: 'Beam', type: 'Action', damage: '1d12', description: 'A beam.' }] },
      inventory: { items: [] },
    };
    ACCESS.admin = true;
    env.mine = [pcSheet];
    env.loaded = true;
    env.canWrite = true;
    env.record = env.recordEmpty();
    env.catalog = shopCatalog;
    env.render();

    check('there are four tabs now, with the record among them',
      [...els['lab-tabs'].innerHTML.matchAll(/>([^<]+)<\/button>/g)].map(m => m[1]).join('|')
        === 'Your character|Workbench|Your record|Quirk database',
      [...els['lab-tabs'].innerHTML.matchAll(/>([^<]+)<\/button>/g)].map(m => m[1]).join('|'));

    /* the equipment bench, priced off the real catalogue */
    check('the gear kinds are the shop\'s own categories',
      env.RECORD_GEAR_KINDS.every(k =>
        (shopCatalog.items || []).some(i => i.category === k.id)),
      env.RECORD_GEAR_KINDS.filter(k =>
        !(shopCatalog.items || []).some(i => i.category === k.id)).map(k => k.id).join(', '));

    const avgCases = [['2d6', 7], ['2d6 piercing', 7], ['1d12', 6.5], ['3d6 piercing', 10.5],
      ['1d8+2', 6.5], ['8d6', 28], ['N/A', null], ['', null], [null, null]];
    const wrongAvg = avgCases.filter(([e, want]) => env.recordDiceAverage(e) !== want);
    check('a damage string is averaged exactly, not sampled',
      wrongAvg.length === 0,
      wrongAvg.map(([e, w]) => `${JSON.stringify(e)} → ${env.recordDiceAverage(e)}, want ${w}`).join(' | '));

    const comps = env.recordComparables(shopCatalog, '2d6', { category: 'melee' });
    check('a crafted weapon is compared to real stock of the same size',
      comps.length >= 2 && comps.every(x => Math.abs(x.avg - 7) <= 2)
      && comps.every(x => x.item.price),
      comps.map(x => `${x.item.name} ${x.item.damage} ¥${x.item.price}`).join(' | '));
    check('cheapest first, so the comparison reads as a range',
      comps.every((x, i, all) => i === 0 || Number(all[i - 1].item.price) <= Number(x.item.price)));
    check('the suggested price is the real median of them',
      (() => {
        const prices = comps.map(x => Number(x.item.price)).sort((a, b) => a - b);
        const half = Math.floor(prices.length / 2);
        const median = prices.length % 2 ? prices[half] : (prices[half - 1] + prices[half]) / 2;
        return env.recordSuggestedPrice(shopCatalog, '2d6', { category: 'melee' })
          === Math.round(median / 1000) * 1000;
      })(),
      'with an even number of comparables the first version took the dearer '
      + 'of the two middles, which quietly suggested the expensive half');
    check('and something with no dice gets no price rather than an invented one',
      env.recordComparables(shopCatalog, '', { category: 'suits-student' }).length === 0
      && env.recordSuggestedPrice(shopCatalog, 'a costume part', {}) === null,
      'not everything has a number');

    env.setView('bench');
    env.setBenchMode('gear');
    check('the equipment bench is a form of its own, not the ability form with fields hidden',
      env.mode === 'gear' && /Made of/.test(els['lab-body'].innerHTML)
      && !/Resolved by/.test(els['lab-body'].innerHTML));
    env.setGear('name', 'Reinforced tonfa');
    env.setGear('damage', '2d6 bludgeoning');
    env.setGear('kind', 'melee');
    env.setGear('materials', 'Scrap and a bus handrail');
    check('it prices what you are making as you type',
      /¥27,000/.test(els['lab-gear-price'].innerHTML)
      || /lb-price-num/.test(els['lab-gear-price'].innerHTML),
      els['lab-gear-price'].innerHTML.replace(/\s+/g, ' ').slice(0, 90));
    env.rollGear();
    check('and rolls its damage',
      /^\d+ /.test(els['lab-gear-roll'].textContent), els['lab-gear-roll'].textContent);
    env.setGear('damage', 'no dice here');
    env.rollGear();
    check('with nothing rollable it says so rather than throwing',
      /Nothing to roll/.test(els['lab-gear-roll'].textContent));
    env.setGear('damage', '2d6 bludgeoning');

    env.saveAsGear();
    check('saving it records the shop\'s own field names',
      env.record.gear.length === 1
      && ['name', 'kind', 'damage', 'range', 'properties', 'materials', 'price', 'description']
        .every(k => k in env.record.gear[0]),
      Object.keys(env.record.gear[0]).join(', '));
    env.setGear('properties', 'Light, Thrown');
    env.saveAsGear();
    check('and saving the same name again refines rather than duplicating',
      env.record.gear.length === 1 && env.record.gear[0].properties === 'Light, Thrown');
    env.setGear('name', '  ');
    env.saveAsGear();
    check('a nameless item is refused with a reason',
      env.record.gear.length === 1 && /name/i.test(els['lab-record-state'].textContent));

    /* a move, off the ability bench */
    env.setBenchMode('ability');
    env.a = Object.assign(env.a, { name: 'Snap shot', type: 'Bonus action', damage: '2d6',
      range: '30 feet', description: 'Once a turn.', targetAc: '16', advantage: 'adv' });
    env.saveAsMove();
    check('an ability can be saved into your own move list',
      env.record.moves.length === 1 && env.record.moves[0].name === 'Snap shot'
      && env.record.moves[0].damage === '2d6');
    check('and the workbench\'s own working-out does not go with it',
      !('targetAc' in env.record.moves[0]) && !('advantage' in env.record.moves[0])
      && !('hitMode' in env.record.moves[0]),
      Object.keys(env.record.moves[0]).join(', '));
    env.a = Object.assign(env.a, { description: 'Refined.' });
    env.saveAsMove();
    check('saving the same move name again refines rather than duplicating',
      env.record.moves.length === 1 && /Refined/.test(env.record.moves[0].description),
      `${env.record.moves.length} moves — the gear path was checked for this and `
      + 'the move path was not');
    // An expression the engine cannot read must not be stored: a move
    // carrying "about two d6" is a Roll button that does nothing.
    env.a = Object.assign(env.a, { name: 'Vague swing', damage: 'about two d6' });
    env.saveAsMove();
    check('and an unreadable damage expression is dropped rather than stored',
      env.record.moves.find(m => m.name === 'Vague swing').damage === '',
      JSON.stringify(env.record.moves.find(m => m.name === 'Vague swing')));
    env.record.moves = env.record.moves.filter(m => m.name === 'Snap shot');
    env.a = Object.assign(env.a, { name: 'Snap shot', damage: '2d6' });

    /* the turn sheet carries both */
    const own = env.recordMoveRows(env.record).concat(env.recordGearRows(env.record));
    const grouped = env.charCanDo(pcSheet, env.labUniversal(), own).grouped;
    check('a written move lands in the group its cost says',
      grouped.bonus.some(r => r.name === 'Snap shot' && r.from === 'move'),
      grouped.bonus.map(r => r.from + ':' + r.name).join(', '));
    check('a crafted weapon is an action',
      grouped.action.some(r => r.name === 'Reinforced tonfa' && r.from === 'crafted'));
    check('and a crafted thing with no dice is not an attack',
      (() => {
        const rows = env.recordGearRows({ gear: [{ id: 'v', name: 'Visor', kind: 'suits-student' }] });
        return rows[0].cost === 'passive' && rows[0].dice === null;
      })(), 'a costume part costs nothing to have');
    check('the quirk\'s own abilities still come first in their group',
      grouped.action[0].from === 'quirk',
      'a thing out of the handbook and a thing invented on Tuesday are both '
      + 'listed, and the handbook goes first');
    env.setView('mine');
    check('and both are visibly marked as yours on the sheet',
      /from-move/.test(els['lab-mine'].innerHTML)
      && /from-crafted/.test(els['lab-mine'].innerHTML));
    check('with a colour of their own in the stylesheet',
      /\.lb-do\.from-move/.test(pageCss) && /\.lb-do\.from-crafted/.test(pageCss));

    /* the stats, and a disagreement */
    env.setView('record');
    const rec = () => els['lab-record'].innerHTML.replace(/\s+/g, ' ');
    check('the record shows the DM\'s copy of every number',
      /lb-stat-theirs">35</.test(rec()) && /lb-stat-theirs">\+4</.test(rec()),
      'four headline stats and all seven abilities');
    env.setStat('HP', '42');
    check('a disagreement is flagged rather than resolved',
      /lb-stat-flag/.test(rec()) && rec().includes('>35<') && rec().includes('42'),
      'both numbers stay visible — that is a conversation, not a bug');
    env.setStat('HP', '35');
    check('and agreeing clears the flag', !/lb-stat-flag/.test(rec()));
    env.setStat('HP', '');
    check('clearing your note drops it entirely rather than storing a blank',
      !('HP' in env.record.stats));
    env.setStat('modDEX', '6');
    check('an ability modifier can disagree too', /lb-stat-flag/.test(rec()));
    env.clearStat('modDEX');
    check('nothing in the record is a write into the character',
      !/relationships-bundle/.test(recordJs.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')),
      'it is a document of its own — see the note at the top of player-record.js');

    /* perks */
    els['lab-perk-name'].value = 'Iron Stomach';
    els['lab-perk-from'].value = 'Samitsu';
    els['lab-perk-text'].value = 'Advantage on saves against anything you ate.';
    env.addPerk();
    check('a perk records what it is, where it came from and what it does',
      env.record.perks.length === 1 && env.record.perks[0].name === 'Iron Stomach'
      && env.record.perks[0].from === 'Samitsu' && /anything you ate/.test(env.record.perks[0].text));
    check('and the form clears so the next one is quick',
      els['lab-perk-name'].value === '' && els['lab-perk-text'].value === '');
    els['lab-perk-name'].value = '   ';
    env.addPerk();
    check('a nameless perk is refused',
      env.record.perks.length === 1 && /name/i.test(els['lab-record-state'].textContent));
    env.deletePerk(env.record.perks[0].id);
    check('and one can be removed', env.record.perks.length === 0);

    /* rolling and editing your own */
    env.rollOwn('move-' + env.record.moves[0].id, '2d6');
    check('a written move can be rolled from the record',
      /lb-own-roll-out/.test(rec()));
    env.editMove(env.record.moves[0].id);
    check('and taken back to the ability bench to be refined',
      env.view === 'bench' && env.mode === 'ability' && env.a.name === 'Snap shot');
    env.setView('record');
    env.editGear(env.record.gear[0].id);
    check('a crafted item goes back to the equipment bench',
      env.view === 'bench' && env.mode === 'gear' && env.gear.name === 'Reinforced tonfa');
    const heldName = env.gear.name;
    env.editGear('no-such-id');
    check('editing something that does not exist changes nothing',
      env.gear.name === heldName);

    /* storage */
    await new Promise(r => setTimeout(r, 800));
    const sheets = WRITES.filter(w => /^labsheet-/.test(w[0]));
    check('the record is one document per character, like the Heropad\'s pads',
      sheets.length > 0 && sheets[0][0] === 'labsheet-test',
      sheets.length ? sheets[0][0] : 'nothing written');
    check('merged rather than replacing the document',
      sheets.every(w => w[2] && w[2].merge === true));
    check('and kept in this browser too',
      Object.keys(store).some(k => /^mha-labsheet-v1-/.test(k)));
    const beforeRead = WRITES.length;
    env.canWrite = false;
    env.setStat('AC', '18');
    await new Promise(r => setTimeout(r, 800));
    check('a reader sends nothing to the server',
      WRITES.length === beforeRead, `${WRITES.length - beforeRead} writes`);
    check('a failed save is said out loud rather than swallowed',
      /could not save your record/.test(pageJs) && /console\.error/.test(pageJs));
    env.canWrite = true;

    /* a record half-written by an older version must not take the tab down */
    {
      const loader = new Function('sandbox', `
        ${recordJs}
        return (bad) => recordLoad(
          { collection: () => ({ doc: () => ({ get: () => Promise.resolve({ exists: true, data: () => bad }) }) }) },
          'x.json',
          { getItem: () => null, setItem() {} });
      `)({});
      const repaired = await loader({ moves: 'not a list', gear: null, perks: 7, stats: 'nope' });
      check('a document with the wrong shape in it is repaired on load',
        Array.isArray(repaired.moves) && Array.isArray(repaired.gear)
        && Array.isArray(repaired.perks)
        && repaired.stats && typeof repaired.stats === 'object',
        JSON.stringify({ moves: typeof repaired.moves, gear: typeof repaired.gear,
          perks: typeof repaired.perks, stats: typeof repaired.stats }));
      const empty = await loader({});
      check('and a document with nothing in it loads as an empty record',
        empty.moves.length === 0 && empty.gear.length === 0 && empty.perks.length === 0);
    }

    /* nobody assigned */
    env.mine = [];
    env.loaded = true;
    env.setView('record');
    check('with no character assigned the record says so',
      /No character is assigned to you yet/.test(els['lab-record'].innerHTML)
      && /admin page/.test(els['lab-record'].innerHTML));

    /* escaping, on the record too */
    env.mine = [pcSheet];
    env.record = {
      moves: [{ id: 'm', name: '<script>m</script>', type: 'Action', damage: '2d6', description: '<iframe>' }],
      gear: [{ id: 'g', name: '<img src=x onerror=alert(1)>', kind: 'melee', damage: '<svg/>',
        properties: '<b>p</b>', materials: '<u>u</u>' }],
      perks: [{ id: 'p', name: '<script>p</script>', from: '<b>f</b>', text: '<iframe>' }],
      stats: { HP: '<svg/>' }, note: '<script>n</script>',
    };
    env.setView('record');
    const recordTags = els['lab-record'].innerHTML.match(/<(script|img|iframe|svg)[ >/]/g) || [];
    check('nothing in your own record can become a tag',
      recordTags.length === 0, [...new Set(recordTags)].join(' '));
    check('and it comes back as entities',
      els['lab-record'].innerHTML.includes('&lt;img src=x')
      && els['lab-record'].innerHTML.includes('&lt;script&gt;'));
    ACCESS.admin = false;

    /* the page */
    check('the page loads every data file before its own script',
      ['dice.js', 'quirk-data.js', 'char-data.js', 'rules-data.js', 'player-record.js'].every(f =>
        pageHtml.indexOf('src="' + f + '"') !== -1
        && pageHtml.indexOf('src="' + f + '"') < pageHtml.indexOf('src="lab.js"')),
      ['dice.js', 'quirk-data.js', 'char-data.js', 'rules-data.js', 'player-record.js']
        .filter(f => pageHtml.indexOf('src="' + f + '"') === -1).join(', '));
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
