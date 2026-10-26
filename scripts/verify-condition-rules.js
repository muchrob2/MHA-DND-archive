#!/usr/bin/env node
// Regression check for the conditions & cover reference on the encounter page
// (the Rules button, and the tooltips on every condition chip).
//
// What it guards:
//   1. Every condition the page can apply has a line saying what it does — a
//      condition list with a gap in it is worse than no reference, because
//      the gap is invisible until somebody hovers the one that's missing.
//   2. The reference and the board agree about which conditions exist: the
//      board draws a pip per condition from a map kept separately.
//   3. The panel is wired to functions that exist, and escapes what it prints.
//   4. The rules stay one-line restatements of the mechanics.

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

// encounter.js is a page script full of Firestore and DOM calls at load, so
// the condition list is lifted out and evaluated on its own rather than the
// whole page being booted. The two reference tables are no longer literals in
// that file at all — they are derived from rules-data.js, which the page loads
// as a script tag above itself — so the two files are evaluated TOGETHER here,
// in the same order the page loads them. That means this check now fails if
// either the shared data or the wiring to it breaks, which is the point.
// A declaration ends at the first line-closing ";" that follows a brace, a
// bracket or a call — the nested rows of a table ("],") never close a line,
// and the derived one-liners (`= rulesConditionMap();`) end on a paren.
function pull(src, name) {
  const start = src.indexOf('const ' + name + ' = ');
  if (start === -1) throw new Error('no ' + name + ' in encounter.js');
  const m = /[}\])];\n/.exec(src.slice(start));
  if (!m) throw new Error(name + ' in encounter.js has no end');
  return src.slice(start, start + m.index + m[0].length);
}

const encSrc = read('CLASS-1A/encounter.js');
const env = new Function(
  read('rules-data.js') + '\n'
  + pull(encSrc, 'CONDITIONS') + '\n'
  + pull(encSrc, 'CONDITION_RULES') + '\n'
  + pull(encSrc, 'COVER_RULES') + '\n'
  + 'return { CONDITIONS, CONDITION_RULES, COVER_RULES };'
)();

/* ── 1. no gaps ── */
{
  check('the condition list was read back out of the page',
    Array.isArray(env.CONDITIONS) && env.CONDITIONS.length >= 14, env.CONDITIONS.length + ' found');
  const missing = env.CONDITIONS.filter(c => !env.CONDITION_RULES[c]);
  check('every condition the encounter page can apply has a rule written for it',
    missing.length === 0, missing.join(', '));
  const extra = Object.keys(env.CONDITION_RULES).filter(c => !env.CONDITIONS.includes(c));
  check('and no rule describes a condition the page cannot apply',
    extra.length === 0, extra.join(', '));
  const short = env.CONDITIONS.filter(c => (env.CONDITION_RULES[c] || '').length < 30);
  check('each one actually says something', short.length === 0, short.join(', '));
}

/* ── 2. the board agrees ── */
{
  const boardSrc = read('CLASS-1A/board-shared.js');
  const marks = [...boardSrc.matchAll(/^  (\w+):\s+\{ ch: '/gm)].map(m => m[1]);
  check('the board has a pip map to compare against', marks.length >= 14, marks.length + ' found');
  const noMark = env.CONDITIONS.filter(c => !marks.includes(c));
  check('every condition also has a pip the board can draw on a token',
    noMark.length === 0, noMark.join(', '));
  const orphanMark = marks.filter(c => !env.CONDITIONS.includes(c));
  check('and the board draws no pip for a condition that does not exist',
    orphanMark.length === 0, orphanMark.join(', '));
}

/* ── 3. cover, and the panel ── */
{
  check('the cover scale the board props are written against is listed',
    env.COVER_RULES.length === 3 && env.COVER_RULES.every(([n, t]) => n && t.length > 20),
    JSON.stringify(env.COVER_RULES.map(c => c[0])));

  const page = read('CLASS-1A/encounter.html');
  check('the page has a button that opens the reference and somewhere to put it',
    page.includes('id="enc-rules-btn"') && page.includes('id="enc-rules-panel"'));
  check('the panel is opened, rendered and filtered by functions that exist',
    /function encRenderRules\(/.test(encSrc) && /function encFilterRules\(/.test(encSrc)
    && /function encToggleRules\(/.test(encSrc));
  check('the condition chips carry the rule as their tooltip, where they are applied',
    (encSrc.match(/encConditionTooltip\(cond\)/g) || []).length === 2,
    (encSrc.match(/encConditionTooltip/g) || []).length + ' uses');
  check('and the reference escapes what it prints',
    /escHtml\(CONDITION_RULES\[name\]/.test(encSrc));
  check('the page derives both tables from the shared reference rather than holding its own copy',
    /const CONDITION_RULES = rulesConditionMap\(\);/.test(encSrc)
    && /const COVER_RULES = rulesCoverRows\(\);/.test(encSrc)
    && !/Can't see: attacks against you/.test(encSrc),
    'encounter.js still has condition text of its own');
  check('and the page loads that shared file before its own script',
    page.indexOf('rules-data.js') > -1
    && page.indexOf('rules-data.js') < page.indexOf('encounter.js'));
}

/* ── 4. mechanics, not quoted text ── */
{
  // A reference like this is only defensible as a restatement of how the
  // mechanic works. Long verbatim-looking sentences are the smell to catch.
  const longest = env.CONDITIONS
    .map(c => ({ c, n: (env.CONDITION_RULES[c] || '').length }))
    .sort((a, b) => b.n - a.n)[0];
  check('each rule is a one-line summary rather than a block of quoted text',
    longest.n <= 240, `${longest.c} is ${longest.n} characters`);
  check('the reference says where the rest of the rules actually live',
    /rulebooks on the dashboard/i.test(encSrc) && /rules\.html/.test(encSrc));
}

/* ── 5. the tracker acts on the conditions it displays ── */
{
  const page = read('CLASS-1A/encounter.html');
  // The conditions used to be decoration: the page showed them on the row and
  // then rolled a bare d20 anyway, so a DM who had carefully marked a target
  // Restrained got a flat roll and had to remember the advantage themselves.
  check('an attack roll is worked out from the conditions on both sides',
    /function encRollAttack\(/.test(encSrc) && /rulesAttackMode\(/.test(encSrc));
  check('and both attack paths go through it rather than rolling their own d20',
    (encSrc.match(/encRollAttack\(/g) || []).length === 3,
    (encSrc.match(/encRollAttack\(/g) || []).length + ' uses — want the definition plus both paths');
  check('no dice are rolled by hand in the page any more',
    !/Math\.floor\(Math\.random\(\) \* 20\)/.test(encSrc)
    && !/Math\.random\(\) \* tmSelectedDie/.test(encSrc),
    'the four hand-rolled dice are now diceRoll calls');
  check('the page loads the shared dice engine before its own script',
    page.indexOf('src="../dice.js"') !== -1
    && page.indexOf('src="../dice.js"') < page.indexOf('src="encounter.js"'));

  check('an attacker who cannot act is reported rather than rolled for',
    (encSrc.match(/e\.cannot/g) || []).length >= 2
    && (encSrc.match(/>no attack</g) || []).length === 2,
    'the log and the turn modal both have to handle it');
  check('the reason for an advantage is shown next to the roll',
    /function encWhyHtml\(/.test(encSrc)
    && (encSrc.match(/\$\{encWhyHtml\(e\)\}/g) || []).length === 2,
    'the log and the turn modal both have to print it');
  check('and a cancelled pair says so rather than looking like a plain roll',
    /they cancel/.test(encSrc));

  // Initiative is d20 + DEX and can exceed 20. It used to be clamped there,
  // which squashed every high-DEX character into a tie on a good roll.
  check('initiative is no longer capped at 20',
    !/Math\.min\(20, Math\.floor\(Math\.random\(\) \* 20\)/.test(encSrc)
    && /Math\.max\(1, roll\.total \+ \(c\.dexMod \|\| 0\)\)/.test(encSrc),
    'a +4 DEX rolling 18 has to be able to go on 22');
}

/* ── 6. dropping to 0 applies the condition ── */
{
  // Nothing used to apply Unconscious at 0 HP. It was a note the DM had to
  // remember; now that conditions drive the attack roll it is a mechanical
  // fact, so it is applied — and only the one this rule applied is ever
  // removed again, so a creature put to sleep at full health keeps it.
  const sync = new Function(
    encSrc.slice(encSrc.indexOf('function encSyncUnconscious'),
      encSrc.indexOf('function encSetHpDirect')) + '; return encSyncUnconscious;')();

  const run = (c) => { sync(c); return c; };
  let c = run({ hp: 0, maxHp: 10, conditions: [] });
  check('dropping to 0 applies Unconscious',
    c.conditions.join() === 'Unconscious' && c.autoUnconscious === true, JSON.stringify(c));
  sync(c);
  check('and syncing again does not apply it twice',
    c.conditions.filter(n => n === 'Unconscious').length === 1);
  c.hp = 1; sync(c);
  check('healing above 0 takes it back off',
    !c.conditions.includes('Unconscious') && c.autoUnconscious === false);

  const asleep = run({ hp: 10, maxHp: 10, conditions: ['Unconscious'] });
  check('a creature unconscious at full health is left alone, not claimed',
    asleep.conditions.includes('Unconscious') && asleep.autoUnconscious === false);
  asleep.hp = 4; sync(asleep);
  check('and keeps it when healed, because the DM applied it rather than the rule',
    asleep.conditions.includes('Unconscious'),
    'only the condition this rule applied may be removed by it');

  const other = run({ hp: 0, maxHp: 10, conditions: ['Prone', 'Poisoned'] });
  other.hp = 5; sync(other);
  check('every other condition survives the round trip',
    other.conditions.join() === 'Prone,Poisoned', other.conditions.join());

  check('a record with no conditions array at all is handled',
    run({ hp: 0, maxHp: 10 }).conditions.join() === 'Unconscious');

  // Every place HP changes has to call it, or a combatant can be downed
  // without the condition — which is now a wrong attack roll, not a note.
  const hpWrites = (encSrc.match(/\b[ct]\.hp = /g) || []).length;
  const syncs = (encSrc.match(/encSyncUnconscious\([ct]\);/g) || []).length;
  check('and every HP write in the page is followed by a sync',
    hpWrites > 0 && syncs === hpWrites, `${hpWrites} HP writes, ${syncs} syncs`);
}

console.log(failures ? `\n>>> condition rules FAILED (${failures})` : '\n>>> condition rules OK');
process.exit(failures ? 1 : 0);
