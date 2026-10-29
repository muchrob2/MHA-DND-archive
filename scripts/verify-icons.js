#!/usr/bin/env node
// The site's icons are inline line SVGs, and two things about that are easy
// to break silently.
//
// 1. textContent over a button that holds an SVG.
//    campaign-overview.js and campaigns.js both had
//        btn.textContent = editMode ? '👁 Done' : '✏️ Edit';
//    which was correct while the button held an emoji and a word. The moment
//    the markup became `<svg class="btn-ico">…</svg>Edit`, the first toggle
//    replaced the whole thing with plain text — the icon vanished for the
//    rest of the session and came back on reload. Nothing throws.
//
// 2. Sizing an SVG with font-size.
//    .es-icon, .folder-tile-icon, .basket-tab-ico and .anchor-icon were all
//    `font-size: Npx` when they held an emoji. An inline SVG with no width
//    takes its viewBox or its parent, not the font size, so a leftover
//    font-size rule renders a 300px icon or a 0px one.
//
// Both are invisible in a diff and obvious on screen, which is the worst
// combination to leave to review.

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

/* From a binding, the rest of the block it sits in — forward until the
   braces close one level past where it started. */
function blockAfter(src, from) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { if (depth === 0) return src.slice(from, i); depth--; }
  }
  return src.slice(from);
}

const pages = fs.readdirSync(repoRoot).filter(f => f.endsWith('.html'))
  .concat(fs.readdirSync(path.join(repoRoot, 'CLASS-1A'))
    .filter(f => f.endsWith('.html')).map(f => 'CLASS-1A/' + f));

/* ── 1. Nothing that holds an icon is written with textContent ───────── */

const clobbered = [];
for (const page of pages) {
  const dir = path.dirname(page);
  const html = read(page);

  // ids of elements whose own markup contains an inline icon
  const iconIds = new Set();
  for (const m of html.matchAll(/<(?:button|a|span|div)\b([^>]*)>([\s\S]*?)<\/(?:button|a|span|div)>/g)) {
    const id = (m[1].match(/id="([^"]+)"/) || [])[1];
    if (id && /<svg[^>]*class="(?:btn-ico|es-icon|bm-ico)/.test(m[2])) iconIds.add(id);
  }
  if (!iconIds.size) continue;

  for (const m of html.matchAll(/<script src="([^"]+\.js)"/g)) {
    const rel = path.join(dir, m[1]);
    if (!fs.existsSync(path.join(repoRoot, rel))) continue;
    const js = read(rel);
    for (const id of iconIds) {
      // The inline form.
      for (const q of ['\'', '"']) {
        if (js.includes(`document.getElementById(${q}${id}${q}).textContent`)) {
          clobbered.push(`${rel} writes textContent over #${id} (${page})`);
        }
      }
      // And `const btn = getElementById('id'); … btn.textContent = …`, which
      // is the shape that actually bit. Scoped to the block the binding is
      // in: `btn` is the commonest variable name in this codebase and several
      // files legitimately write btn.textContent on a DIFFERENT button a few
      // functions away.
      for (const m of js.matchAll(new RegExp(
        `(?:const|let|var)\\s+(\\w+)\\s*=\\s*document\\.getElementById\\(['"]${id}['"]\\)`, 'g'
      ))) {
        if (blockAfter(js, m.index).includes(`${m[1]}.textContent`)) {
          clobbered.push(`${rel} writes textContent over #${id} (${page})`);
        }
      }
    }
  }
}
check('no element holding an inline icon is overwritten with textContent',
  clobbered.length === 0,
  clobbered.join('\n        ') + (clobbered.length
    ? '\n        → use innerHTML and re-emit the icon, or move the icon to a sibling'
    : ''));

/* ── 2. Icon holders are sized as boxes, not as type ─────────────────── */

const ICON_CLASSES = ['es-icon', 'btn-ico', 'bm-ico', 'nav-title-ico', 'folder-tile-icon',
                      'basket-tab-ico', 'anchor-icon', 'section-icon',
                      'tile-icon', 'role-btn-icon', 'header-icon'];

const sheets = ['css/components.css', 'css/base.css', 'css/manga.css',
                'css/theme-doc.css', 'css/auth-widget.css', 'css/board.css']
  .concat(fs.readdirSync(path.join(repoRoot, 'css/pages'))
    .filter(f => f.endsWith('.css')).map(f => 'css/pages/' + f));

const typeSized = [];
for (const sheet of sheets) {
  const src = read(sheet).replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of src.matchAll(/([^{}]*)\{([^}]*)\}/g)) {
    const [, selector, body] = m;
    if (!/font-size/.test(body)) continue;
    for (const cls of ICON_CLASSES) {
      // only flag a rule whose LAST selected class is the icon itself —
      // `.btn { font-size }` legitimately sets the type an em icon scales to
      if (new RegExp(`\\.${cls}\\s*(?:,|$)`).test(selector.trim())) {
        typeSized.push(`${sheet}: ${selector.trim().split('\n').pop().trim()} sets font-size`);
      }
    }
  }
}
check('no icon class is sized with font-size',
  typeSized.length === 0,
  typeSized.join('\n        ') + (typeSized.length
    ? '\n        → an inline SVG ignores font-size; give it width and height'
    : ''));

/* ── 3. Every icon class that is used is actually sized ──────────────── */

const allCss = sheets.map(read).join('\n');
const usedClasses = new Set();
const allSource = pages.map(read)
  .concat(fs.readdirSync(repoRoot).filter(f => f.endsWith('.js')).map(read))
  .concat(fs.readdirSync(path.join(repoRoot, 'CLASS-1A'))
    .filter(f => f.endsWith('.js')).map(f => read('CLASS-1A/' + f)))
  .join('\n');
for (const cls of ICON_CLASSES) {
  if (new RegExp(`class="${cls}\\b|class="[^"]*\\s${cls}\\b`).test(allSource)) usedClasses.add(cls);
}
for (const cls of usedClasses) {
  const rule = new RegExp(`\\.${cls}[^{]*\\{[^}]*(?:width|height)\\s*:`, 's');
  check(`.${cls} is given a box size`, rule.test(allCss.replace(/\/\*[\s\S]*?\*\//g, '')),
    'it holds an SVG, which has no intrinsic size here');
}

/* ── 4. The empty states and the converted buttons are emoji-free ───── */

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
const CONVERTED = [
  'characters.html', 'session-log.html', 'rules.html', 'loot.html',
  'updates.html', 'party.html', 'sheet.html', 'campaigns.html',
  'campaign-overview.html',
];
for (const page of CONVERTED) {
  const lines = read(page).split('\n');
  const hits = [];
  lines.forEach((line, i) => {
    // ✓ and ✕ stay: they are geometric glyphs used identically everywhere on
    // the site, not pictographs, and they render the same on every platform.
    const stripped = line.replace(/[✓✕×›‹←→▲▼·—]/g, '');
    if (EMOJI.test(stripped)) hits.push(`${page}:${i + 1} ${line.trim().slice(0, 70)}`);
  });
  check(`${page} carries no emoji in its chrome`, hits.length === 0, hits.join('\n        '));
}

/* ── 5. The icons stroke rather than fill ────────────────────────────── */

// A path with no fill:none renders as a black blob. Every icon on the site is
// a stroked outline, so the recipe must say so.
for (const cls of ['es-icon', 'btn-ico', 'tile-icon']) {
  const block = allCss.match(new RegExp(`\\.${cls}\\s*[,{][^}]*\\}`, 's'));
  check(`.${cls} sets fill:none and strokes in currentColor`,
    !!block && /fill:\s*none/.test(block[0]) && /stroke:\s*currentColor/.test(block[0]));
}

console.log(failures ? `\n>>> icons FAILED (${failures})` : '\n>>> icons OK');
process.exit(failures ? 1 : 0);
