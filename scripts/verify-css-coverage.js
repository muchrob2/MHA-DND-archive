#!/usr/bin/env node
// Every class a page can put on the screen must be styled by a stylesheet
// THAT PAGE LINKS.
//
// This guards one specific failure that had happened three times before this
// check existed, and which is invisible in review because nothing errors —
// the page just renders plain:
//
//   .page-heading / .page-sub   written in pages/campaigns.css, then the
//     markup was copied to freetime, heat, lab, loot, rules, tonight and
//     updates. Seven pages rendered their own title as 14px body copy.
//   #load-error-banner          written in pages/session-log.css, then the
//     markup was copied to loot.html and updates.html, whose "couldn't load"
//     message had no red surface.
//   .last-session-*             index.js rendered a three-line recap block
//     that pages/index.css never had a rule for at all.
//
// All three are fixed in css/components.css and css/pages/index.css. What
// this file stops is the NEXT one: shared markup moving to a second page
// without its styling, or a renderer emitting a class nobody styled.
//
// ── READING A FAILURE ───────────────────────────────────────────────────
// A new name in the report means one of three things:
//   1. A real gap. Style it, in components.css if more than one page has
//      the markup, in that page's stylesheet if not.
//   2. A layout-only wrapper whose parent does all the work, or a state
//      class JS toggles that only ever appears in a compound selector.
//      Add it to BENIGN below WITH a reason.
//   3. A typo in the class name. Fix the typo.
// Option 2 is a judgement call, so BENIGN is a list of names with reasons
// rather than a pattern — a wildcard here would have let all three of the
// bugs above through.

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

/* ── Names that are deliberately unstyled ────────────────────────────────
   Each one is a wrapper positioned entirely by its parent, or a state flag
   that only ever appears in a compound selector. Verified by hand. */
const BENIGN = {
  // layout wrappers inside a parent that is already a grid or flex row
  'grant-col':        'column of #grant-panel, which is the grid (pages/admin.css)',
  'ft-extras':        'grid cell wrapper; .ft-extra children carry the surface',
  'ft-log':           'list wrapper; .ft-log-row carries the row',
  'ht-log-col':       'column of .ht-logs, which is the grid',
  'lb-form':          'wrapper inside .lb-panel; fields are styled individually',
  'lb-side':          'wrapper inside the lab grid',
  'lb-quirks':        'list wrapper; .lb-quirk children carry the surface',
  'loot-body':        'text column of .loot-row, which is the grid',
  'bk-list':          'list wrapper; .bk-row children carry the row',
  'rail-name':        'span inside .rail-btn; the button sets the type',
  'rr-name':          'span inside .rules-rail-btn; the button sets the type',
  'sh-head-main':     'left half of .sh-head, which is the flex row',
  'sh-notes':         'wrapper inside .sh-col; .sh-note-line is styled',
  'banner-inner':     'styled in components.css as a descendant of #load-error-banner',
  'tm-target-hp-row': 'row inside .tm-zone, which sets the stack spacing',
  'dice-expr-row':    'row inside #dice-panel, which sets the stack spacing',
  'dice-adv-row':     'row inside #dice-panel, which sets the stack spacing',
  'board-prop-cat':   'prefab palette markup; board.html has no palette (board-shared.js:43)',
  'board-prop-grid':  'see board-prop-cat',
  'board-prop-icon':  'see board-prop-cat',
  'board-prop-label': 'see board-prop-cat',
  'board-prop-none':  'see board-prop-cat',

  // state flags, only ever matched in a compound selector
  'move':      'board tool name; matched as .board-tool-btn[data-tool]',
  'adv':       'dice state; matched as .die-btn.adv',
  'dis':       'dice state; matched as .die-btn.dis',
  'preset':    'heropad state; matched on a parent',
  'character': 'relationships view name; matched as a body/panel state',
  'dice':      'relationships view name; matched as a body/panel state',
};

/* Classes the three fixed bugs were about. Named explicitly so that deleting
   a rule shows up as a named failure rather than as a line in a long list. */
const MUST_BE_SHARED = {
  'css/components.css': [
    '.page-heading', '.page-sub',
    '#load-error-banner', '.banner-inner',
    '.panel-note',
    '.modal-actions',
  ],
  'css/pages/index.css': [
    '.last-session-inner', '.last-session-label',
    '.last-session-title', '.last-session-next',
  ],
};

function definedClasses(file) {
  const abs = path.join(repoRoot, file);
  if (!fs.existsSync(abs)) return null;
  const src = fs.readFileSync(abs, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Set();
  for (const m of src.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) out.add(m[1]);
  return out;
}

const pages = fs.readdirSync(repoRoot).filter(f => f.endsWith('.html'))
  .concat(fs.readdirSync(path.join(repoRoot, 'CLASS-1A'))
    .filter(f => f.endsWith('.html')).map(f => 'CLASS-1A/' + f));

const gaps = [];

for (const page of pages) {
  const dir = path.dirname(page);
  const html = read(page);

  // What this page's own <link>s define. A page with no stylesheets at all
  // (404.html is inline) has nothing to check against.
  const defined = new Set();
  for (const m of html.matchAll(/<link[^>]+href="([^"]+\.css)"/g)) {
    const found = definedClasses(path.join(dir, m[1]));
    check(`${page} links a stylesheet that exists: ${m[1]}`, found !== null);
    if (found) for (const c of found) defined.add(c);
  }
  if (!defined.size) continue;

  // What this page can emit: its own markup, plus every script it loads.
  const sources = [html];
  for (const m of html.matchAll(/<script src="([^"]+\.js)"/g)) {
    const abs = path.join(repoRoot, dir, m[1]);
    if (fs.existsSync(abs)) sources.push(fs.readFileSync(abs, 'utf8'));
  }

  const used = new Set();
  for (const src of sources) {
    // Skip interpolated class strings — `class="x ${y}"` says nothing
    // checkable about y.
    for (const m of src.matchAll(/class="([^"{}$]+)"/g)) {
      for (const c of m[1].trim().split(/\s+/)) if (c) used.add(c);
    }
    // Only the FIRST argument of a classList call names a class. Reading
    // every quoted token out of the call instead picks up whatever is in
    // the condition — campaign-overview.js:339 toggles on a getAttribute
    // ('href'), which looked like a class called "href".
    for (const m of src.matchAll(/classList\.(?:add|toggle|remove)\(\s*['"]([\w-]+)['"]/g)) {
      used.add(m[1]);
    }
  }

  const orphans = [...used].filter(c => !defined.has(c) && !(c in BENIGN)).sort();
  if (orphans.length) gaps.push(`${page}: ${orphans.join(' ')}`);
}

check('every class a page can render is styled by a stylesheet that page links',
  gaps.length === 0,
  gaps.join('\n        ') + (gaps.length
    ? '\n        → style it, or add it to BENIGN in this file with a reason'
    : ''));

// The specific recipes the three fixed bugs were about.
for (const [file, selectors] of Object.entries(MUST_BE_SHARED)) {
  const src = read(file);
  for (const sel of selectors) {
    check(`${sel} is defined in ${file}`, src.includes(sel),
      'it was moved or deleted — the pages carrying that markup now render plain');
  }
}

// .page-heading has to reach every page that uses it, which is the whole
// point of it living in components.css rather than in one page's stylesheet.
const headingPages = pages.filter(p => /class="page-(heading|sub)"/.test(read(p)));
check('every page using .page-heading loads components.css',
  headingPages.every(p => read(p).includes('css/components.css')),
  headingPages.filter(p => !read(p).includes('css/components.css')).join(' '));
check('and there is more than one such page, so it belongs in the shared file',
  headingPages.length > 1, headingPages.join(' '));

console.log(failures ? `\n>>> css coverage FAILED (${failures})` : '\n>>> css coverage OK');
process.exit(failures ? 1 : 0);
