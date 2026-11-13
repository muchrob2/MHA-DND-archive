#!/usr/bin/env node
/* Holds the spoiler line.
 *
 * The dashboard splits into two halves: what a student may open, and what
 * only the DM may. Hiding the DM half with `display:none` was the whole of
 * the enforcement, which stops a player browsing into it and does nothing
 * about a bookmark, a back button, a shared screen or a typed URL. Every
 * page in that half is campaign text, the cast as the DM knows it, or a
 * note about what happens next.
 *
 * So each DM page now gates itself, and this check is what keeps that true
 * as pages are added. It also checks the reverse direction — that no
 * player-facing page has quietly grown a link or a fetch into DM material,
 * which is the failure mode that does not look like one in review.
 *
 * NOT access control, and this file does not pretend otherwise: the
 * documents are world-readable by rule (firestore.rules) because the player
 * pages need them. This is about the accident, not the determined player
 * with a console. See the note at the top of index.js.
 *
 * CLASS-1A is deliberately out of scope. encounter.html there carries the
 * same gate and has since it was written; the rest of that directory is the
 * students' own material.
 */
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

/* The DM half, as the dashboard draws it. Kept here by hand rather than
 * scraped out of index.html on purpose: if a tile is dropped from the hub
 * table by mistake, a scraped list would stop checking the page instead of
 * failing, which is the wrong way round. */
const DM_PAGES = [
  'campaigns.html',         // the campaign text, chapter by chapter
  'campaign-overview.html', // arcs, world, villains, DM scripts
  'characters.html',        // the whole cast as the DM knows it
  'session-log.html',       // including the "next time" line
  'tonight.html',           // the run sheet for a session not yet played
  'party.html',             // every player's numbers side by side
  'loot.html',              // what is coming, and off whom
  'updates.html',           // a changelog that names unreleased chapters
];

/* Pages a student is meant to open. The Class 1-A directory is excluded by
 * instruction and by design — see the header. */
const PLAYER_PAGES = [
  'index.html', 'table.html', 'lab.html', 'heat.html', 'heropad.html',
  'sheet.html', 'shop.html', 'freetime.html', 'rules.html',
];

/* ── 1. every DM page bounces a non-DM, before it paints ── */
for (const page of DM_PAGES) {
  const html = read(page);
  const head = html.slice(0, html.indexOf('</head>'));

  check(`${page} gates itself`,
    /sessionStorage\.getItem\('mha-role'\) !== 'dm'/.test(head)
      && /location\.replace\('index\.html'\)/.test(head),
    'a DM page with no gate is one bookmark away from being read');

  // The gate must beat the body. An external or deferred script cannot:
  // the page paints, the spoiler is on screen, and the redirect is a flicker
  // too late to matter.
  check(`${page} gates before any markup parses`,
    head.indexOf("mha-role") !== -1 && head.indexOf('<body') === -1,
    'the gate must be synchronous and inside <head>');

  // A browser that refuses sessionStorage must be sent back, not let in.
  check(`${page} fails closed if storage throws`,
    /catch \(e\) \{\s*location\.replace\('index\.html'\);/.test(head));
}

/* ── 2. the gate is the same gate everywhere ──
   Eight hand-copied snippets is eight chances to fix one and miss seven. */
{
  const norm = (p) => {
    const head = read(p);
    const m = head.match(/if \(sessionStorage[\s\S]*?\n  \}/);
    return m ? m[0].replace(/\s+/g, ' ') : null;
  };
  const shapes = new Set(DM_PAGES.map(norm));
  check('all eight gates are character-for-character the same',
    shapes.size === 1 && !shapes.has(null),
    [...shapes].join('\n        ---\n        '));
}

/* ── 3. no player page links into the DM half ── */
for (const page of PLAYER_PAGES) {
  const html = read(page);
  // On the dashboard the DM tiles are legitimately present — they live
  // inside #dm-only, which is what hides them. Everywhere else a link to a
  // DM page is a hole, so only index.html gets its DM block excised first.
  let body = html;
  if (page === 'index.html') {
    const s = html.indexOf('<div id="dm-only">');
    const e = html.indexOf('<!-- /dm-only');
    check('the dashboard still marks where its DM block starts and ends',
      s !== -1 && e > s);
    body = html.slice(0, s) + html.slice(e);
    /* One documented exception: the version badge in the header. It is a
       link into the notes and it sits outside #dm-only, so the markup is
       always present and JS decides whether it is ever shown — checked
       below and in verify-updates.js. It is stripped here so the blanket
       rule can stay blanket for everything else. */
    body = body.replace(/<a class="version-badge[\s\S]*?<\/a>/, '');
    check('the badge exception is the only one, and it is gated in JS',
      !body.includes('version-badge')
        && /el\.classList\.toggle\('hidden', !\(versionLoaded && isDmView\(\)\)\)/
             .test(read('index.js')));
  }
  const leaks = DM_PAGES.filter(d => body.includes(`href="${d}"`));
  check(`${page} links to nothing in the DM half`, leaks.length === 0, leaks.join(', '));
}

/* ── 4. nor does a player page fetch DM material ──
   Comments are stripped first: several of these files explain, correctly,
   why they do NOT read the thing being searched for, and a check that fails
   on its own documentation teaches people to delete the documentation. */
{
  const strip = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  // The player pages that legitimately read one campaign document, and the
  // single thing each is allowed to take out of it.
  const ALLOWED = {
    // The job board is an appendix section written to be handed out.
    'freetime.js': ['campaigns'],
    // Recaps: sessions the table has already played. The renderer drops the
    // DM's "next time" line, which verify-updates.js checks by name.
    'heropad.js': ['session-log'],
    /* The dashboard reads both — the changelog for its unread dot, and the
       session log for the "where you left off" strip, which carries the
       "next time" line verbatim. Both are allowed here ONLY because they
       are started from one role-checked place; the pinned checks below are
       what make that an exception rather than a hole. Neither used to be
       gated: the strip rendered inside #dm-only and was taken to be hidden,
       which put the DM's note about the next session into every player's
       DOM where `display:none` was the only thing covering it. */
    'index.js': ['session-log', 'campaigns'],
  };

  const DM_DOCS = ['dm-scripts', 'session-log', 'campaigns'];
  const DM_FILES = ['updates.json', 'CAMPAIGN/villains.json', 'CAMPAIGN/npcs.json',
    'CAMPAIGN/scripts.json', 'CAMPAIGN/arc.json', 'CAMPAIGN/world.json',
    'CAMPAIGN/teachers.json', 'CAMPAIGN/loot.json'];

  for (const js of ['table.js', 'lab.js', 'heat.js', 'heropad.js', 'sheet.js',
                    'shop.js', 'freetime.js', 'rules.js', 'index.js']) {
    const src = strip(read(js));
    const allowed = ALLOWED[js] || [];

    const docLeaks = DM_DOCS
      .filter(d => !allowed.includes(d))
      .filter(d => new RegExp(`doc\\('${d}'\\)|/${d}['"\`]`).test(src));
    check(`${js} reads no DM document it has no business in`,
      docLeaks.length === 0, docLeaks.join(', '));

    const fileLeaks = DM_FILES
      .filter(f => !(js === 'index.js' && f === 'updates.json'))
      .filter(f => src.includes(f));
    check(`${js} fetches no DM-side file`, fileLeaks.length === 0, fileLeaks.join(', '));
  }

  /* The dashboard's two exceptions, pinned. Both reads hang off one
     starter, and that starter refuses to run for anybody but the DM — so
     there is a single line to read to know whether this holds. */
  const idx = strip(read('index.js'));
  check('the dashboard starts its DM reads from one role-checked place',
    /function startDmOnlyLoads\(\) \{\s*if \(!booted \|\| dmLoadsStarted \|\| !isDmView\(\)\) return;/
      .test(idx),
    'both the changelog and the session recap must hang off this');
  for (const fn of ['markUnreadUpdates', 'loadLastSession']) {
    const starter = idx.slice(idx.indexOf('function startDmOnlyLoads'));
    check(`${fn} is only ever called from it`,
      starter.includes(`    ${fn}();`)
        && (idx.match(new RegExp('^  ' + fn + '\\(\\);', 'm')) || []).length === 0,
      'a second bare call on load would undo the gate');
    check(`and ${fn} re-checks the role itself`,
      /if \(!isDmView\(\)\) return;/.test(
        idx.slice(idx.indexOf(`async function ${fn}`),
          idx.indexOf(`async function ${fn}`) + 900)),
      'belt and braces: the gate should not rest on the call site alone');
  }
  check('and the DM role picked later still starts them',
    /syncBadgeVisibility\(\);\s*startDmOnlyLoads\(\);/.test(idx),
    'the role is chosen by hand, often after this script has run');
}

/* ── 5. the campaign half of the dashboard says what it is ── */
{
  const index = read('index.html');
  const dm = index.slice(index.indexOf('<div id="dm-only">'), index.indexOf('<!-- /dm-only'));
  check('the DM section is flagged as DM only', /class="dm-flag">DM only</.test(dm));
  check('and the dashboard hides it for a player',
    /getElementById\('dm-only'\)\.style\.display = 'none'/.test(read('index.js')));
}

console.log(failures ? `\n>>> spoiler line FAILED (${failures})` : '\n>>> spoiler line OK');
process.exit(failures ? 1 : 0);
