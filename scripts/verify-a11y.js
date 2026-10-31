#!/usr/bin/env node
// Accessibility invariants that are cheap to state and silent to break.
//
// Nothing here is a substitute for using the site with a screen reader. It
// guards the four things that were actually wrong or actually fragile:
//
//   1. STATUS MESSAGES ARE ANNOUNCED. The site had no live region anywhere —
//      not one — while fourteen elements existed whose entire job is to say
//      "Saved ✓", "Couldn't save", or "Couldn't load the loot tables". A
//      sighted user sees the word appear; everybody else got nothing.
//
//   2. DIALOGS BEHAVE LIKE DIALOGS. All three were already right, which is
//      the reason to pin it: role, aria-modal, Escape, focus moved in on
//      open and handed back on close. That is five things per dialog and
//      easy to half-do when adding a fourth.
//
//   3. EVERY BUTTON HAS A NAME. The icon pass replaced text with SVG on
//      about thirty buttons. An icon-only button with no label and no title
//      is a button a screen reader reads as "button".
//
//   4. DECORATIVE SVG IS HIDDEN. 76 inline icons, every one next to a text
//      label that already says the word. Unhidden, each one adds noise.
//
// ── READING A FAILURE ───────────────────────────────────────────────────
// These are not style points. A failure here means somebody using the site
// without sight loses information a sighted user gets for free. Fix the
// markup rather than the list — except for a genuinely new status element
// that is read some other way, which belongs in the exceptions with a note.

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

const htmlFiles = fs.readdirSync(repoRoot).filter(f => f.endsWith('.html'))
  .concat(fs.readdirSync(path.join(repoRoot, 'CLASS-1A'))
    .filter(f => f.endsWith('.html')).map(f => 'CLASS-1A/' + f));
const jsFiles = fs.readdirSync(repoRoot).filter(f => f.endsWith('.js'))
  .concat(fs.readdirSync(path.join(repoRoot, 'CLASS-1A'))
    .filter(f => f.endsWith('.js')).map(f => 'CLASS-1A/' + f));
const allSource = [...htmlFiles, ...jsFiles].map(f => [f, read(f)]);

/* ── 1. Status messages live in a live region ────────────────────────── */

// An element the code writes a save-or-fail message into. Found by name
// rather than by a fixed list, so a new one is picked up automatically —
// which is the point: the next #foo-save-state should fail this until it is
// annotated.
const STATUS_ID = /getElementById\(['"]([\w-]*(?:saved|save-state|save-status|-status|flash|notice)[\w-]*)['"]\)/g;

const statusIds = new Set();
for (const [, src] of allSource) {
  for (const m of src.matchAll(STATUS_ID)) statusIds.add(m[1]);
}

// Not a status message despite the name.
const NOT_A_STATUS = {
  'auth-modal-close': 'the close button of the auth dialog, not a message',
};

const unannounced = [];
for (const id of [...statusIds].sort()) {
  if (id in NOT_A_STATUS) continue;
  // EVERY declaration, not the first one found. #saved-notice exists on
  // three separate pages; checking only the first meant two of them could
  // lose their live region and this would still pass — which it did, until
  // a negative test caught it.
  const decls = [];
  for (const [file, src] of allSource) {
    for (const m of src.matchAll(new RegExp(`<\\w+\\b[^>]*\\bid="${id}"[^>]*>`, 'g'))) {
      decls.push({ file, tag: m[0] });
    }
  }
  if (!decls.length) { unannounced.push(`#${id} is written to but never declared`); continue; }
  for (const d of decls) {
    if (!/aria-live=|role="(?:status|alert|log)"/.test(d.tag)) {
      unannounced.push(`${d.file}: #${id} is written to but is not a live region`);
    }
  }
}
check('every element the code writes a status into is a live region',
  unannounced.length === 0,
  unannounced.join('\n        ') + (unannounced.length
    ? '\n        → add role="status" aria-live="polite" (or role="alert" for a failure)'
    : ''));

// A failed load interrupts; a save does not.
for (const page of htmlFiles.filter(f => read(f).includes('id="load-error-banner"'))) {
  const tag = read(page).match(/<div\b[^>]*\bid="load-error-banner"[^>]*>/)[0];
  check(`${page}: the load-error banner is role="alert"`, /role="alert"/.test(tag),
    'a failure should interrupt rather than wait for a pause');
}

/* ── 2. Dialogs behave like dialogs ──────────────────────────────────── */

// [page, dialog id, overlay id, the script that drives it]
const DIALOGS = [
  ['characters.html', 'modal', 'modal-overlay', 'characters.js'],
  ['CLASS-1A/encounter.html', 'turn-modal', 'turn-modal-overlay', 'CLASS-1A/encounter.js'],
  ['CLASS-1A/encounter.html', 'board-modal', 'board-overlay', 'CLASS-1A/encounter.js'],
];

for (const [page, dialog, overlay, script] of DIALOGS) {
  const html = read(page);
  const tag = (html.match(new RegExp(`<div\\b[^>]*\\bid="${dialog}"[^>]*>`)) || [''])[0];
  check(`#${dialog} is a dialog (role, aria-modal, focusable)`,
    /role="dialog"/.test(tag) && /aria-modal="true"/.test(tag) && /tabindex="-1"/.test(tag),
    tag || `no element with id="${dialog}" in ${page}`);
  check(`#${dialog} is named`,
    /aria-label=|aria-labelledby=/.test(tag), tag);

  const js = read(script);
  check(`#${dialog} takes focus when it opens`,
    new RegExp(`getElementById\\(['"]${dialog}['"]\\)[\\s\\S]{0,80}\\.focus\\(`).test(js)
    || /focusModal\s*\(/.test(js),
    'opening a dialog without moving focus leaves a keyboard user outside it');
  // Matched loosely on purpose. encounter.js handles both of its overlays in
  // ONE listener that early-returns on `e.key !== 'Escape'`, so a check for
  // `key === 'Escape'` fails on code that is perfectly correct. What matters
  // is that a keydown handler mentions Escape and acts on this overlay.
  const escHandler = js.match(/addEventListener\('keydown'[\s\S]{0,1200}/);
  check(`#${overlay} closes on Escape`,
    !!escHandler && /'Escape'/.test(escHandler[0])
    && new RegExp(`['"]${overlay}['"]`).test(escHandler[0]),
    'a keydown listener should mention Escape and close this overlay');
  check(`#${overlay} hands focus back when it closes`,
    /LastFocusedEl|modalLastFocusedEl/.test(js),
    'focus should return to whatever opened the dialog');
}

/* ── 3. Every button has an accessible name ──────────────────────────── */

const nameless = [];
for (const [file, src] of allSource) {
  for (const m of src.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    const [, attrs, inner] = m;
    // an aria-hidden icon contributes nothing to the name, so strip it
    const text = inner.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').trim();
    const named = /aria-label=|aria-labelledby=|title=/.test(attrs);
    // Two ways a name arrives later rather than in the markup:
    //   ${...} in the body — JS renders the label with the button
    //   btn.textContent = … — the label is assigned after load, which is how
    //     #tb-exact-btn works: it ships empty and hidden, and table.js:313
    //     gives it "Show/Hide enemy hit points" when it reveals it.
    // (Worth noting the tension with verify-icons.js, which forbids writing
    //  textContent over a button that HOLDS an icon. Both hold: that button
    //  has no icon, so textContent is its label rather than a clobber.)
    const id = (attrs.match(/id="([^"]+)"/) || [])[1];
    // Scoped to the lines right after the lookup. A looser "this file both
    // mentions the id and assigns textContent somewhere" would let a
    // genuinely nameless button through on any page that happens to set
    // textContent on anything.
    const labelledLater = id && allSource.some(([, other]) =>
      new RegExp(`getElementById\\(['"]${id}['"]\\)[\\s\\S]{0,120}\\.textContent\\s*=`).test(other));
    if (!text && !named && !/\$\{/.test(inner) && !labelledLater) {
      nameless.push(`${file}: <button${attrs.slice(0, 60)}>`);
    }
  }
}
check('every button has text, a title, or an aria-label',
  nameless.length === 0,
  nameless.join('\n        ') + (nameless.length
    ? '\n        → an icon-only button with no name reads as just "button"'
    : ''));

/* ── 4. Decorative SVG is hidden from the reading order ──────────────── */

const bareSvg = [];
let svgCount = 0;
for (const [file, src] of allSource) {
  for (const m of src.matchAll(/<svg\b([^>]*)>/g)) {
    svgCount++;
    const attrs = m[1];
    // a meaningful SVG would carry a role and a label; none here do, because
    // every icon on this site sits beside a word that says the same thing
    if (!/aria-hidden/.test(attrs) && !/aria-label=|role="img"/.test(attrs)) {
      bareSvg.push(`${file}: <svg${attrs.slice(0, 50)}>`);
    }
  }
}
check(`all ${svgCount} inline icons are hidden or labelled`,
  bareSvg.length === 0, bareSvg.join('\n        '));

/* ── 5. The page basics ─────────────────────────────────────────────── */

for (const page of htmlFiles) {
  const html = read(page);
  check(`${page} declares a language`, /<html[^>]+lang="[a-z]{2}/.test(html));
  check(`${page} has a title`, /<title>[^<]{3,}<\/title>/.test(html));
}

// Reduced motion is honoured globally rather than per animation.
check('prefers-reduced-motion is handled once, in base.css',
  /@media \(prefers-reduced-motion: reduce\)/.test(read('css/base.css')));

console.log(failures ? `\n>>> accessibility FAILED (${failures})` : '\n>>> accessibility OK');
process.exit(failures ? 1 : 0);
