#!/usr/bin/env node
// Text contrast, computed from css/tokens.css rather than eyeballed.
//
// Why this exists: --text-dim was #56687F, which is 2.91:1 on --surface2 and
// 3.49:1 on --bg. WCAG AA wants 4.5:1 for text that size, and --text-dim is
// the tier the site uses for its SMALLEST type — .tile-more at 11px,
// .section-h3 and .glance-label at 10px, every .chip, every .edit-hint,
// around 290 uses. The same token was below AA on the parchment surface in
// both light and dark. Nothing flags that: it looks like a design choice
// until you measure it.
//
// The palette is one file and the token names are a documented contract, so
// a ratio is cheap to check and a regression here is otherwise invisible.
//
// ── READING A FAILURE ──────────────────────────────────────────────────
// Either a token moved, or a pair was added to PAIRS below that does not
// hold. Fix the token — do not relax the threshold. If a pair turns out not
// to be rendered anywhere, delete it from PAIRS with a note, the way
// --text-dim on --surface3 was removed once .icon-btn:hover was found to
// switch to --text.

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

/* ── WCAG 2.1 relative luminance and contrast ───────────────────────── */

function channel(c) {
  c /= 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function rgb(hex) {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map(x => x + x).join('') : h;
  return [0, 2, 4].map(i => parseInt(n.slice(i, i + 2), 16));
}
function luminance(hex) {
  const [r, g, b] = rgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/* ── Read the three palettes out of tokens.css ──────────────────────── */

// :root is the dark tool surface, .theme-doc the parchment reader, and the
// prefers-color-scheme block inside it the parchment in dark mode. Each is
// read as a flat map of the literal hexes it declares; tokens defined as
// var() aliases are skipped, since an alias cannot have a contrast problem
// its source does not already have.
function paletteFrom(block) {
  const out = {};
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*(#[0-9A-Fa-f]{3,8})\s*;/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

const src = read('css/tokens.css');

function blockOf(startRe, label) {
  const m = src.match(startRe);
  if (!m) throw new Error(`cannot find the ${label} block in css/tokens.css`);
  // from the opening brace, consume to its matching close
  let i = src.indexOf('{', m.index), depth = 0, start = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) return src.slice(start, i); }
  }
  throw new Error(`unterminated ${label} block`);
}

const dark = paletteFrom(blockOf(/^:root\s*\{/m, ':root'));
const docLight = { ...dark, ...paletteFrom(blockOf(/^\.theme-doc\s*\{/m, '.theme-doc')) };
const docDark = {
  ...docLight,
  ...paletteFrom(blockOf(/@media \(prefers-color-scheme: dark\)/, 'parchment dark')),
};

check('the three palettes were read out of tokens.css',
  !!dark['--bg'] && !!docLight['--bg'] && !!docDark['--bg'],
  `dark=${Object.keys(dark).length} doc=${Object.keys(docLight).length} docDark=${Object.keys(docDark).length} tokens`);

/* ── The pairs the site actually renders ────────────────────────────────
   [foreground, background, where, px, bold, themes?]

   Only combinations really on screen. A pair invented for tidiness either
   fails for no reason or passes and proves nothing — two were cut during
   the first run of this file for exactly that:

     --text-dim on --surface3   .icon-btn:hover switches to --text, so that
                                pair is never painted.
     --accent on --bg           on parchment. .header-label lives only in
                                index.html and .section-label only in
                                manga.css, and neither file is loaded by
                                campaigns.html or campaign-overview.html —
                                the 37 "section-label" hits in
                                campaign-overview.js are all
                                person-section-label, a different class. So
                                it is a dark-theme pair, and the parchment
                                accent's 3.22:1 is not a text failure.
                                Where that accent IS used on parchment is
                                .section-icon and .bm-item-icon, graphics
                                beside a text label that already says the
                                same word: WCAG 1.4.11 asks 3:1 for those,
                                which 3.22 clears.

   `themes` defaults to every theme. Narrow it only with a reason, as above. */
const ALL = ['dark', 'parchment', 'parchment dark'];
const DARK_ONLY = ['dark'];   // the dashboard — index.html is never .theme-doc

const PAIRS = [
  ['--text',         '--bg',       'body copy',                             14, false],
  ['--text',         '--surface',  'panel copy',                            14, false],
  ['--text',         '--surface2', '.tile-name',                            17, true,  DARK_ONLY],
  ['--text-muted',   '--bg',       '.page-sub',                             13, false],
  ['--text-muted',   '--surface',  '.section-note, .panel-note',            11, false],
  ['--text-muted',   '--surface2', '.tile-blurb, .chip label',              11, false],
  ['--text-dim',     '--bg',       '.section-sub, .hub-group-hint',         11, false],
  ['--text-dim',     '--surface',  '.glance-label, .last-session-next',     10, true],
  ['--text-dim',     '--surface2', '.tile-more, .section-h3, .chip',        10, true],
  ['--accent-text',  '--bg',       '.last-session-label',                   10, true],
  ['--accent-text',  '--surface2', '.version-badge, .atk-roll',             11, true],
  ['--red-text',     '--surface2', '.btn--danger, .dm-flag',                11, true],
  ['--green-text',   '--surface2', '.badge.pc',                             11, true],
  ['--amber-text',   '--surface2', '.badge.supporting',                     11, true],
  ['--teal-text',    '--surface2', '.nav-btn.save-btn',                     11, true],
  ['--primary-text', '--surface2', '.glance .mood-live, .badge.student-1b', 17, true],
  ['--purple-text',  '--surface2', '.badge.teacher',                        11, true],
  ['--accent',       '--bg',       '.header-label, .section-label',         11, true,  DARK_ONLY],
];

// AA: 3.0 for large text (>=18.66px bold, or >=24px), 4.5 otherwise.
const required = (px, bold) => ((bold && px >= 18.66) || px >= 24 ? 3.0 : 4.5);

for (const [name, palette] of [['dark', dark], ['parchment', docLight], ['parchment dark', docDark]]) {
  const bad = [];
  let checked = 0;
  for (const [fg, bg, where, px, bold, themes] of PAIRS) {
    if (!(themes || ALL).includes(name)) continue;
    if (!palette[fg] || !palette[bg]) continue;   // alias-only in this theme
    checked++;
    const r = contrast(palette[fg], palette[bg]);
    const need = required(px, bold);
    if (r < need) {
      bad.push(`${fg} ${palette[fg]} on ${bg} ${palette[bg]} = ${r.toFixed(2)}, needs ${need.toFixed(1)} (${px}px${bold ? ' bold' : ''}) — ${where}`);
    }
  }
  check(`${name}: all ${checked} rendered text pairs meet WCAG AA`,
    bad.length === 0,
    bad.join('\n        ') + (bad.length ? '\n        → raise the token in css/tokens.css; do not lower the threshold' : ''));
}

/* ── The three text tiers stay distinguishable ───────────────────────── */

// Fixing contrast by collapsing --text-dim into --text-muted would pass the
// checks above and destroy the hierarchy the design depends on.
for (const [name, palette] of [['dark', dark], ['parchment', docLight], ['parchment dark', docDark]]) {
  const surface = palette['--surface2'];
  const [t, m, d] = ['--text', '--text-muted', '--text-dim'].map(k => contrast(palette[k], surface));
  check(`${name}: text / muted / dim are three distinct tiers`,
    t > m && m > d && (t - m) > 1 && (m - d) > 1,
    `on ${surface}: text ${t.toFixed(2)}, muted ${m.toFixed(2)}, dim ${d.toFixed(2)} — each tier needs daylight between it and the next`);
}

/* ── The token contract in the header still holds ───────────────────── */

// tokens.css documents the names JS hardcodes inside style="" strings.
// Renaming one of those breaks colour at runtime with no error, so the
// header's list is a contract and this checks the text tiers in it resolve.
for (const token of ['--text', '--text-muted', '--text-dim', '--bg', '--surface', '--surface2']) {
  check(`${token} is declared in :root`, !!dark[token],
    'it is named in the contract at the top of tokens.css');
}

console.log(failures ? `\n>>> contrast FAILED (${failures})` : '\n>>> contrast OK');
process.exit(failures ? 1 : 0);
