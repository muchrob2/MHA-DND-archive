#!/usr/bin/env node
/* Checks the campaign-reader text renderers against the real campaign data.
 *
 * campaigns.js is a classic browser script — it opens by calling
 * firebase.firestore() and closes by wiring DOM handlers — so it cannot be
 * required. The prose renderers are pure and live above the State section,
 * so this lifts that prefix and evaluates it on its own. If that boundary
 * ever moves, the slice fails loudly rather than silently testing nothing.
 *
 * What matters here is that every piece of authored text survives the
 * renderer: no dropped content, no unescaped HTML, and the structural
 * conventions (• bullets, · sub-bullets, ALL-CAPS lead-ins, ▶ cues) turning
 * into the markup the stylesheet expects.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'campaigns.js'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('PASS — ' + label); }
  else { fail++; console.log('FAIL — ' + label); }
}

// ── lift the pure prefix ────────────────────────────────────────────────────
const MARKER = '/* ─── State ──';
const cut = SRC.indexOf(MARKER);
if (cut === -1) {
  console.error('FAIL — could not find the State marker in campaigns.js; the prose renderers may have moved.');
  process.exit(1);
}
const prefix = SRC.slice(0, cut)
  // the one impure line in the prefix
  .replace('const db = firebase.firestore();', '');
const ctx = { console };
vm.createContext(ctx);
try {
  vm.runInContext(prefix + '\nthis.api = { escHtml, renderProse, renderReadAloud, enrich, classifyLine };', ctx);
} catch (e) {
  console.error('FAIL — the renderer prefix did not evaluate: ' + e.message);
  process.exit(1);
}
const { renderProse, renderReadAloud } = ctx.api;

console.log('\n>>> prose structure');

// ── bullets and sub-bullets ─────────────────────────────────────────────────
const bullets = renderProse('• FIRST THING — does a thing.\n• SECOND THING — does another.');
ok(bullets.includes('<ul class="p-bullets">'), '• lines become a bullet list');
ok((bullets.match(/<li>/g) || []).length === 2, 'one <li> per bullet');
ok(bullets.includes('<b class="lead">FIRST THING</b>'), 'an ALL-CAPS lead-in is pulled out');

const dots = renderProse('· AC 13 · HP 25 · Speed 30 ft\n· STR 13 · DEX 13');
ok(dots.includes('<ul class="p-dots">'), '· lines become a sub-bullet list');
ok(!dots.includes('<b class="lead">'), 'a dot-separated stat line is never read as a lead-in');

// A single bullet used to fall through to its own branch; check it still works.
ok(renderProse('• ONLY ONE — like this.').includes('<ul class="p-bullets">'), 'a lone bullet still makes a list');

// ── the mixed block that used to collapse into one <br> wall ───────────────
const mixed = renderProse('• THE CHOICE IS THE ENCOUNTER.\n  — ONE ON ONE, UNDER THE LAW. A single PC.\n  — AS A PAIR, IGNORING THE LAW. She declares it void.');
ok(mixed.includes('<ul class="p-children">'), 'indented — lines nest under the bullet above');
ok((mixed.match(/<ul/g) || []).length === 2, 'and produce exactly one nested list');
ok(!mixed.includes('<br>'), 'the mixed block no longer renders as a <br> wall');

// ── preamble before a list ──────────────────────────────────────────────────
const pre = renderProse('RUNNING ORDER — the gates open.\n\n• A THING — happens.');
ok(pre.includes('<p>') && pre.includes('<ul'), 'a paragraph and a following list both render');

// ── lead-in edge cases ──────────────────────────────────────────────────────
ok(renderProse('• THE ONE THING: the commentary.').includes('<b class="lead">THE ONE THING</b>'),
  'a colon lead-in is pulled out too');
ok(!renderProse('• 1962 — a building was knocked down.').includes('<b class="lead">'),
  'a bare year is not treated as a label');
ok(renderProse('· HEAT 0–1 — a knot of Strays.').includes('<b class="lead">HEAT 0–1</b>'),
  'a lead-in containing an en dash is matched non-greedily');

// ── escaping ────────────────────────────────────────────────────────────────
const nasty = renderProse('• A THING — <script>alert(1)</script> & "quoted"');
ok(!nasty.includes('<script>'), 'markup in content is escaped, not executed');
ok(nasty.includes('&lt;script&gt;'), 'and is escaped the usual way');
ok(nasty.includes('&amp;'), 'ampersands are escaped');

console.log('\n>>> read-aloud cues');

const ra = renderReadAloud('▶ OPENING\n\nIt is a Monday in July.\n\n▶ WHAT SHE SAYS\n\n"Right. Two things."');
ok((ra.match(/class="ra-cue"/g) || []).length === 2, 'each ▶ becomes its own cue card');
ok(ra.includes('<div class="ra-cue-label">OPENING</div>'), 'the cue label is the ▶ line');
ok(ra.includes('It is a Monday in July.'), 'cue body text survives');

const beats = renderReadAloud('▶ OPENING\n\nTHEY SEE — a Monday in July.\nSAMITSU SAYS — "There\'s soba."');
ok(beats.includes('class="ra-beat"'), 'labelled lines become performance beats');
ok(beats.includes('<div class="ra-beat-label">THEY SEE</div>'), 'the beat label is split out');
ok(beats.includes('a Monday in July.'), 'the beat text is kept');

const ask = renderReadAloud('▶ OPENING\n\nASK THEM — It is the weekend. What do you do?');
ok(ask.includes('ra-ask'), 'an ASK beat is marked as a prompt, not read-aloud text');
ok(ask.includes('❓'), 'and carries the prompt marker');

const prose = renderReadAloud('No cues here. Just two lines.\nLike this.');
ok(prose.includes('<p>') && !prose.includes('ra-cue'), 'a read-aloud with no ▶ falls back to prose');

const note = renderReadAloud('Read this first.\n\n▶ OPENING\n\nThen this.');
ok(note.includes('class="ra-note"'), 'text before the first ▶ is a standing note');
ok(note.includes('Read this first.'), 'and is not dropped');

// A paragraph that only *looks* like beats must not be mangled.
const notBeats = renderReadAloud('▶ OPENING\n\nTHEY SEE — a thing.\nAnd then a plain sentence.');
ok(!notBeats.includes('ra-beat'), 'a mixed block stays prose rather than half-formatting');

// Romanised Japanese names carry macrons, and a capital Ō is not in [A-Z]. A
// block of beats labelled with character names used to collapse to prose the
// moment one of the names was ŌKURA or KŌGA.
const macron = renderReadAloud('▶ QUESTIONS\n\nMINAGAWA — "Would he be alive?"\nŌKURA — "How would you have known?"');
ok((macron.match(/class="ra-beat"/g) || []).length === 2, 'a macronised name still reads as a beat label');
ok(renderProse('· KŌGA RIN — holds the centre.').includes('<b class="lead">KŌGA RIN</b>'),
  'and still reads as a prose lead-in');

console.log('\n>>> every authored string survives the renderer');

// The real test: run all campaign text through and check nothing is lost.
const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'CAMPAIGN/campaigns.json'), 'utf8'));
const fields = [];
for (const c of doc.campaigns || []) {
  for (const b of c.background || []) fields.push([c.id + '/bg/' + b.id, b.body]);
  for (const a of c.appendix || []) fields.push([c.id + '/apx/' + a.id, a.body]);
  for (const ch of c.chapters || []) {
    for (const k of ['intro', 'dmNote', 'milestone']) if (ch[k]) fields.push([ch.id + '/' + k, ch[k]]);
    if (ch.closing?.body) fields.push([ch.id + '/closing', ch.closing.body]);
    for (const s of ch.sections || []) {
      for (const k of ['body', 'developments', 'treasure', 'dmNote']) if (s[k]) fields.push([s.id + '/' + k, s[k]]);
      if (s.aside?.body) fields.push([s.id + '/aside', s.aside.body]);
      if (s.readAloud) fields.push([s.id + '/readAloud', s.readAloud, 'ra']);
    }
    for (const q of ch.sidequests || []) {
      for (const k of ['body', 'reward']) if (q[k]) fields.push([q.id + '/' + k, q[k]]);
    }
  }
}

// Strip tags and entities and compare the words that come out with the words
// that went in. Catches a renderer branch that drops a line.
function textOf(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}
const words = s => s.replace(/[•·▶]/g, ' ').replace(/\s+/g, ' ').trim();

let lost = [];
let threw = [];
for (const [label, text, kind] of fields) {
  let html;
  try {
    html = kind === 'ra' ? renderReadAloud(text) : renderProse(text);
  } catch (e) {
    threw.push(label + ': ' + e.message);
    continue;
  }
  if (/<(script|iframe|object)/i.test(html)) { lost.push(label + ': emitted raw ' + RegExp.$1); continue; }
  const want = words(text);
  const got = textOf(html);
  // The renderer re-spaces around pulled-out labels and separators, so compare
  // on alphanumerics only — content loss shows up, whitespace churn does not.
  const norm = s => s.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  if (norm(want) !== norm(got)) {
    lost.push(label + ': ' + norm(want).length + ' chars in, ' + norm(got).length + ' out');
  }
}

ok(threw.length === 0, 'no field throws in the renderer' + (threw.length ? ' — ' + threw.slice(0, 3).join('; ') : ''));
ok(lost.length === 0, `all ${fields.length} authored fields round-trip without losing content` +
  (lost.length ? ' — ' + lost.slice(0, 5).join('; ') : ''));

console.log(`\n>>> campaign prose ${fail ? 'FAILED' : 'OK'} (${pass} passed, ${fail} failed, ${fields.length} fields checked)`);
process.exit(fail ? 1 : 0);
