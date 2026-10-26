#!/usr/bin/env node
// Regression check for the rules reference — rules-data.js and the three
// places that read it: rules.html (everyone), the Encounter Manager's Rules
// panel (the DM), and the Heropad's Rules app (in a player's pocket).
//
// Why it exists: the conditions and cover lines used to be literals inside
// encounter.js, and the obvious way to build a player-facing reference was to
// copy them. Two copies of fourteen rules is a drift waiting to happen, so
// there is now one file and this script holds every reader to it.
//
// What it guards:
//   1. The data is well formed: every section has an id, an icon, a blurb and
//      entries, and every entry is a one-line summary rather than a block of
//      quoted rulebook text.
//   2. Nothing campaign-specific has leaked in. This is the rules reference;
//      NPCs, locations and story beats have their own pages, and a name in
//      here is a sign someone put the wrong thing in the wrong file.
//   3. Every page that reads it loads it first, and renders through escHtml.
//   4. The search is a real AND across name, text, tags and section — the
//      thing the page is actually for.
//   5. The highlighter cannot inject markup, however the data is written.

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

// Compares the position of two <script src> TAGS, not of any mention of the
// filename: heropad.html names heropad.js in a comment forty lines above the
// tag that loads it, which quietly made a plain indexOf comparison true for
// the wrong reason.
function scriptOrder(html, firstSrc, secondSrc) {
  const a = html.indexOf('src="' + firstSrc + '"');
  const b = html.indexOf('src="' + secondSrc + '"');
  return a !== -1 && b !== -1 && a < b;
}

let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log('PASS — ' + label); return; }
  failures++;
  console.error('FAIL — ' + label + (detail ? '\n        ' + detail : ''));
}

const dataSrc = read('rules-data.js');
const env = new Function(dataSrc + `
  return { RULES_REFERENCE, rulesSection, rulesConditionMap, rulesCoverRows,
           rulesEntryCount, rulesEntryMatches,
           CONDITION_ATTACK_EFFECTS, rulesAttackMode };`)();
const SECTIONS = env.RULES_REFERENCE.sections;
const ENTRIES = SECTIONS.flatMap(s => s.entries.map(e => ({ e, s })));

/* ── 1. the data ── */
{
  check('the reference loaded and has sections to show',
    Array.isArray(SECTIONS) && SECTIONS.length >= 8, SECTIONS.length + ' sections');
  check('it says, on the page, that it is a summary and where the real text is',
    /in our own words/i.test(env.RULES_REFERENCE.source)
    && /rulebook/i.test(env.RULES_REFERENCE.source));

  const badShape = SECTIONS.filter(s =>
    !s.id || !/^[a-z0-9-]+$/.test(s.id) || !s.name || !s.icon || !s.blurb
    || !Array.isArray(s.entries) || !s.entries.length);
  check('every section has an id, a name, an icon, a blurb and entries',
    badShape.length === 0, badShape.map(s => s.id || '(no id)').join(', '));

  const ids = SECTIONS.map(s => s.id);
  check('and no two sections share an id — the id is the anchor in the URL',
    new Set(ids).size === ids.length, ids.join(', '));

  const badEntry = ENTRIES.filter(({ e }) => !e.name || !e.text || e.text.length < 30);
  check('every rule has a name and actually says something',
    badEntry.length === 0, badEntry.map(({ e }) => e.name || '(unnamed)').join(', '));

  // Same bound the conditions reference has always been held to: a reference
  // like this is only defensible as a restatement of how a mechanic works.
  const longest = ENTRIES.map(({ e }) => e).sort((a, b) => b.text.length - a.text.length)[0];
  check('each rule is a one-line summary rather than a block of quoted text',
    longest.text.length <= 240, `"${longest.name}" is ${longest.text.length} characters`);

  const names = ENTRIES.map(({ e }) => e.name);
  check('no rule is listed twice under the same name',
    new Set(names).size === names.length,
    names.filter((n, i) => names.indexOf(n) !== i).join(', '));

  check('there are enough of them to be worth a page',
    env.rulesEntryCount() >= 80, env.rulesEntryCount() + ' rules');
}

/* ── 2. no campaign material ── */
{
  // The whole point of this page is that it is the part of the site with no
  // story in it: a player can open it without being spoiled, and it stays
  // true between campaigns. These are the proper nouns of the current one.
  const campaignWords = ['Byakko', 'Swing Town', 'Underground', 'Appetite', 'Shortlist',
    'Kurogane', 'U.A.', 'Toragi', 'Hiro', 'Kuma'];
  const leaked = ENTRIES.filter(({ e }) =>
    campaignWords.some(w => (e.name + ' ' + e.text + ' ' + (e.tags || '')).includes(w)));
  check('no campaign name, place or NPC has leaked into the rules reference',
    leaked.length === 0, leaked.map(({ e }) => e.name).join(', '));

  // "At this table" is the one section allowed to talk about the toolkit, and
  // it has to actually be about the toolkit or it is just more rules.
  const table = env.rulesSection('at-this-table');
  check('the house section exists and is about the toolkit, not the rulebook',
    table && table.entries.filter(e =>
      /board|pad|shop|session log|toolkit|dm/i.test(e.name + ' ' + e.text)).length >= 5);
}

/* ── 2b. the conditions, as mechanics ── */
{
  const EFFECTS = env.CONDITION_ATTACK_EFFECTS;
  const conditions = env.rulesSection('conditions').entries;
  const names = conditions.map(e => e.name);

  check('every condition has a line in the machine-readable table',
    names.filter(n => !EFFECTS[n]).length === 0,
    names.filter(n => !EFFECTS[n]).join(', '));
  check('and the table describes no condition that does not exist',
    Object.keys(EFFECTS).filter(n => !names.includes(n)).length === 0,
    Object.keys(EFFECTS).filter(n => !names.includes(n)).join(', '));

  const VALUES = ['adv', 'dis', 'none', 'cannot', 'ask'];
  const badValue = Object.entries(EFFECTS).filter(([, e]) =>
    !VALUES.includes(e.attacking) || !VALUES.includes(e.attacked) || e.attacked === 'cannot');
  check('every entry uses a value the resolver understands',
    badValue.length === 0, badValue.map(([n]) => n).join(', '));
  check('and every "ask" says what the question is',
    Object.entries(EFFECTS).filter(([, e]) =>
      (e.attacking === 'ask' || e.attacked === 'ask') && !e.note).length === 0);

  // The cross-check that is the whole point of having both forms: the table a
  // tracker acts on and the prose a player reads describe the same mechanic,
  // so one cannot be corrected without the other.
  const byName = {};
  for (const e of conditions) byName[e.name] = e.text.toLowerCase();
  const disagree = [];
  for (const [name, e] of Object.entries(EFFECTS)) {
    const text = byName[name];
    if (e.attacked === 'adv' && !/attacks against (you|it) have advantage/.test(text)) {
      disagree.push(`${name}: table says advantage against it, prose does not`);
    }
    if (e.attacked === 'dis' && !/attacks against (you|it) have disadvantage/.test(text)) {
      disagree.push(`${name}: table says disadvantage against it, prose does not`);
    }
    // "yours have disadvantage" is how three of the fourteen are worded —
    // the first version of this pattern missed all three.
    if (e.attacking === 'dis' && !/(your|its|yours) have disadvantage|attacks have disadvantage|disadvantage on attack/.test(text)) {
      disagree.push(`${name}: table says its attacks suffer, prose does not`);
    }
    if (e.attacking === 'adv' && !/yours have advantage|advantage on attack/.test(text)) {
      disagree.push(`${name}: table says its attacks benefit, prose does not`);
    }
    if (e.attacking === 'cannot' && !/incapacitated|no actions/.test(text)) {
      disagree.push(`${name}: table says it cannot attack, prose does not say why`);
    }
  }
  check('the machine-readable table and the prose agree about every condition',
    disagree.length === 0, disagree.join(' | '));

  // And the resolver.
  const M = env.rulesAttackMode;
  check('a clean attack has neither advantage nor disadvantage',
    M([], []).mode === 'none' && M([], []).reasons.length === 0);
  check('a condition on the target can give advantage',
    M([], ['Restrained']).mode === 'adv');
  check('a condition on the attacker can give disadvantage',
    M(['Poisoned'], []).mode === 'dis');
  check('one of each cancels completely — the half people forget',
    M(['Poisoned'], ['Restrained']).mode === 'none'
    && M(['Poisoned'], ['Restrained']).cancelled === true);
  check('two advantages are still just advantage',
    M(['Invisible'], ['Unconscious']).mode === 'adv');
  check('an attacker who cannot act beats everything else',
    M(['Stunned'], ['Restrained']).mode === 'cannot'
    && /stunned/.test(M(['Stunned'], ['Restrained']).reasons[0]));
  check('and the reasons are reported, so a roll is never unexplained',
    M([], ['Restrained']).reasons.join() === 'target is restrained');
  check('a condition whose answer depends on distance is asked, not guessed',
    M([], ['Prone']).mode === 'none' && M([], ['Prone']).asks.length === 1
    && /within 5 ft/.test(M([], ['Prone']).asks[0]),
    JSON.stringify(M([], ['Prone'])));
  check('an unknown condition is ignored rather than throwing',
    M(['Soggy'], ['Nonsense']).mode === 'none');
  check('and so is a missing condition list',
    M(null, undefined).mode === 'none');
}

/* ── 3. the three readers ── */
{
  const pageHtml = read('rules.html');
  const pageJs = read('rules.js');
  check('rules.html loads the shared data before its own script',
    scriptOrder(pageHtml, 'rules-data.js', 'rules.js'));
  check('rules.html has the search box, the rail, the body and an empty state',
    ['id="rules-search"', 'id="rules-rail"', 'id="rules-body"', 'id="rules-empty"']
      .every(id => pageHtml.includes(id)));
  // The markup's own handlers, and the ones the rendered rail wires up — the
  // rail is built in JS, so its handler never appears in the HTML at all.
  check('the handlers in the markup exist in the page script',
    ['onRulesSearch', 'clearRulesSearch'].every(fn =>
      pageHtml.includes(fn + '(') && new RegExp('function ' + fn + '\\(').test(pageJs)));
  check('and so do the ones the rendered rail wires up',
    ['pickSection', 'renderRules', 'renderRail', 'onRulesKey'].every(fn =>
      pageJs.includes(fn + '(') && new RegExp('function ' + fn + '\\(').test(pageJs)));
  check('the page points at the two rulebook PDFs for the full text',
    (pageHtml.match(/RULEBOOKS\//g) || []).length === 2);

  const encJs = read('CLASS-1A/encounter.js');
  const encHtml = read('CLASS-1A/encounter.html');
  check('the Encounter Manager derives its two tables from the shared data',
    /rulesConditionMap\(\)/.test(encJs) && /rulesCoverRows\(\)/.test(encJs));
  check('and loads the shared data before its own script',
    scriptOrder(encHtml, '../rules-data.js', 'encounter.js'));

  const padJs = read('heropad.js');
  const padHtml = read('heropad.html');
  check('the Heropad has a Rules app in its registry, rendered by a real function',
    /id: 'rules',/.test(padJs) && /render: renderRulesApp,/.test(padJs)
    && /function renderRulesApp\(/.test(padJs));
  check('and loads the shared data before heropad.js',
    scriptOrder(padHtml, 'rules-data.js', 'heropad.js'));
  check('the Heropad app reads the shared reference rather than a copy of its own',
    /RULES_REFERENCE\.sections/.test(padJs) && /rulesEntryMatches\(/.test(padJs));

  // Everything either page prints comes from this file, so an apostrophe or
  // an ampersand in a rule has to survive the trip.
  const padRules = padJs.slice(padJs.indexOf('function padRulesListHtml'));
  check('both pages escape every field they print',
    (pageJs.match(/escHtml\(/g) || []).length >= 6
    && ['e.name', 'e.text', 's.icon', 's.name'].every(f => padRules.includes('escHtml(' + f + ')')));

  const dash = read('index.html');
  // Everything between the DM block's opening div and the Rulebooks section
  // that follows it IS the DM block. The reference has to be outside it: the
  // whole reason it exists is that players could not reach the conditions
  // list inside the DM's Encounter Manager.
  const dmBlock = dash.slice(dash.indexOf('<div id="dm-only">'),
    dash.indexOf('<p class="section-label">Rulebooks'));
  check('the dashboard links to the reference',
    dash.includes('href="rules.html"'));
  check('and the link is outside the DM block — this page is for everyone',
    dmBlock.length > 500 && !dmBlock.includes('rules.html'),
    dmBlock.length + ' chars of DM block scanned');

  // The card advertises a number, and a number in hand-written copy drifts
  // the moment a rule is added. This is the only place that count is spelled
  // out — the page, the Heropad app and the nav all compute it.
  const advertised = /(\d+) rules, searchable/.exec(dash);
  check('the number of rules the dashboard card advertises is the number there are',
    advertised && Number(advertised[1]) === env.rulesEntryCount(),
    advertised ? `card says ${advertised[1]}, data has ${env.rulesEntryCount()}` : 'no count on the card');
}

/* ── 3b. the page prints the mechanics beside the prose ── */
{
  const els = {};
  const mk = (id) => ({ id, innerHTML: '', textContent: '', value: '', style: {},
    focus() {}, select() {}, blur() {}, scrollIntoView() {} });
  for (const id of ['rules-rail', 'rules-body', 'rules-empty', 'rules-count',
    'rules-clear', 'rules-search', 'rules-source']) els[id] = mk(id);
  const app = new Function('sandbox', `
    const { document, location, console } = sandbox;
    ${dataSrc}
    ${read('rules.js')}
    return { pickSection };
  `)({
    document: { getElementById: (i) => els[i] || null, addEventListener() {},
      activeElement: null, querySelectorAll: () => [] },
    location: { hash: '' },
    console,
  });

  app.pickSection('conditions');
  // Split on the entry boundary rather than a fixed window: reading 900
  // characters after a name ran into the NEXT condition, so a condition with
  // no badges appeared to have its neighbour's.
  const entries = els['rules-body'].innerHTML.split('<div class="rules-entry">').slice(1);
  check('the conditions section renders one entry per condition',
    entries.length === SECTIONS.find(s => s.id === 'conditions').entries.length,
    entries.length + ' entries');

  const LABEL = { adv: 'advantage', dis: 'disadvantage', cannot: 'cannot attack', ask: 'depends' };
  const mismatched = [];
  for (const block of entries) {
    const name = (block.match(/rules-entry-name">([^<]+)/) || [])[1];
    const chips = [...block.matchAll(/rb-\w+"[^>]*>([^<]+)</g)].map(m => m[1].trim());
    const e = env.CONDITION_ATTACK_EFFECTS[name];
    const want = [];
    if (LABEL[e.attacking]) want.push('its attacks: ' + LABEL[e.attacking]);
    if (LABEL[e.attacked]) want.push('against it: ' + LABEL[e.attacked]);
    if (chips.join('|') !== want.join('|')) {
      mismatched.push(`${name}: shows [${chips}], table says [${want}]`);
    }
  }
  check('and every condition\'s badges say exactly what the table says',
    mismatched.length === 0, mismatched.join(' | '));
  check('a condition that changes no attack roll gets no badge at all',
    (() => {
      const deaf = entries.find(b => /rules-entry-name">Deafened/.test(b));
      return deaf && !/rules-badge/.test(deaf);
    })(), 'silence is the default case, not an empty chip');

  app.pickSection('conditions'); // toggles the section back off
  app.pickSection('the-d20');
  check('no other section carries them',
    !/rules-badge/.test(els['rules-body'].innerHTML));
}

/* ── 4. the search ── */
{
  const cover = env.rulesSection('cover-and-sight');
  const half = cover.entries.find(e => e.name === 'Half cover');
  check('a search is an AND across every word',
    env.rulesEntryMatches(half, cover, 'half cover') === true
    && env.rulesEntryMatches(half, cover, 'half cover elephant') === false);
  check('it searches the hidden tags, not just what is printed',
    ENTRIES.some(({ e, s }) => e.tags && !new RegExp(e.tags.split(' ')[0], 'i').test(e.name + e.text)
      && env.rulesEntryMatches(e, s, e.tags.split(' ')[0])));
  check('it searches the section name too, so "moving terrain" works',
    SECTIONS.some(s => s.entries.some(e => env.rulesEntryMatches(e, s, s.name.split(' ')[0]))));
  check('an empty query matches everything rather than nothing',
    ENTRIES.every(({ e, s }) => env.rulesEntryMatches(e, s, '') && env.rulesEntryMatches(e, s, '   ')));

  // The two things a player will actually type first.
  for (const q of ['prone', 'death save', 'cover', 'advantage', 'difficult terrain', 'grapple']) {
    const hits = ENTRIES.filter(({ e, s }) => env.rulesEntryMatches(e, s, q)).length;
    check(`"${q}" finds something`, hits > 0, '0 hits');
  }
}

/* ── 5. the highlighter cannot inject markup ── */
{
  const pageJs = read('rules.js');
  const hl = new Function(
    'function escHtml(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}'
    + pageJs.slice(pageJs.indexOf('function rulesHighlight'), pageJs.indexOf('function visibleEntries'))
    + 'return rulesHighlight;')();

  check('a rule containing markup is escaped before it is highlighted',
    hl('<img src=x onerror=alert(1)>', '') === '&lt;img src=x onerror=alert(1)&gt;',
    hl('<img src=x onerror=alert(1)>', ''));
  check('and still escaped when the query matches inside it',
    !hl('<script>bad</script>', 'script').includes('<script>'),
    hl('<script>bad</script>', 'script'));
  check('a query full of regex metacharacters does not throw or match wildly',
    hl('half cover', '.*+?[](){}|^$\\') === 'half cover');
  check('the only markup the highlighter adds is <mark>',
    (hl('half cover', 'cover').match(/<[^>]+>/g) || []).every(t => /^<\/?mark>$/.test(t)),
    hl('half cover', 'cover'));
  // Alternation order only decides anything when one word is a prefix of
  // another — "save" inside "saving". Without the longest-first sort the
  // shorter one wins and the match comes out split across two <mark>s. The
  // first version of this check used "cover" and "three-quarters", where
  // neither is a prefix of the other, and so passed with the sort deleted.
  check('the longest word is highlighted first, so a match is never split',
    hl('auto-fail DEX saves', 'save saves') === 'auto-fail DEX <mark>saves</mark>',
    hl('auto-fail DEX saves', 'save saves'));
}

console.log(failures ? `\n>>> rules reference FAILED (${failures})` : `\n>>> rules reference OK (${env.rulesEntryCount()} rules in ${SECTIONS.length} sections)`);
process.exit(failures ? 1 : 0);
