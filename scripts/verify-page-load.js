#!/usr/bin/env node
// What every page is made to download before it can paint.
//
// Two things this guards:
//
// 1. SCRIPTS ARE DEFERRED.
//    Every page that signs in loaded four scripts in <head> with no defer —
//    the three Firebase compat SDKs and auth.js. The compat build of
//    firestore alone is the better part of a megabyte, and an undeferred
//    <script> in <head> stops the parser dead until it has downloaded and
//    run. Nothing below it exists yet, so the page cannot paint.
//
//    `defer` is safe here precisely because EVERY external script has it:
//    deferred scripts run in document order after parsing, so
//    board-prefabs → board-shared → board still run in that order, and the
//    inline <script> blocks (window.AUTH_BASE, encounter's DM-role bounce)
//    still run at parse time, which is earlier, which is what they need.
//    Mixing the two is what would break: a plain <script> at the end of
//    <body> runs BEFORE a deferred one in <head>. Hence the check is
//    all-or-nothing rather than per-tag.
//
// 2. NO STYLESHEET IS LINKED THAT CANNOT APPLY.
//    Seven pages linked css/manga.css — 12.4KB of decorative rules — and
//    not one selector in it could match anything those pages render.
//
// The inverse of 2 (a page using a class whose only definition is in a
// stylesheet it does not link) is what scripts/verify-css-coverage.js
// checks, and that is the direction that actually breaks a page. This one
// is about weight.

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

const pages = fs.readdirSync(repoRoot).filter(f => f.endsWith('.html'))
  .concat(fs.readdirSync(path.join(repoRoot, 'CLASS-1A'))
    .filter(f => f.endsWith('.html')).map(f => 'CLASS-1A/' + f));

/* ── 1. Every external script is deferred ───────────────────────────── */

const undeferred = [];
for (const page of pages) {
  for (const m of read(page).matchAll(/<script\b([^>]*)\bsrc="([^"]+)"([^>]*)>/g)) {
    const attrs = m[1] + m[3];
    if (!/\bdefer\b/.test(attrs) && !/\basync\b/.test(attrs) && !/type="module"/.test(attrs)) {
      undeferred.push(`${page}: ${m[2]}`);
    }
  }
}
check('every external script is deferred',
  undeferred.length === 0,
  undeferred.join('\n        ') + (undeferred.length
    ? '\n        → one undeferred <script> in <body> runs BEFORE the deferred '
      + 'ones in <head>, which reorders the whole page. Defer all or none.'
    : ''));

/* ── 2. Inline scripts only ever run first ──────────────────────────── */

// An inline <script> after the body's content would run before the deferred
// files it probably depends on. The three that exist are in <head> and set
// configuration (window.AUTH_BASE) or bounce the page, which is correct.
const lateInline = [];
for (const page of pages) {
  const html = read(page);
  const headEnd = html.indexOf('</head>');
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)) {
    if (m.index > headEnd) lateInline.push(`${page} at offset ${m.index}`);
  }
}
check('no inline script sits after </head>, where defer would reorder around it',
  lateInline.length === 0, lateInline.join('\n        '));

/* ── 3. No stylesheet is linked that cannot apply ───────────────────── */

function selectorsOf(file) {
  // @keyframes bodies would otherwise read as selectors called "from",
  // "to" and "0%", and "from" has no class or id in it, so the whole
  // stylesheet would look like it applies unconditionally to every page.
  const src = read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@(?:keyframes|font-face|property|counter-style)[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
  const sels = [];
  for (const m of src.matchAll(/(^|\}|\{)\s*([^{}@]+)\{/g)) {
    for (const s of m[2].split(',')) {
      const t = s.trim();
      if (t && !/^\d/.test(t)) sels.push(t);
    }
  }
  return {
    // body, h1, *, ::selection, button — no class or id, so it applies to
    // any page linking the file
    unconditional: sels.filter(s => !/[.#]/.test(s)),
    keyed: sels.filter(s => /[.#]/.test(s))
      .map(s => ({ sel: s, keys: [...s.matchAll(/[.#]([\w-]+)/g)].map(k => k[1]) })),
  };
}

const deadLinks = [];
for (const page of pages) {
  const dir = path.dirname(page);
  const html = read(page);

  // Everything this page could possibly put on the screen. Deliberately a
  // plain substring test over the whole source rather than a class-attribute
  // parse: a name assembled by interpolation still contains its literal
  // part, so this errs towards calling a stylesheet live.
  let all = html;
  for (const m of html.matchAll(/<script(?:\s+defer)?\s+src="([^"]+\.js)"/g)) {
    const rel = path.join(dir, m[1]);
    if (fs.existsSync(path.join(repoRoot, rel))) all += read(rel);
  }

  for (const m of html.matchAll(/<link[^>]+href="([^"]+\.css)"/g)) {
    const rel = path.join(dir, m[1]);
    if (!fs.existsSync(path.join(repoRoot, rel))) continue;
    const { unconditional, keyed } = selectorsOf(rel);
    if (unconditional.length) continue;
    if (!keyed.some(x => x.keys.every(k => all.includes(k)))) {
      const kb = (fs.statSync(path.join(repoRoot, rel)).size / 1024).toFixed(1);
      deadLinks.push(`${page} links ${m[1]} (${kb}KB) and nothing in it can apply`);
    }
  }
}
check('no page links a stylesheet none of whose selectors can apply',
  deadLinks.length === 0,
  deadLinks.join('\n        ') + (deadLinks.length
    ? '\n        → drop the <link>, or use the thing it styles'
    : ''));

/* ── 4. The Firebase SDK is only loaded where it is used ───────────── */

const idleSdk = [];
for (const page of pages) {
  const dir = path.dirname(page);
  const html = read(page);
  if (!/firebasejs/.test(html)) continue;
  let js = '';
  for (const m of html.matchAll(/<script(?:\s+defer)?\s+src="([^"]+\.js)"/g)) {
    const rel = path.join(dir, m[1]);
    if (fs.existsSync(path.join(repoRoot, rel))) js += read(rel);
  }
  if (/firestore-compat/.test(html) && !/\.firestore\(/.test(js)) {
    idleSdk.push(`${page} loads the Firestore SDK and never calls firestore()`);
  }
  if (/auth-compat/.test(html) && !/\.auth\(/.test(js)) {
    idleSdk.push(`${page} loads the Auth SDK and never calls auth()`);
  }
}
check('no page loads a Firebase SDK it never calls',
  idleSdk.length === 0, idleSdk.join('\n        '));

/* ── 5. Preloads match what the page is actually set in ────────────── */

// A preload that nothing uses is a wasted round trip and a console warning;
// a missing one is a flash of fallback type. The two parchment pages
// deliberately preload EB Garamond rather than Anton, because the module
// reader is set in the serif and Anton appears only in its nav title — so
// the rule is "preload what you use", not a fixed list.
const TOKEN_FOR = {
  'anton-400.woff2':             '--font-display',
  'inter-var.woff2':             '--font-ui',
  'eb-garamond-var.woff2':       '--font-book',
  'eb-garamond-italic-var.woff2':'--font-book',
  'jetbrains-mono-var.woff2':    '--font-mono',
};

const fontProblems = [];
for (const page of pages) {
  const dir = path.dirname(page);
  const html = read(page);
  if (!/rel="stylesheet"/.test(html)) continue;

  let css = '';
  for (const m of html.matchAll(/<link[^>]+href="([^"]+\.css)"/g)) {
    const rel = path.join(dir, m[1]);
    if (fs.existsSync(path.join(repoRoot, rel))) css += read(rel);
  }

  const preloaded = [...html.matchAll(/rel="preload"[^>]+href="[^"]*?([\w-]+\.woff2)"/g)].map(m => m[1]);

  for (const file of preloaded) {
    if (!fs.existsSync(path.join(repoRoot, 'css/fonts', file))) {
      fontProblems.push(`${page} preloads ${file}, which is not in css/fonts`);
      continue;
    }
    const token = TOKEN_FOR[file];
    if (token && !css.includes(token)) {
      fontProblems.push(`${page} preloads ${file} but no stylesheet it links uses ${token}`);
    }
  }
  // Inter is the body face on every surface, parchment included.
  if (!preloaded.includes('inter-var.woff2')) {
    fontProblems.push(`${page} does not preload inter-var.woff2, which its body text is set in`);
  }
}
check('every page preloads the faces it is set in, and only those',
  fontProblems.length === 0, fontProblems.join('\n        '));

console.log(failures ? `\n>>> page load FAILED (${failures})` : '\n>>> page load OK');
process.exit(failures ? 1 : 0);
