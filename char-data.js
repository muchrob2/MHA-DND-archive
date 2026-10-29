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

/* ── What a character can do ─────────────────────────────────────────
   The Lab's turn sheet is assembled from four places, and three of them
   need cleaning up first.

   ── The cost of an ability ──
   `type` on a recorded ability is free text, and the live bundle has
   fourteen distinct values in it: "Action", "Bonus Action", "Passive",
   "Reaction", "Attack", "Full-turn Action", "Action (unlocks at level 10)",
   "Bonus Action / Reaction", "Passive / Unarmed Strike", and more. A turn
   sheet has to group them, so each one is read down to a bucket — and the
   original text is kept and shown, because "recharge 5-6" and "Dragon Form
   only" are the half of it the bucket throws away.

   ── The damage ──
   Also free text: "1d12 / 2 heat points", "8d6 / 10 heat points", "2d6",
   "N/A", "n/a". charDiceIn pulls the first real dice expression out and
   leaves the rest alone, so the row can carry a Roll button without the
   page pretending "N/A" is a number.
   ─────────────────────────────────────────────────────────────────── */

const CHAR_COSTS = ['action', 'bonus', 'reaction', 'passive', 'other'];
const CHAR_COST_LABELS = {
  action: 'Actions',
  bonus: 'Bonus actions',
  reaction: 'Reactions',
  passive: 'Always on',
  other: 'Everything else',
};

// Order matters: "Bonus Action / Reaction" has to be read as a bonus action
// before the bare "action" test can claim it.
function charCostOf(type) {
  const t = String(type == null ? '' : type).toLowerCase();
  if (!t) return 'other';
  if (/bonus/.test(t)) return 'bonus';
  if (/reaction/.test(t)) return 'reaction';
  if (/passive|always|permanent/.test(t)) return 'passive';
  if (/action|attack|strike/.test(t)) return 'action';
  return 'other';
}

/* The first rollable dice expression in a string, or null.
 *
 * Deliberately only the FIRST: "8d6 / 10 heat points" is one roll and one
 * cost, and a page that offered to roll the 10 would be offering nonsense.
 * Everything it finds is handed to diceParse, so a string that looks like a
 * die but is not one ("d0", "2d") comes back null rather than half-read.
 */
function charDiceIn(text, parse) {
  const raw = String(text == null ? '' : text);
  if (!raw) return null;
  const parser = typeof parse === 'function' ? parse : (typeof diceParse === 'function' ? diceParse : null);
  if (!parser) return null;
  const match = raw.match(/\b\d{0,3}d\d{1,3}(?:k[hl]\d{0,3})?(?:\s*[+-]\s*\d{1,3})?/i);
  if (!match) return null;
  const parsed = parser(match[0].replace(/\s+/g, ''));
  return parsed ? parsed.text : null;
}

/* Everything a character can do, grouped by what it costs.
 *
 * `universal` is the list every character has — the standard actions out of
 * rules-data.js — passed in rather than imported so this file stays free of
 * the rules reference. A row is { name, cost, costText, range, damage,
 * dice, text, from } where `dice` is a rollable expression or null and
 * `from` says where the row came from, because "this is your quirk" and
 * "this is a rule everybody has" should not look the same.
 */
function charCanDo(c, universal) {
  const rows = [];
  const mech = (c || {}).quirk_mechanics || {};

  for (const a of (Array.isArray(mech.abilities) ? mech.abilities : [])) {
    rows.push({
      name: a.name || 'Unnamed',
      cost: charCostOf(a.type),
      costText: a.type || '',
      range: a.range || '',
      damage: a.damage && !/^n\/?a$/i.test(String(a.damage).trim()) ? a.damage : '',
      dice: charDiceIn(a.damage),
      text: a.description || '',
      from: 'quirk',
      id: a.id || '',
    });
  }

  // Carried gear that states a die in its notes. The notes are prose — "2d6
  // slashing, two-handed, heavy, finesse" — so the die is extracted and the
  // whole note kept as the description.
  for (const it of (((c || {}).inventory || {}).items || [])) {
    const dice = charDiceIn(it.notes) || charDiceIn(it.name);
    if (!dice) continue;
    rows.push({
      name: it.name || 'Carried item',
      cost: 'action',
      costText: 'Attack with it',
      range: '',
      damage: dice,
      dice,
      text: it.notes || '',
      from: 'gear',
      id: it.id || '',
    });
  }

  for (const u of (universal || [])) {
    rows.push({
      name: u.name,
      cost: charCostOf(u.cost || u.name),
      costText: u.costText || '',
      range: '',
      damage: '',
      dice: null,
      text: u.text || '',
      from: 'rule',
      id: '',
    });
  }

  const grouped = {};
  for (const cost of CHAR_COSTS) grouped[cost] = rows.filter(r => r.cost === cost);
  return { rows, grouped };
}
