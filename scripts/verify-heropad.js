#!/usr/bin/env node
// Structural checks for the Heropad (heropad.html / heropad.js /
// css/pages/heropad.css).
//
//   node scripts/verify-heropad.js
//
// The Heropad is built to be extended — the whole point of the APPS registry
// in heropad.js is that adding an app is one array entry. These checks guard
// the two ways that goes wrong silently:
//
//   1. The registry drifts out of shape — a duplicate id, a dock entry
//      pointing at an app that no longer exists, a render function that was
//      renamed. None of that throws until someone taps the icon.
//   2. The markup and the script stop agreeing about an element id. The page
//      wires itself with getElementById, so a renamed id in the HTML fails at
//      runtime as a null dereference on a page nobody re-tested.
//
// It parses and pattern-matches; it does not execute. Nothing here touches
// Firestore or the DOM.

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(repoRoot, p), 'utf8');

const js = read('heropad.js');
const html = read('heropad.html');
const css = read('css/pages/heropad.css');
const indexHtml = read('index.html');

let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}${ok || !detail ? '' : ': ' + detail}`);
  if (!ok) failed++;
}

/* ── The page is actually reachable ─────────────────────────────── */
check('the dashboard links to the Heropad',
  /href="heropad\.html"/.test(indexHtml));
check('the Heropad tile sits in the player section, not the DM block',
  indexHtml.indexOf('heropad.html') < indexHtml.indexOf('id="dm-only"'),
  'the tile has drifted below the DM-only section');
check('heropad.html loads its own stylesheet and script',
  /css\/pages\/heropad\.css/.test(html) && /src="heropad\.js"/.test(html));
check('heropad.html mounts the auth widget',
  /class="nav-right"/.test(html),
  'auth.js:298 mounts into .nav-right and falls back to loose-at-page-end');

/* ── The app registry ───────────────────────────────────────────── */
const appIds = [...js.matchAll(/^\s{4}id: '([a-z0-9-]+)',$/gm)].map(m => m[1]);
check('the APPS registry has entries', appIds.length > 0, 'no app ids found — has APPS changed shape?');
check('every app id is unique', new Set(appIds).size === appIds.length,
  'duplicate ids: ' + appIds.filter((id, i) => appIds.indexOf(id) !== i).join(', '));

const dockMatch = js.match(/const DOCK = \[([^\]]*)\]/);
check('DOCK is declared', !!dockMatch);
const dockIds = dockMatch ? [...dockMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1]) : [];
for (const id of dockIds) {
  check(`dock entry "${id}" is a real app`, appIds.includes(id),
    'DOCK pins an id that APPS does not define, so the dock renders empty');
}

// Every app must name a render function that exists, or the icon opens blank.
const renderNames = [...js.matchAll(/^\s{4}render: (\w+),$/gm)].map(m => m[1]);
check('every app declares a render function', renderNames.length === appIds.length,
  `${appIds.length} apps but ${renderNames.length} render functions`);
for (const name of renderNames) {
  check(`render function ${name}() is defined`,
    new RegExp(`function ${name}\\s*\\(`).test(js));
}

// Customise is the one app the dashboard tile and the page copy promise.
check('the Customise app is registered', appIds.includes('customise'));

/* ── Masaranking is admin-only, and that is a RULES fact ────────── */
// The buttons being hidden is cosmetic. Every player holds an 'editor' role,
// which can write most mha-dnd docs, so the only thing actually stopping a
// player from rewriting the class ranking is the name of the doc appearing
// in firestore.rules. If these two ever disagree, the chart is world-writable
// and nothing on the page would look any different.
check('the Masaranking app is registered', appIds.includes('masaranking'));
const rules = read('firestore.rules');
check('firestore.rules excludes masaranking from editor writes',
  /doc != 'masaranking'/.test(rules),
  "editors could rewrite the chart — add doc != 'masaranking' to the mha-dnd write rule");
check('the page gates the ranking controls on admin, not merely on sign-in',
  /canRank = e\.detail\.role === 'admin'/.test(js));
check('every ranking mutation checks canRank first',
  ['moveRank', 'setRankNote', 'resetRanking', 'scheduleRankSave'].every(fn => {
    const body = js.match(new RegExp(`function ${fn}\\([^)]*\\) \\{[\\s\\S]{0,120}`));
    return body && /if \(!canRank/.test(body[0]);
  }),
  'a mutation that skips the check would fail at the rules layer with an unexplained error');
check('the ranking doc id matches the one named in the rules',
  /doc\('masaranking'\)/.test(js));

/* ── Wallpapers ─────────────────────────────────────────────────── */
const wpIds = [...js.matchAll(/\{ id: '([a-z0-9-]+)', name: '[^']*',\n\s*css:/g)].map(m => m[1]);
check('wallpaper presets exist', wpIds.length > 0);
check('every wallpaper id is unique', new Set(wpIds).size === wpIds.length);

const defaultWp = js.match(/wallpaper: \{ type: 'preset', id: '([a-z0-9-]+)' \}/);
check('the default pad names a wallpaper', !!defaultWp);
check('the default wallpaper resolves to a real preset',
  !!defaultWp && wpIds.includes(defaultWp[1]),
  defaultWp ? `default is "${defaultWp[1]}", which is not in WALLPAPERS` : '');

/* ── Firestore limits ───────────────────────────────────────────── */
// A Firestore document is capped at 1MiB. An uploaded wallpaper is stored as
// a data URI inside the pad doc, so the budget the downscaler aims at has to
// stay comfortably under that cap — see the header note in heropad.js.
const maxBytes = Number((js.match(/const MAX_PAD_BYTES = (\d+);/) || [])[1]);
check('MAX_PAD_BYTES is set', Number.isFinite(maxBytes));
check('MAX_PAD_BYTES leaves headroom under the 1MiB document cap',
  maxBytes > 0 && maxBytes < 1048576 * 0.8,
  `${maxBytes} bytes is too close to the cap`);

// The downscaler has to actually be able to reach that budget: the last step
// must be the smallest, or a big photo fails on every attempt.
const steps = [...js.matchAll(/\{ maxDim: (\d+), quality: ([\d.]+) \}/g)]
  .map(m => ({ maxDim: Number(m[1]), quality: Number(m[2]) }));
check('the wallpaper downscaler has fallback steps', steps.length >= 2);
check('each downscale step is smaller than the last',
  steps.every((s, i) => i === 0 || (s.maxDim < steps[i - 1].maxDim && s.quality < steps[i - 1].quality)),
  'steps must shrink monotonically or the retry loop cannot converge');

// Pad doc ids go into a Firestore path. A '/' would silently address a
// subcollection instead of a document.
const docIdFn = js.match(/function padDocId\(file\) \{[\s\S]*?\n\}/);
check('padDocId strips the roster filename extension',
  !!docIdFn && /replace\(\/\\\.json\$\/, ''\)/.test(docIdFn[0]));
check('pad doc ids are covered by the existing Firestore rules',
  /'heropad-'/.test(js),
  'the mha-dnd/{doc} rule covers these; a different collection would need a rules change');

/* ── HTML and JS agree about element ids ────────────────────────── */
// Ids the script reaches for at runtime...
const usedIds = new Set([
  ...[...js.matchAll(/\$\('([a-zA-Z0-9-]+)'\)/g)].map(m => m[1]),
  ...[...js.matchAll(/getElementById\('([a-zA-Z0-9-]+)'\)/g)].map(m => m[1]),
]);
// ...minus the ones it creates itself inside app markup.
const jsCreatedIds = new Set([...js.matchAll(/id="([a-zA-Z0-9-]+)"/g)].map(m => m[1]));
const htmlIds = new Set([...html.matchAll(/id="([a-zA-Z0-9-]+)"/g)].map(m => m[1]));

const missing = [...usedIds].filter(id => !htmlIds.has(id) && !jsCreatedIds.has(id));
check('every element the script reads exists in the markup', missing.length === 0,
  'missing from heropad.html: ' + missing.join(', '));

/* ── Hidden really means hidden ─────────────────────────────────── */
// The bug this exists for: #pad-setup is shown and hidden by toggling the
// `hidden` attribute, and its rule sets `display: flex`. An author `display`
// declaration outranks the UA stylesheet's `[hidden] { display: none }`, so
// the "hidden" setup screen stayed laid out across the whole device at
// opacity 0 — invisible, and swallowing every tap aimed at the app icons
// beneath it. Tapping an app silently switched character instead of opening.
//
// Any element the markup ships as `hidden` and the CSS gives a `display` to
// needs an explicit `[hidden]` guard. Nothing about this is visible to a
// stub-DOM test, and nothing about it looks wrong in either file alone.
const hideableIds = [...html.matchAll(/<[^>]*\bid="([a-zA-Z0-9-]+)"[^>]*\bhidden\b[^>]*>/g)].map(m => m[1]);
check('the markup ships hideable elements', hideableIds.length > 0);
for (const id of hideableIds) {
  const rule = css.match(new RegExp(`#${id}\\s*\\{([^}]*)\\}`));
  if (!rule || !/(^|[\s;])display\s*:/.test(rule[1])) continue;   // no display set — the UA rule works
  check(`#${id} is actually hidden when [hidden] is set`,
    new RegExp(`#${id}\\[hidden\\]`).test(css),
    'its rule sets display, which overrides [hidden] — an invisible overlay will still eat clicks');
}

/* ── The device fits the space it is given ──────────────────────── */
// A fixed min-height taller than the viewport is how the phone ended up
// overflowing short laptop windows: the device kept its size and the page
// scrolled instead.
const deviceRule = (css.match(/#pad-device\s*\{([^}]*)\}/) || [])[1] || '';
check('#pad-device derives its size from the space available',
  /height:\s*100%/.test(deviceRule) && /aspect-ratio/.test(deviceRule),
  'height/aspect-ratio sizing keeps it inside the stage on any viewport');
const minH = (deviceRule.match(/min-height:\s*(\d+)px/) || [])[1];
check('its floor is small enough not to overflow a short window',
  !minH || Number(minH) <= 420, `min-height: ${minH}px`);
check('#pad-stage can shrink', /#pad-stage\s*\{[^}]*min-height:\s*0/.test(css),
  'without min-height:0 a flex child refuses to shrink below its content');

/* ── CSS covers what gets rendered ──────────────────────────────── */
// The device is one styled object; these are the pieces the illusion needs.
for (const sel of ['#pad-device', '#pad-wallpaper', '#pad-screen', '#pad-grid',
                   '#pad-dock', '#pad-app', '.pad-app-ico', '.wp-swatch', '.ac-swatch']) {
  check(`${sel} is styled`, css.includes(sel));
}
check('the accent custom property the script writes is consumed by the CSS',
  /--pad-accent/.test(css) && /setProperty\('--pad-accent'/.test(js));
check('a failed wallpaper image cannot punch a hole through the phone',
  /background-color:/.test(css.slice(css.indexOf('#pad-wallpaper'), css.indexOf('#pad-scrim'))),
  '#pad-wallpaper needs its own background-color, since applyPad sets only background-image');

console.log(failed ? `>>> ${failed} check(s) failed` : '>>> Heropad structure OK');
process.exit(failed ? 1 : 0);
