#!/usr/bin/env node
// Regression check for CAMPAIGN/compendium.json — the Quirk Compendium,
// indexed, and the build script that produces it.
//
// This file is not hand-written: scripts/build-compendium.js parses it out
// of the PDF with pdftotext. That makes two things worth guarding.
//
// FIRST, IT IS AN INDEX AND NOT THE BOOK. The name, the rarity, the type, a
// sentence or two of description, the weakness, the NAMES and levels of each
// ability, and the page the full entry is on. The rules for each ability
// stay in the PDF. A future build that started copying the ability text
// would be a different thing from what this is, so the sizes are bounded
// here and the page reference is required.
//
// SECOND, A BAD PARSE LOOKS LIKE A GOOD ONE. The two-column layout, labels
// run together on one line, three spellings of "Emitter", a quirk printed
// across three pages repeating its own header, and one entry punctuated
// "Quirk Legendary" with no comma all produced plausible-looking output that
// was wrong. Each of those is checked, by name, against the entry that
// caught it.

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

const doc = JSON.parse(read('CAMPAIGN/compendium.json'));
const entries = doc.entries || [];
const builder = read('scripts/build-compendium.js');

/* ── 1. the shape ── */
{
  check('the index has the whole book in it',
    entries.length >= 150, entries.length + ' entries');
  check('it says where it came from and when it was built',
    /Quirk Compendium/.test(doc.source || '') && /^\d{4}-\d{2}-\d{2}$/.test(doc.built || ''),
    JSON.stringify({ source: doc.source, built: doc.built }));
  check('and that it is an index rather than the book',
    /INDEX, not the book/i.test(doc._note || '') && /rules for each ability stay in the PDF/i.test(doc._note || ''));
  check('with the command to rebuild it',
    /build-compendium\.js --write/.test(doc._note || ''));

  const bad = entries.filter(e => !e.name || !e.type || !e.description || !e.rarity || !e.page);
  check('every entry has a name, a type, a rarity, a description and a page',
    bad.length === 0, bad.map(e => e.name || '(unnamed)').join(', '));

  const names = entries.map(e => e.name);
  check('no quirk is listed twice',
    new Set(names).size === names.length,
    names.filter((n, i) => names.indexOf(n) !== i).join(', '));
  check('and they are in alphabetical order, because the page is a lookup',
    names.slice().sort((a, b) => a.localeCompare(b)).join('|') === names.join('|'));

  const RARITIES = ['Common', 'Uncommon', 'Rare', 'Very Rare', 'Legendary', 'Legendary Ancient'];
  const strayRarity = [...new Set(entries.map(e => e.rarity).filter(r => !RARITIES.includes(r)))];
  check('every rarity is one the book uses', strayRarity.length === 0, strayRarity.join(', '));

  // Emitter, Transformation, Mutant and the two hybrids. "None" is one real
  // entry whose type field says so.
  const TYPES = ['Emitter', 'Transformation', 'Mutant', 'None',
    'Emitter / Mutant', 'Mutant / Emitter'];
  const strayType = [...new Set(entries.map(e => e.type).filter(t => !TYPES.includes(t)))];
  check('and every type is spelled one way',
    strayType.length === 0, strayType.join(', '));
  check('the book\'s own misspellings are normalised away',
    !entries.some(e => /Emmiter|Muntant|Mutation/i.test(e.type)),
    'the PDF spells it "Emmiter", "Muntant" and "Mutation" in places');

  const pages = entries.map(e => e.page);
  check('the pages are all real page numbers',
    pages.every(p => Number.isInteger(p) && p > 0 && p < 200),
    JSON.stringify(pages.filter(p => !(Number.isInteger(p) && p > 0 && p < 200))));
}

/* ── 2. it is an index, not the book ── */
{
  const longest = entries.slice().sort((a, b) => b.description.length - a.description.length)[0];
  check('a description is a sentence or two, not the entry',
    longest.description.length <= 320,
    `"${longest.name}" is ${longest.description.length} characters`);
  const longestWeak = entries.slice()
    .sort((a, b) => (b.weakness || '').length - (a.weakness || '').length)[0];
  check('and so is a weakness',
    (longestWeak.weakness || '').length <= 320,
    `"${longestWeak.name}" is ${(longestWeak.weakness || '').length} characters`);
  const prose = entries.map(e => e.description + ' ' + (e.weakness || ''));
  const ABBREV = /\b(?:e\.g|i\.e|etc|vs|ft|lb|Mr|Mrs|Ms|Dr|St|No)\./gi;
  const RUN_TOGETHER = /[a-z\d][A-Z]|[.!?,;][A-Za-z]/;
  const runsTogether = (t) => RUN_TOGETHER.test(String(t).replace(ABBREV, ' '));
  check('no two words are run together where the PDF had a line break',
    !prose.some(runsTogether),
    entries.filter(e => runsTogether(e.description + ' ' + (e.weakness || '')))
      .map(e => e.name).join(', ')
      + ' — pdftotext drops the space, so "produced." ran into "Acid damage". '
      + 'The first version only caught the no-punctuation case, which is not '
      + 'the case it was written for');
  check('nothing ends mid-abbreviation',
    !prose.some(t => /\b(e\.g|i\.e|etc|vs)\.?\s*$/i.test(t.trim())),
    'the sentence split treated "e.g." as the end of a sentence');
  check('no stat table bled into a field as prose',
    !prose.some(t => /\d+[–-]\d+\s+[A-Z]/.test(t)),
    'Acid\'s pressure table came through as "0–10 Immune to acid damage. 11–20 …"');
  check('and the build still carries all four of those cleanups',
    /pdftotext drops the space/.test(builder) && /ABBREVIATIONS/.test(builder)
    && /reads as prose once the layout is gone/.test(builder));

  check('descriptions end in a full stop rather than mid-word',
    entries.filter(e => /[.!?]$/.test(e.description)).length >= entries.length - 2,
    entries.filter(e => !/[.!?]$/.test(e.description)).map(e => e.name).join(', '));

  // The abilities are NAMES and levels. No rules text, which is the line
  // between an index and a copy of somebody's rulebook.
  const ABILITY_FIELDS = ['name', 'level'];
  const extraFields = entries.flatMap(e => (e.abilities || [])
    .flatMap(a => Object.keys(a).filter(k => !ABILITY_FIELDS.includes(k))));
  check('an indexed ability is a name and a level, and nothing else',
    extraFields.length === 0,
    [...new Set(extraFields)].join(', ')
    + ' — the first version of this tested a.text, which does not exist on '
    + 'these objects at all, so it passed for the wrong reason');
  const badAbility = entries.flatMap(e => (e.abilities || []).map(a => ({ e, a })))
    .filter(({ a }) => !a.name || a.name.length > 40
      || (a.level != null && !(Number.isInteger(a.level) && a.level >= 1 && a.level <= 20)));
  check('every indexed ability has a short name and a sane level',
    badAbility.length === 0,
    badAbility.slice(0, 5).map(({ e, a }) => `${e.name}: ${JSON.stringify(a)}`).join(' | '));
  check('and a good number of them are indexed',
    entries.flatMap(e => e.abilities || []).length >= 250,
    entries.flatMap(e => e.abilities || []).length + ' abilities');

  // Nothing in the index should be long enough to be a reproduction.
  const total = JSON.stringify(entries).length;
  check('the whole index is a fraction of the book it points at',
    total < 400000, (total / 1024).toFixed(0) + ' KB of JSON against a 9 MB PDF');
}

/* ── 3. the five things that broke the obvious parse ── */
{
  const byName = (n) => entries.find(e => e.name === n);

  // "Quirk Legendary" with no comma — one entry in the book out of 160.
  check('"Nine" is in it, which is headed "Quirk Legendary" with no comma',
    byName('Nine') && byName('Nine').rarity === 'Legendary',
    'the separator after "Quirk" has to be optional');
  check('and the build script still allows for that',
    /Quirk\[,:\]\?\\s\+/.test(builder));

  // "Zero Gravity" runs Type/Description/Weakness together on one line, and
  // reading it line by line put the entire quirk into the type column.
  const zero = byName('Zero Gravity');
  check('"Zero Gravity" has a two-word type, not a whole quirk in it',
    zero && zero.type === 'Emitter' && zero.description.length < 320,
    zero ? `${zero.type} / ${zero.description.length} chars` : 'missing');
  check('because fields are split on the labels rather than read line by line',
    /split on the labels/i.test(builder));

  // "Laser Eyes" is printed across three pages, each repeating the header.
  const lasers = entries.filter(e => e.name === 'Laser Eyes');
  check('"Laser Eyes" is one entry, not the three pages it is printed across',
    lasers.length === 1, lasers.length + ' copies');
  check('and it cites the page the entry starts on',
    lasers.length === 1 && lasers[0].page === 83, lasers.length ? String(lasers[0].page) : '—');
  check('with the abilities the last of those pages carried',
    lasers.length === 1 && lasers[0].abilities.length >= 2,
    lasers.length ? lasers[0].abilities.map(a => a.name).join(', ') : '—');

  // The Quirk Creation chapter's own text sat inside one description.
  check('no chapter furniture leaked into an entry',
    !entries.some(e => /\bStep \d|\bChapter \d/.test(e.description + (e.weakness || ''))),
    entries.filter(e => /\bStep \d|\bChapter \d/.test(e.description + (e.weakness || '')))
      .map(e => e.name).join(', '));

  // Two-column: -layout interleaves the right column into the left and
  // nothing can be read, so the build must use -raw.
  check('the build reads the PDF in reading order, not by layout',
    /'-raw'/.test(builder) && !/'-layout'/.test(builder),
    'with -layout the right column is interleaved into the left');
}

/* ── 4. the build refuses a bad parse ── */
{
  check('the build checks itself before writing',
    /REFUSING TO WRITE/.test(builder) && /problems\.push/.test(builder));
  // The CONDITION, not just the message. The first version matched the
  // message text, so replacing `if (entries.length < 150)` with `if (false)`
  // left every one of these passing.
  for (const [label, pattern] of [
    ['too few entries', /if \(entries\.length < \d+\) problems\.push/],
    ['an entry with no type', /entries\.filter\(e => !e\.type\)/],
    ['an entry with no description', /entries\.filter\(e => !e\.description\)/],
    ['a repeated name', /all\.indexOf\(n\) !== i/],
    ['chapter text leaking in', /\\bStep \\d\|\\bChapter \\d/],
  ]) {
    check(`and refuses on ${label}`, pattern.test(builder),
      'the guard itself, not the wording of its message');
  }
  check('a dry run is the default',
    /includes\('--write'\)/.test(builder) && /DRY RUN/.test(builder));
  check('and it says what to install if pdftotext is missing',
    /brew install poppler/.test(builder));
  check('the PDF it reads is the one in the repo',
    /RULEBOOKS/.test(builder) && fs.existsSync(path.join(repoRoot, 'RULEBOOKS',
      '- My Hero Academia_ Quirk Compedium - The Homebrewery.pdf')));
}

/* ── 5. the Lab reads it, and says where the rules are ── */
{
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const quirkJs = read('quirk-data.js');
  const quirkCode = stripComments(quirkJs);
  const labJs = read('lab.js');
  check('the quirk database reads the index',
    /CAMPAIGN\/compendium\.json/.test(quirkJs));
  check('last, so the campaign\'s own account of a quirk wins over the book\'s',
    quirkCode.indexOf('compendium.json') > quirkCode.indexOf('class1b.json')
    && quirkCode.includes('compendium.json'),
    'a character\'s record is the one being played — and this compares '
    + 'comment-stripped source, because the header lists compendium.json '
    + 'first among the seven sources and an indexOf on the raw file found that');
  check('a book entry carries no character, which is the point',
    /there is nobody to collect a name from/.test(quirkJs));
  check('and is not counted as somebody holding the quirk',
    /r\.from === 'The Quirk Compendium' \? 0 : 1/.test(quirkJs),
    '"1 person has it" would be wrong about a quirk nobody in the campaign has');

  check('the Lab cites the page and links to the PDF',
    /lb-quirk-page/.test(labJs) && /Quirk%20Compedium/.test(labJs),
    'the index tells you a quirk exists; the book has the rules');
  check('and the page reference is styled',
    /\.lb-quirk-page\b/.test(read('css/pages/lab.css'))
    && /lb-quirk-page"/.test(labJs),
    'bounded: renaming the class to lb-quirk-pageX satisfied a substring match');
  check('an entry with no indexed abilities says where to read it instead',
    /No abilities are indexed for this one/.test(labJs));
}

console.log(failures ? `\n>>> compendium FAILED (${failures})`
  : `\n>>> compendium OK (${entries.length} quirks, ${entries.flatMap(e => e.abilities || []).length} abilities indexed)`);
process.exit(failures ? 1 : 0);
