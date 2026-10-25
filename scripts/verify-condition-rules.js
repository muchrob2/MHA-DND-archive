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
// the three tables are lifted out and evaluated on their own rather than the
// whole page being booted. A declaration ends at the first "];" or "};" that
// closes a line — which the nested rows of COVER_RULES ("],") do not.
function pull(src, name) {
  const start = src.indexOf('const ' + name + ' = ');
  if (start === -1) throw new Error('no ' + name + ' in encounter.js');
  const m = /[}\]];\n/.exec(src.slice(start));
  if (!m) throw new Error(name + ' in encounter.js has no end');
  return src.slice(start, start + m.index + 2);
}

const encSrc = read('CLASS-1A/encounter.js');
const env = new Function(
  pull(encSrc, 'CONDITIONS') + '\n'
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
    /rulebooks on the dashboard/i.test(encSrc));
}

console.log(failures ? `\n>>> condition rules FAILED (${failures})` : '\n>>> condition rules OK');
process.exit(failures ? 1 : 0);
