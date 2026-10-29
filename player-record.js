// A player's own record: the moves they have written, the equipment they
// have made, the perks they have picked up, and the stats they are tracking.
// Loaded as a CLASSIC script (not a module), so these are plain globals like
// the rest of the shared files.
//
// ── Why this is separate from the character ─────────────────────────
// The authoritative character lives in mha-dnd/relationships-bundle and is
// the DM's. A player writing into it directly would be racing the Class 1-A
// toolkit's own merge-save, and a move somebody invented is not the same
// kind of fact as the HP the DM set.
//
// So this is a document of its own, one per character —
// mha-dnd/labsheet-<file>, the same shape as the Heropad's per-character
// pads — holding only what the player authored. It is additive: nothing in
// here overwrites anything the DM owns, and the stats section records what
// the player THINKS alongside what the record says rather than instead of
// it, so a disagreement is visible instead of silent.
//
// ── What a player may write ─────────────────────────────────────────
// Everything in here. That is the point: a move is a draft until a DM agrees
// with it, and a page that refuses to let you write one down until then is
// no use at the table. Every surface that shows these says where they came
// from, so "this is in the handbook" and "I made this up on Tuesday" never
// look the same.

/* The equipment categories are the shop's own, so a crafted thing can be
 * priced against real stock and reads like a catalogue entry rather than a
 * freeform note. These are the ones a player would plausibly make.
 */
const RECORD_GEAR_KINDS = [
  { id: 'melee', label: 'Melee weapon' },
  { id: 'firearms', label: 'Ranged weapon' },
  { id: 'explosives', label: 'Explosive' },
  { id: 'nonlethal', label: 'Non-lethal' },
  { id: 'suits-student', label: 'Costume part' },
  { id: 'parts', label: 'Support part' },
  { id: 'gear', label: 'Gear' },
  { id: 'medical', label: 'Medical' },
  { id: 'consumables', label: 'Consumable' },
];

function recordEmpty() {
  return { moves: [], gear: [], perks: [], stats: {}, note: '' };
}

function recordId() {
  return Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

// One document per character, like the Heropad's pads: a move written on a
// phone cannot then be clobbered by a move written on a laptop, and the
// document stays small.
function recordRef(db, file) {
  return db.collection('mha-dnd').doc('labsheet-' + String(file || '').replace(/\.json$/, ''));
}

function recordKey(file) {
  return 'mha-labsheet-v1-' + String(file || '');
}

async function recordLoad(db, file, storage) {
  let out = recordEmpty();
  const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  try {
    const raw = store && store.getItem(recordKey(file));
    if (raw) out = Object.assign(recordEmpty(), JSON.parse(raw));
  } catch {}
  try {
    const snap = await recordRef(db, file).get();
    if (snap.exists) out = Object.assign(recordEmpty(), snap.data());
  } catch {}
  // Every list has to BE a list whatever came back, because the renderers
  // map over them and a document half-written by an older version of this
  // page would otherwise take the whole tab down.
  for (const key of ['moves', 'gear', 'perks']) {
    if (!Array.isArray(out[key])) out[key] = [];
  }
  if (!out.stats || typeof out.stats !== 'object') out.stats = {};
  return out;
}

/* ── Turn-sheet rows ────────────────────────────────────────────────
   The player's own moves and equipment, in the shape charCanDo returns, so
   the turn sheet can show them beside the quirk's abilities and the
   standard options. `from` is 'move' or 'crafted' rather than 'quirk', and
   every surface colours them differently — a thing you invented and a thing
   in the handbook must never look the same.
   ─────────────────────────────────────────────────────────────────── */

function recordMoveRows(record, parse) {
  const dice = typeof parse === 'function' ? parse
    : (typeof charDiceIn === 'function' ? charDiceIn : () => null);
  return ((record && record.moves) || []).map(m => ({
    name: m.name || 'Unnamed move',
    cost: typeof charCostOf === 'function' ? charCostOf(m.type) : 'other',
    costText: m.type || '',
    range: m.range || '',
    damage: m.damage || '',
    dice: dice(m.damage),
    text: m.description || '',
    from: 'move',
    id: m.id || '',
  }));
}

function recordGearRows(record, parse) {
  const dice = typeof parse === 'function' ? parse
    : (typeof charDiceIn === 'function' ? charDiceIn : () => null);
  return ((record && record.gear) || []).map(g => {
    const die = dice(g.damage);
    return {
      name: g.name || 'Unnamed item',
      // Something with a die is something you attack with; everything else
      // is kit, which costs nothing to have and is not an action.
      cost: die ? 'action' : 'passive',
      costText: die ? 'Attack with it' : (kindLabel(g.kind) || 'Carried'),
      range: g.range || '',
      damage: g.damage || '',
      dice: die,
      text: [g.properties, g.description].filter(Boolean).join(' · '),
      from: 'crafted',
      id: g.id || '',
    };
  });
}

function kindLabel(id) {
  const k = RECORD_GEAR_KINDS.find(x => x.id === id);
  return k ? k.label : '';
}

/* ── Pricing a crafted thing ────────────────────────────────────────
   The question a player cannot answer about something they have just made
   is what it should cost, and the question a DM cannot answer quickly is
   whether it is out of line. Both are answered by the shop: find the real
   items with the same dice, and say what they go for.
   ─────────────────────────────────────────────────────────────────── */

// The average of a dice expression, so "2d6" and "1d12" can be compared —
// they are not the same thing but they are the same size, and that is what
// pricing is about.
function recordDiceAverage(expr, parseFn) {
  const parse = parseFn || (typeof diceParse === 'function' ? diceParse : null);
  if (!parse) return null;
  // "2d6 piercing" → "2d6". charDiceIn in char-data.js already does this
  // lifting and validates the result, so prefer it.
  let text = '';
  if (typeof charDiceIn === 'function') {
    text = charDiceIn(expr, parse) || '';
  } else {
    const found = String(expr == null ? '' : expr)
      .match(/\b\d{0,3}d\d{1,3}(?:k[hl]\d{0,3})?(?:\s*[+-]\s*\d{1,3})?/i);
    text = found ? found[0].replace(/\s+/g, '') : '';
  }
  const parsed = text ? parse(text) : null;
  if (!parsed) return null;
  // Exact, not sampled: every term is uniform, so the mean is arithmetic and
  // there is no reason to roll for it here.
  let total = 0;
  for (const t of parsed.terms) {
    if (!t.sides) { total += t.sign * t.flat; continue; }
    const kept = parsed.adv ? 1 : (t.keep ? t.keep.n : t.count);
    // Keeping the highest skews the mean upward; this is the plain mean of
    // the kept dice, which is close enough for a price and is honest about
    // being approximate where a keep clause is involved.
    total += t.sign * kept * (t.sides + 1) / 2;
  }
  return Math.round(total * 10) / 10;
}

/* Shop items whose damage is within `tolerance` of the given expression,
 * cheapest first. Returns [] when the expression has no dice in it, which
 * is the honest answer for a costume part.
 */
function recordComparables(catalog, expr, opts) {
  const options = opts || {};
  const mine = recordDiceAverage(expr);
  if (mine == null) return [];
  const tolerance = options.tolerance == null ? 2 : options.tolerance;
  const items = ((catalog && catalog.items) || [])
    .filter(i => i.damage && i.price)
    .map(i => ({ item: i, avg: recordDiceAverage(i.damage) }))
    .filter(x => x.avg != null && Math.abs(x.avg - mine) <= tolerance);
  if (options.category) {
    const same = items.filter(x => x.item.category === options.category);
    // Same category if there is anything there, otherwise anything of the
    // same size — a comparison across categories is still worth more than
    // no comparison at all.
    if (same.length) return sortByPrice(same).slice(0, 4);
  }
  return sortByPrice(items).slice(0, 4);
}

function sortByPrice(list) {
  return list.slice().sort((a, b) => Number(a.item.price) - Number(b.item.price));
}

// The middle of what comparable things cost, which is a better suggestion
// than the cheapest or the dearest.
function recordSuggestedPrice(catalog, expr, opts) {
  const list = recordComparables(catalog, expr, opts);
  if (!list.length) return null;
  const prices = list.map(x => Number(x.item.price)).sort((a, b) => a - b);
  const half = Math.floor(prices.length / 2);
  const mid = prices.length % 2
    ? prices[half]
    : (prices[half - 1] + prices[half]) / 2;
  // Rounded to the nearest thousand, because every price in the catalogue is.
  return Math.round(mid / 1000) * 1000;
}
