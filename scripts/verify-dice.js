#!/usr/bin/env node
// Regression check for dice.js — the shared roller.
//
// This is the one part of the site whose behaviour can be PROVED rather than
// eyeballed, and that is the whole reason the engine is pure and takes its
// randomness as an argument. A roller that is subtly wrong is the worst kind
// of bug in a toolkit like this: nobody notices, every number at the table is
// quietly off, and there is nothing to see in a screenshot.
//
// What it guards:
//   1. The parser accepts exactly what it documents and refuses the rest. The
//      callers show no Roll button on a null parse, so a leak here means a
//      button that silently rolls the wrong thing.
//   2. Notation round-trips: parse → format → parse gives the same thing.
//   3. The arithmetic is right, against a seeded generator, for every form.
//   4. Thousands of rolls stay inside diceRange, and every die inside 1..sides.
//   5. keep-highest / keep-lowest and advantage keep the dice they claim to.
//   6. The distribution is actually uniform-ish and advantage actually skews —
//      a roller that always returned 10 would pass every check above.
//   7. The pages that roll use this engine rather than their own Math.random.

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

const D = new Function(read('dice.js') + `
  return { diceParse, diceRoll, diceFormat, diceRollExpr, diceRange, diceBreakdown,
           DICE_MAX_COUNT, DICE_MAX_SIDES, DICE_MAX_TERMS };`)();

// A seeded generator, so a failing check is reproducible and a passing one
// isn't luck. mulberry32 — small, well-distributed, and not Math.random.
function seeded(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ── 1. the parser ── */
{
  const good = ['d20', '2d6', '2d6+3', '1d10 - 1', '2d6+1d4-1', 'd20+5 adv', 'd20 dis',
    '4d6kh3', '2d20kl1', 'D20', '  2d6 + 3  ', 'd20+5 advantage', 'd20 disadvantage',
    '100d6', '2d6-1d4', '8d8+8', '1d100', '+2d6', '2d6kh1'];
  const missed = good.filter(e => !D.diceParse(e));
  check('every documented form parses', missed.length === 0, missed.join(' | '));

  const bad = [
    '', '   ', 'abc', 'd', '2d', 'd0', 'd1', '2d6+', '+', '-2d6', '0d6', '5', '-5',
    '2d6 & 1d4', '2d6++3', '2d6 2d6', '1d2d3', '2d6 adv dis', 'advantage',
    '2d6 adv',        // advantage on something that is not one d20
    '4d6kh3 adv',     // advantage on top of a keep clause
    '1d20+5 adv extra',
    '101d6',          // over the count cap
    '2d1001',         // over the sides cap
    '4d6kh5',         // keeping more dice than were rolled
    '4d6kh0',         // keeping none
    '4d6kx3',         // not a keep mode
    '1d20+1d20+1d20+1d20+1d20+1d20+1d20+1d20+1d20', // over the term cap
    null, undefined, 42, {},
  ];
  const leaked = bad.filter(e => D.diceParse(e));
  check('and nothing else does', leaked.length === 0,
    leaked.map(e => JSON.stringify(e) + ' → ' + D.diceParse(e).text).join(' | '));

  check('a count over the cap is refused rather than clamped',
    D.diceParse((D.DICE_MAX_COUNT + 1) + 'd6') === null
    && D.diceParse(D.DICE_MAX_COUNT + 'd6') !== null);
  check('advantage is only ever accepted on a single d20',
    D.diceParse('d20 adv') && !D.diceParse('2d20 adv') && !D.diceParse('d6 adv')
    && !D.diceParse('2d6+1d20 adv'));
}

/* ── 2. round-trip ── */
{
  const forms = ['d20', '2d6+3', '2d6+1d4-1', '4d6kh3', '2d20kl1', 'd20+5 adv', 'd20 dis', '1d10-1'];
  const broken = forms.filter(e => {
    const once = D.diceParse(e);
    const twice = D.diceParse(once.text);
    return !twice || twice.text !== once.text;
  });
  check('notation round-trips through format and back', broken.length === 0, broken.join(' | '));
  check('the canonical form fills in the implied count',
    D.diceParse('d20').text === '1d20' && D.diceParse('d20 dis').text === '1d20 dis');
}

/* ── 3. the arithmetic ── */
{
  const rng = seeded(1);
  // Hand-checked: the total is the kept dice plus the flat terms, with signs.
  const r = D.diceRollExpr('2d6+1d4-1', rng);
  const dice = r.parts.reduce((n, p) => n + p.sign * p.sum, 0);
  check('the total is the signed sum of the parts plus the flat modifier',
    r.total === dice + r.flat, `${r.total} vs ${dice} + ${r.flat}`);
  check('the flat terms are summed with their signs',
    D.diceRollExpr('1d6+3-1', seeded(2)).flat === 2,
    String(D.diceRollExpr('1d6+3-1', seeded(2)).flat));

  // A subtracted dice term has to come OFF the total, which is the kind of
  // sign error that would never be noticed at a table.
  let sawNegative = 0;
  for (let i = 0; i < 400; i++) {
    const roll = D.diceRollExpr('4d6-1d6', seeded(i));
    const [plus, minus] = roll.parts;
    if (roll.total !== plus.sum - minus.sum) { sawNegative = -1; break; }
    sawNegative++;
  }
  check('a subtracted dice term is subtracted', sawNegative === 400, 'failed at roll ' + sawNegative);

  check('a part reports every die it rolled, kept and dropped',
    (() => {
      const k = D.diceRollExpr('4d6kh3', seeded(7)).parts[0];
      return k.rolls.length === 4 && k.kept.length === 3 && k.dropped.length === 1
        && k.sum === k.kept.reduce((a, b) => a + b, 0)
        && [...k.kept, ...k.dropped].sort().join() === [...k.rolls].sort().join();
    })());

  check('the breakdown names the dropped dice rather than hiding them',
    /dropped/.test(D.diceRollExpr('4d6kh3', seeded(3)).breakdown)
    && !/dropped/.test(D.diceRollExpr('2d6+1', seeded(3)).breakdown));

  check('the same seed gives the same roll, and a different one does not',
    D.diceRollExpr('4d6kh3', seeded(9)).total === D.diceRollExpr('4d6kh3', seeded(9)).total
    && D.diceRollExpr('20d20', seeded(9)).total !== D.diceRollExpr('20d20', seeded(10)).total);

  check('an unparseable expression rolls nothing at all',
    D.diceRollExpr('nonsense', seeded(1)) === null && D.diceRoll(null) === null);
}

/* ── 4. bounds ── */
{
  const forms = ['d20', '2d6+3', '2d6+1d4-1', '4d6kh3', '2d20kl1', 'd20+5 adv', 'd20 dis',
    '100d6', '1d100', '8d8-2', '4d6-1d6'];
  let outside = null;
  let badDie = null;
  for (const form of forms) {
    const parsed = D.diceParse(form);
    const range = D.diceRange(parsed);
    for (let i = 0; i < 500 && !outside && !badDie; i++) {
      const r = D.diceRoll(parsed, seeded(i * 31 + form.length));
      if (r.total < range.min || r.total > range.max) {
        outside = `${form} rolled ${r.total}, range is ${range.min}..${range.max}`;
      }
      for (const p of r.parts) {
        for (const v of p.rolls) {
          if (!Number.isInteger(v) || v < 1 || v > p.sides) badDie = `${form} rolled a ${v} on a d${p.sides}`;
        }
      }
    }
  }
  check('5,500 rolls across eleven forms all land inside their stated range', !outside, outside);
  check('and every individual die is a whole number from 1 to its face count', !badDie, badDie);

  // The extremes have to be reachable, or the range is wider than the truth.
  const hits = { min: false, max: false };
  for (let i = 0; i < 20000 && !(hits.min && hits.max); i++) {
    const t = D.diceRollExpr('2d6', seeded(i)).total;
    if (t === 2) hits.min = true;
    if (t === 12) hits.max = true;
  }
  check('both ends of the range actually come up', hits.min && hits.max, JSON.stringify(hits));
}

/* ── 5. keep and advantage ── */
{
  let wrongKeep = null;
  for (let i = 0; i < 3000 && !wrongKeep; i++) {
    const h = D.diceRollExpr('4d6kh3', seeded(i)).parts[0];
    const sortedDesc = [...h.rolls].sort((a, b) => b - a);
    if ([...h.kept].sort((a, b) => b - a).join() !== sortedDesc.slice(0, 3).join()) {
      wrongKeep = 'kh3 kept ' + h.kept + ' from ' + h.rolls;
    }
    const l = D.diceRollExpr('4d6kl2', seeded(i)).parts[0];
    const sortedAsc = [...l.rolls].sort((a, b) => a - b);
    if ([...l.kept].sort((a, b) => a - b).join() !== sortedAsc.slice(0, 2).join()) {
      wrongKeep = 'kl2 kept ' + l.kept + ' from ' + l.rolls;
    }
  }
  check('keep-highest and keep-lowest keep exactly the right dice', !wrongKeep, wrongKeep);

  let wrongAdv = null;
  for (let i = 0; i < 3000 && !wrongAdv; i++) {
    const a = D.diceRollExpr('d20 adv', seeded(i)).parts[0];
    if (a.rolls.length !== 2 || a.kept[0] !== Math.max(...a.rolls)) {
      wrongAdv = 'adv kept ' + a.kept + ' from ' + a.rolls;
    }
    const d = D.diceRollExpr('d20 dis', seeded(i)).parts[0];
    if (d.rolls.length !== 2 || d.kept[0] !== Math.min(...d.rolls)) {
      wrongAdv = 'dis kept ' + d.kept + ' from ' + d.rolls;
    }
  }
  check('advantage rolls two dice and keeps the higher; disadvantage the lower',
    !wrongAdv, wrongAdv);

  // Equal dice must drop deterministically rather than depending on the sort.
  const tie = D.diceRoll(D.diceParse('4d6kh2'), () => 0.5).parts[0];
  check('a pool of identical dice keeps the right number of them',
    tie.rolls.join() === '4,4,4,4' && tie.kept.length === 2 && tie.dropped.length === 2,
    JSON.stringify(tie));
}

/* ── 6. crit, fumble, and the shape of the distribution ── */
{
  check('a natural 20 on a single d20 is a crit, and a 1 a fumble',
    D.diceRoll(D.diceParse('d20'), () => 0.999).crit === true
    && D.diceRoll(D.diceParse('d20'), () => 0).fumble === true);
  check('a 20 under advantage still crits',
    D.diceRoll(D.diceParse('d20 adv'), () => 0.999).crit === true);
  check('but twenty d20s in a pool do not crit just because one shows 20',
    D.diceRoll(D.diceParse('20d20'), () => 0.999).crit === false);
  check('and a 20 on a d20 that is part of a bigger expression does not either',
    D.diceRoll(D.diceParse('1d20+1d6'), () => 0.999).crit === false,
    'a crit is a natural 20 on the attack roll, not on anything that rolls a 20');

  // Everything above would pass if the engine always returned the same number.
  const N = 24000;
  const counts = new Array(21).fill(0);
  const rng = seeded(2024);
  for (let i = 0; i < N; i++) counts[D.diceRoll(D.diceParse('d20'), rng).total]++;
  const expected = N / 20;
  const worst = Math.max(...counts.slice(1).map(c => Math.abs(c - expected) / expected));
  check('a d20 is roughly uniform over 24,000 rolls',
    worst < 0.12 && counts.slice(1).every(c => c > 0),
    'worst face is ' + (worst * 100).toFixed(1) + '% off expected');

  const mean = (expr, n, seed) => {
    const r = seeded(seed);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += D.diceRoll(D.diceParse(expr), r).total;
    return sum / n;
  };
  const plain = mean('d20', 20000, 5);
  const adv = mean('d20 adv', 20000, 6);
  const dis = mean('d20 dis', 20000, 7);
  // Exact expectations: 10.5 plain, 13.825 advantage, 7.175 disadvantage.
  check('the average d20 is about 10.5', Math.abs(plain - 10.5) < 0.2, plain.toFixed(3));
  check('advantage averages about 13.8 — it actually skews high',
    Math.abs(adv - 13.825) < 0.2, adv.toFixed(3));
  check('disadvantage averages about 7.2', Math.abs(dis - 7.175) < 0.2, dis.toFixed(3));
  check('and 4d6kh3 averages about 12.24, as a stat roll should',
    Math.abs(mean('4d6kh3', 20000, 8) - 12.2446) < 0.2, mean('4d6kh3', 20000, 8).toFixed(3));
}

/* ── 7. the pages use it ── */
{
  const rel = read('CLASS-1A/relationships.js');
  const relHtml = read('CLASS-1A/relationships.html');
  check('the Class 1-A roller parses through the shared engine',
    /diceParse\(/.test(rel) && /diceRoll\(/.test(rel));
  check('and loads it before its own script',
    relHtml.indexOf('src="../dice.js"') !== -1
    && relHtml.indexOf('src="../dice.js"') < relHtml.indexOf('src="relationships.js"'));
  check('its own expression parser is gone rather than left to rot beside this one',
    !/function parseDiceExpr\(/.test(rel));

  const pad = read('heropad.js');
  const padHtml = read('heropad.html');
  check('the Heropad Dice app rolls through the shared engine',
    /diceRoll(Expr)?\(/.test(pad));
  check('and loads it before heropad.js',
    padHtml.indexOf('src="dice.js"') !== -1
    && padHtml.indexOf('src="dice.js"') < padHtml.indexOf('src="heropad.js"'));

  // Nothing in the engine may reach for a page.
  const engineCode = read('dice.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  check('the engine touches no DOM, no storage and no network',
    !/document\.|localStorage|firebase|fetch\(/.test(engineCode),
    'comments stripped first — the header names all three to say it avoids them');
  check('and its randomness is injectable, which is what makes this file possible',
    /function diceRoll\(parsed, rng\)/.test(read('dice.js')));
}

console.log(failures ? `\n>>> dice FAILED (${failures})` : '\n>>> dice OK');
process.exit(failures ? 1 : 0);
