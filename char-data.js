// Reading a character, shared. Loaded as a CLASSIC script (not a module) by
// every page that needs the roster's numbers, so these are plain globals like
// RULES_REFERENCE in rules-data.js and diceParse in dice.js.
//
// ── Why this is one file ────────────────────────────────────────────
// "Load every character, live copy first" is four awkward decisions, and two
// pages now need all four of them:
//
//   1. mha-dnd/relationships-bundle is authoritative. Several characters have
//      been edited in the browser and exist in Firestore in a form the repo
//      files do not match, so reading the repo file for one of those is
//      reading a different character.
//   2. The bundled CLASS-1A/*.json files are the fallback, and a page has to
//      SAY when it used them. A printed sheet or a party table that looks
//      current and isn't is worse than one that admits it.
//   3. roster.json supplies the name and quirk when the bundle entry has none.
//   4. The purse and the carried items live in their own `inventories`
//      collection, written by the Shop and the admin page — the bundle's copy
//      of them goes stale the moment anybody buys anything.
//
// It was all written once for sheet.html. Rather than copy it for the party
// table, it moved here, which is also how the number helpers below stopped
// being per-page.
//
// Read-only. Nothing in this file writes anything.

const CHAR_ABILITIES = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA', 'TECH'];
const CHAR_ABILITY_NAMES = {
  STR: 'Strength', DEX: 'Dexterity', CON: 'Constitution', INT: 'Intelligence',
  WIS: 'Wisdom', CHA: 'Charisma', TECH: 'Tech',
};

/* ── Numbers ────────────────────────────────────────────────────────
   Scores and modifiers are strings in some records and numbers in others —
   both forms are in the repo right now — so everything is read through
   charNum.
   ─────────────────────────────────────────────────────────────────── */

function charNum(v) {
  const raw = String(v == null ? '' : v).trim();
  // The empty-string guard is not decoration: Number('') is 0, not NaN, so
  // without it a missing field reads as a real zero. Every character whose
  // record had no `modifiers` block printed +0 across all seven abilities,
  // and a level with no proficiency_bonus printed +0 instead of deriving one.
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function charSigned(n) {
  if (n == null) return '—';
  return (n >= 0 ? '+' : '−') + Math.abs(n);
}

// Taken from the record when it has one and derived when it does not, rather
// than left blank: floor((score - 10) / 2) is the rule, and a table with an
// empty modifier column is useless.
function charModifier(c, key) {
  const given = charNum(((c || {}).modifiers || {})[key]);
  if (given != null) return given;
  const score = charNum(((c || {}).ability_scores || {})[key]);
  return score == null ? null : Math.floor((score - 10) / 2);
}

function charProfBonus(c) {
  const given = charNum((c || {}).proficiency_bonus);
  if (given != null) return given;
  const level = charNum((c || {}).level) || 1;
  return 2 + Math.floor((level - 1) / 4);
}

// 10 + the modifier. NOT + proficiency: nothing in the data records which
// skills a character is proficient in, so adding it would be inventing a
// proficiency. Every page that prints one of these says so next to it.
function charPassive(c, key) {
  const mod = charModifier(c, key);
  return mod == null ? null : 10 + mod;
}

function charLabel(c) {
  return (c && (c.name || c._file)) || 'Unnamed';
}

/* ── Loading ────────────────────────────────────────────────────────
   Resolves to { chars, source } where source is 'firestore' or 'local'.
   Never rejects: a page that cannot reach Firestore still has to render, so
   every failure degrades to the next source down and is reported in `source`.
   ─────────────────────────────────────────────────────────────────── */
async function charLoadAll(db, opts) {
  const options = opts || {};
  const base = options.base || '';          // '' from the repo root, '../' from CLASS-1A
  const bundleDoc = db.collection('mha-dnd').doc('relationships-bundle');
  const inventories = db.collection('inventories');

  const roster = await fetch(base + 'CLASS-1A/roster.json')
    .then(r => r.json()).catch(() => null);
  const students = ((roster && roster.students) || []).filter(s => s.file);

  let bundle = null;
  try {
    if (options.authReady) await options.authReady;
    const snap = await bundleDoc.get();
    const data = snap.exists ? snap.data() : null;
    if (data && data.version === 1 && data.characters) bundle = data;
  } catch {}

  let chars;
  let source;
  if (bundle) {
    source = 'firestore';
    chars = students.map(s => {
      const c = Object.assign({}, bundle.characters[s.file] || {});
      c._file = s.file;
      c._rosterId = s.id;
      c.name = c.name || s.name;
      c.quirk = c.quirk || s.quirk;
      return c;
    }).filter(c => c.name);
  } else {
    source = 'local';
    const loaded = await Promise.all(students.map(s =>
      fetch(base + 'CLASS-1A/' + s.file).then(r => r.json())
        .then(c => { c._file = s.file; c._rosterId = s.id; return c; })
        .catch(() => null)));
    chars = loaded.filter(Boolean);
  }

  try {
    const snap = await inventories.get();
    const byFile = {};
    snap.forEach(d => { byFile[d.id] = d.data(); });
    for (const c of chars) {
      const live = byFile[c._file];
      if (live) c.inventory = Object.assign({}, c.inventory, live);
    }
  } catch {}

  chars.sort((a, b) => charLabel(a).localeCompare(charLabel(b)));
  return { chars, source };
}
