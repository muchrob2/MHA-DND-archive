// The dice engine, shared. Loaded as a CLASSIC script (not a module) by every
// page that rolls anything, so diceParse/diceRoll/diceFormat are plain globals
// exactly like RULES_REFERENCE in rules-data.js.
//
// ── Why this is one file ────────────────────────────────────────────
// There were three rollers in the repo and they did not agree. The Class 1-A
// toolkit had advantage, crit detection and a history; the Heropad's Dice app
// had a stepper and neither; the Encounter Manager rolled bare Math.random()
// in five places. The expression parser understood "2d6+3" and nothing else —
// not "d20", not "4d6kh3", not two dice terms in one expression — and it
// lived in one of the three files, so the other two could not use it.
//
// ── What it is, deliberately ────────────────────────────────────────
// Pure. Nothing in here touches the DOM, Firestore or localStorage, and the
// randomness is injected: diceRoll(parsed, rng) takes a function returning
// [0,1) and defaults to Math.random. That is what makes it the only part of
// the site whose behaviour can be proved rather than eyeballed —
// scripts/verify-dice.js rolls it thousands of times against a seeded
// generator and checks the arithmetic, the keep rules, the bounds and the
// distribution. See that file before changing anything here.
//
// ── What it understands ─────────────────────────────────────────────
//   d20              one die, count defaults to 1
//   2d6              the ordinary form
//   2d6+3            a flat modifier, + or -
//   2d6 + 1d4 - 1    several terms, mixed, spaces optional
//   d20+5 adv        advantage: roll twice, keep the higher
//   d20 dis          disadvantage: roll twice, keep the lower
//   4d6kh3           keep the highest 3 of 4 (the classic stat roll)
//   2d20kl1          keep the lowest 1 of 2
//
// Strict on purpose: anything it cannot read parses to null, and the callers
// show no Roll button rather than a button that silently rolls the wrong
// thing. That rule came from the Class 1-A roller and it stays.

// Caps. A typo like "999999d1000" must not be able to hang a page, and these
// are far above anything a table actually rolls.
const DICE_MAX_COUNT = 100;
const DICE_MAX_SIDES = 1000;
const DICE_MAX_TERMS = 8;

// "kh3" / "kl" / "kh" — n defaults to 1. Returns null for anything else.
function diceParseKeep(raw, count) {
  if (!raw) return null;
  const m = /^k([hl])(\d{1,3})?$/i.exec(raw);
  if (!m) return null;
  const n = m[2] === undefined ? 1 : parseInt(m[2], 10);
  // Keeping 0 dice, or keeping more than you rolled, is a typo rather than an
  // instruction — reject it instead of quietly clamping.
  if (n < 1 || n > count) return null;
  return { mode: m[1].toLowerCase(), n };
}

/* Returns
 *   { terms: [ {sign, count, sides, keep} | {sign, flat} ], adv, text }
 * or null. `adv` is 'adv', 'dis' or null, and is only ever set on a single
 * one-die d20 expression — advantage on "4d6" is not a thing, and accepting
 * it would mean inventing a rule.
 */
function diceParse(raw) {
  let s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return null;

  // The adv/dis suffix comes off first so the rest is pure arithmetic.
  let adv = null;
  const advMatch = /\s+(adv|advantage|dis|disadvantage)$/.exec(s);
  if (advMatch) {
    adv = advMatch[1].startsWith('adv') ? 'adv' : 'dis';
    s = s.slice(0, advMatch.index);
  }

  s = s.replace(/\s+/g, '');
  if (!s) return null;
  // A leading minus would be a negative pool, not a roll. A leading plus is
  // harmless noise.
  if (s[0] === '-') return null;
  if (s[0] === '+') s = s.slice(1);

  const terms = [];
  // Each term is an optional sign then either NdM(kh|kl)N or a flat number.
  const termRe = /([+-]?)(?:(\d{0,3})d(\d{1,4})(k[hl]\d{0,3})?|(\d{1,4}))/g;
  let consumed = 0;
  let m;
  while ((m = termRe.exec(s)) !== null) {
    // Gaps mean something unparseable sits between two terms ("2d6 & 1d4"),
    // which must fail rather than silently rolling the halves it understood.
    if (m.index !== consumed) return null;
    consumed = m.index + m[0].length;
    if (terms.length >= DICE_MAX_TERMS) return null;
    // Every term after the first needs an explicit + or -. Without this,
    // whitespace having already been stripped, "2d6 2d6" became "2d62d6" and
    // parsed as a 62-sided die plus a d6, and "1d2d3" as 1d2 plus 1d3 —
    // nonsense that rolled rather than being refused.
    if (terms.length && m[1] === '') return null;
    const sign = m[1] === '-' ? -1 : 1;

    if (m[5] !== undefined) {
      const flat = parseInt(m[5], 10);
      if (!Number.isFinite(flat)) return null;
      terms.push({ sign, flat });
      continue;
    }

    const count = m[2] === '' ? 1 : parseInt(m[2], 10);
    const sides = parseInt(m[3], 10);
    if (count < 1 || count > DICE_MAX_COUNT) return null;
    if (sides < 2 || sides > DICE_MAX_SIDES) return null;
    let keep = null;
    if (m[4]) {
      keep = diceParseKeep(m[4], count);
      if (!keep) return null;
    }
    terms.push({ sign, count, sides, keep });
  }
  if (consumed !== s.length || !terms.length) return null;
  if (!terms.some(t => t.sides)) return null; // "5" alone is a number, not a roll

  if (adv) {
    // One d20, one die, no keep clause. Anything else and advantage has no
    // defined meaning, so the whole expression is rejected.
    const dice = terms.filter(t => t.sides);
    if (dice.length !== 1 || dice[0].sides !== 20 || dice[0].count !== 1 || dice[0].keep) return null;
    if (dice[0].sign !== 1) return null;
  }

  const parsed = { terms, adv };
  parsed.text = diceFormat(parsed);
  return parsed;
}

// Back to canonical notation: "2d6+1d4-1 adv". What the history row shows, and
// what proves a parse round-trips.
function diceFormat(parsed) {
  if (!parsed || !parsed.terms) return '';
  let out = '';
  parsed.terms.forEach((t, i) => {
    const sign = t.sign < 0 ? '-' : (i ? '+' : '');
    const body = t.sides
      ? `${t.count}d${t.sides}${t.keep ? 'k' + t.keep.mode + t.keep.n : ''}`
      : String(t.flat);
    out += sign + body;
  });
  return out + (parsed.adv ? ' ' + parsed.adv : '');
}

function diceRollOne(sides, rng) {
  return 1 + Math.floor(rng() * sides);
}

/* Rolls a parsed expression. `rng` returns a float in [0,1) and defaults to
 * Math.random — pass a seeded one to make a roll reproducible.
 *
 * Returns
 *   { total, flat, parts, crit, fumble, breakdown, text }
 * where each dice part carries every die it rolled, which of them counted,
 * and which were dropped — so a caller can strike the dropped ones through
 * rather than hiding that they happened.
 */
function diceRoll(parsed, rng) {
  if (!parsed || !parsed.terms) return null;
  const roll = typeof rng === 'function' ? rng : Math.random;
  const parts = [];
  let total = 0;
  let flat = 0;

  for (const t of parsed.terms) {
    if (!t.sides) {
      flat += t.sign * t.flat;
      total += t.sign * t.flat;
      continue;
    }

    // Advantage is two dice of which one counts, which is the keep rule with
    // different words — expressed that way so there is one code path.
    const count = parsed.adv ? 2 : t.count;
    const keep = parsed.adv
      ? { mode: parsed.adv === 'adv' ? 'h' : 'l', n: 1 }
      : t.keep;

    const rolls = [];
    for (let i = 0; i < count; i++) rolls.push(diceRollOne(t.sides, roll));

    let kept = rolls.slice();
    let dropped = [];
    if (keep) {
      // Sorted copies with the original index kept, so equal dice are dropped
      // deterministically instead of depending on the sort's stability.
      const order = rolls.map((v, i) => ({ v, i }))
        .sort((a, b) => (keep.mode === 'h' ? b.v - a.v : a.v - b.v) || a.i - b.i);
      const keptIdx = new Set(order.slice(0, keep.n).map(o => o.i));
      kept = rolls.filter((_, i) => keptIdx.has(i));
      dropped = rolls.filter((_, i) => !keptIdx.has(i));
    }

    const sum = kept.reduce((a, b) => a + b, 0);
    total += t.sign * sum;
    parts.push({ sign: t.sign, count, sides: t.sides, keep, rolls, kept, dropped, sum });
  }

  // A crit is a natural 20 on a single d20 — the kept one, under advantage.
  // Deliberately NOT extended to "any 20 among several d20s": that is not the
  // rule, and the reference page says so.
  const d20s = parts.filter(p => p.sides === 20);
  const single = d20s.length === 1 && d20s[0].kept.length === 1 && parts.length === 1 ? d20s[0] : null;
  const nat = single ? single.kept[0] : null;

  return {
    total,
    flat,
    parts,
    crit: nat === 20,
    fumble: nat === 1,
    breakdown: diceBreakdown(parts, flat),
    text: parsed.text || diceFormat(parsed),
  };
}

// "6, 5, ~~2~~ + 3" as plain text — no markup, so a caller can escape it and
// print it, or build its own richer version from `parts`.
function diceBreakdown(parts, flat) {
  const bits = parts.map((p, i) => {
    const shown = p.kept.join(', ')
      + (p.dropped.length ? ' (dropped ' + p.dropped.join(', ') + ')' : '');
    return (i && p.sign < 0 ? '− ' : i ? '+ ' : p.sign < 0 ? '−' : '') + shown;
  });
  if (flat) bits.push((flat > 0 ? '+ ' : '− ') + Math.abs(flat));
  return bits.join(' ');
}

// Parse and roll in one go; null if the expression is no good.
function diceRollExpr(raw, rng) {
  const parsed = diceParse(raw);
  return parsed ? diceRoll(parsed, rng) : null;
}

// The smallest and largest an expression can produce, which is what makes
// "is this roll even possible" answerable — used by the verifier to bound
// thousands of rolls, and worth having for a DM setting a DC.
function diceRange(parsed) {
  if (!parsed || !parsed.terms) return null;
  let min = 0;
  let max = 0;
  for (const t of parsed.terms) {
    if (!t.sides) { min += t.sign * t.flat; max += t.sign * t.flat; continue; }
    const count = parsed.adv ? 1 : (t.keep ? t.keep.n : t.count);
    const lo = count * 1;
    const hi = count * t.sides;
    // A negative term's best case is the smallest dice total, not the biggest.
    min += t.sign > 0 ? lo : -hi;
    max += t.sign > 0 ? hi : -lo;
  }
  return { min, max };
}
