// Page logic for heropad.html. Extracted from the HTML so it can be linted,
// diffed and tested directly rather than regex-scraped out of markup.
// Loaded as a CLASSIC script, not a module: the page wires controls with
// inline onclick= handlers that resolve against globals, and top-level
// declarations here become globals exactly as they did inline. type="module"
// would scope them and silently break every handler.
//
// Runs after auth.js, so fbAuthReady/isAdmin/canEdit are already defined.
//
// ── What this page is ───────────────────────────────────────────────
// The Heropad is the phone the characters carry in-world. The screen is a
// phone home screen: status bar, wallpaper, a grid of app icons, a dock.
// Tapping an icon slides that app up over the home screen.
//
// ── Adding an app ───────────────────────────────────────────────────
// Everything on the home screen comes from the APPS array below. One entry
// per app:
//
//   { id, name, icon, accent, render() }
//
//   id      stable string; also the localStorage/anchor key
//   name    label under the icon
//   icon    a single emoji (no image assets ship with this page)
//   accent  CSS colour for the icon tile
//   render  returns the app's HTML as a string; called on every open
//   onOpen  optional, called after the HTML is in the DOM (wire listeners,
//           focus a field, start a timer)
//
// Add the entry, and optionally list its id in DOCK to pin it to the dock.
// Nothing else on this page needs to change. Handlers inside an app's HTML
// are inline onclick= like the rest of the codebase, so anything they call
// must be a top-level function in this file.
//
// ── Where a pad is stored ───────────────────────────────────────────
// One pad per character, keyed by the roster's `file` ("ren_suzuki.json").
// Saved to BOTH:
//   * localStorage — always, synchronously. This is what makes the pad work
//     signed-out and offline, and what makes it paint instantly on load.
//   * Firestore mha-dnd/heropad-<file>, when signed in with write access, so
//     a player's pad follows them from the table laptop to their own phone.
//
// One Firestore doc PER PAD rather than one doc holding everyone's: a
// wallpaper a player uploaded is a few hundred KB of data URI, and Firestore
// caps a document at 1MB. Twenty students in one doc would blow that cap and
// start failing everyone's saves at once. Separate docs also mean two players
// customising at the same time can't race — nobody writes anyone else's doc.
// The existing firestore.rules `match /mha-dnd/{doc}` already covers these
// (public read, admin-or-editor write), so no rules change was needed.

const db = firebase.firestore();

const LS_PADS = 'mha-heropad-v1';
const LS_ACTIVE = 'mha-heropad-active';

// Firestore's hard limit is 1MB per document. The guard sits well under it so
// a pad can never be the reason a save starts failing — an uploaded wallpaper
// is downscaled until it fits (see readWallpaperFile).
const MAX_PAD_BYTES = 700000;

/* ── Wallpapers ─────────────────────────────────────────────────────
   Pure CSS: gradients and repeating patterns, no image files. That keeps
   the page dependency-free, means a preset costs nothing to store (just
   its id) and means presets can never 404. A player's own photo is stored
   as a downscaled data URI instead — see the `image` wallpaper type.
   ─────────────────────────────────────────────────────────────────── */
const WALLPAPERS = [
  { id: 'ua-dawn', name: 'U.A. Dawn',
    css: 'radial-gradient(95% 62% at 50% -8%, rgba(255,194,32,.55), transparent 70%), linear-gradient(180deg, #241903 0%, #0D0F16 58%, #08090D 100%)' },
  { id: 'plus-ultra', name: 'Plus Ultra',
    css: 'repeating-conic-gradient(from 0deg at 50% 38%, rgba(255,255,255,.06) 0deg 2deg, transparent 2deg 7deg), radial-gradient(78% 55% at 50% 38%, #FF2E4D 0%, #6A0A18 58%, #140609 100%)' },
  { id: 'quiet-night', name: 'Quiet Night',
    css: 'radial-gradient(88% 60% at 72% 6%, #26407C 0%, #0B1226 58%, #05070E 100%)' },
  { id: 'heights', name: 'Heights Alliance',
    css: 'radial-gradient(90% 66% at 26% 104%, #0C6350 0%, #0A1A1E 58%, #06090C 100%)' },
  { id: 'halftone', name: 'Halftone',
    css: 'radial-gradient(circle at center, rgba(255,255,255,.11) 1.2px, transparent 1.4px) 0 0 / 13px 13px, linear-gradient(158deg, #1D202C 0%, #0A0B11 100%)' },
  { id: 'signal', name: 'Signal',
    css: 'radial-gradient(80% 55% at 50% 100%, rgba(168,85,247,.5), transparent 68%), linear-gradient(180deg, #150C22 0%, #08070E 100%)' },
  { id: 'hazard', name: 'Hazard Tape',
    css: 'repeating-linear-gradient(135deg, rgba(255,160,35,.16) 0 15px, transparent 15px 30px), linear-gradient(180deg, #241804 0%, #0B0B0F 100%)' },
  { id: 'carbon', name: 'Carbon',
    css: 'repeating-linear-gradient(0deg, rgba(255,255,255,.045) 0 1px, transparent 1px 8px), repeating-linear-gradient(90deg, rgba(255,255,255,.045) 0 1px, transparent 1px 8px), linear-gradient(180deg, #1B1E29 0%, #08090D 100%)' },
];

const ACCENTS = [
  { name: 'Gold', value: '#FFC220' },
  { name: 'Crimson', value: '#FF2E4D' },
  { name: 'Blue', value: '#2F6BFF' },
  { name: 'Teal', value: '#12D296' },
  { name: 'Green', value: '#3DDC64' },
  { name: 'Amber', value: '#FFA023' },
  { name: 'Purple', value: '#A855F7' },
  { name: 'Bone', value: '#F2F5FA' },
];

function defaultPad() {
  return {
    wallpaper: { type: 'preset', id: 'ua-dawn' },
    accent: '#FFC220',
    carrier: 'U.A. NET',
  };
}

/* ── State ──────────────────────────────────────────────────────── */
let ROSTER = [];
let pads = {};              // every pad this device knows, keyed by roster file
let activeFile = null;      // which one is on screen
let pad = defaultPad();     // the active pad (always a member of `pads`)
let canSync = false;        // signed in with write access to mha-dnd docs
let openAppId = null;
let padUnsub = null;        // live-sync listener for the active pad

/* ── Helpers ────────────────────────────────────────────────────── */
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function $(id) { return document.getElementById(id); }

// Wallpaper URLs go into a CSS value, not HTML, so escHtml is the wrong
// escape here. Quotes and backslashes are the only characters that can break
// out of url("…"); data URIs and ordinary http URLs never contain them.
function cssUrl(src) {
  return 'url("' + String(src == null ? '' : src).replace(/["\\]/g, '') + '")';
}
function padDocId(file) {
  return 'heropad-' + String(file).replace(/\.json$/, '');
}
function wallpaperById(id) {
  return WALLPAPERS.find(w => w.id === id) || WALLPAPERS[0];
}
function ownerStudent() {
  return ROSTER.find(s => s.file === activeFile) || null;
}

/* ── The app registry ───────────────────────────────────────────────
   See the "Adding an app" note at the top of this file.
   ─────────────────────────────────────────────────────────────────── */
const APPS = [
  {
    id: 'customise',
    name: 'Customise',
    icon: '🎨',
    accent: '#FFC220',
    render: renderCustomiseApp,
  },
  {
    id: 'masaranking',
    name: 'Masaranking',
    icon: '🧲',
    accent: '#FF2E4D',
    render: renderMasarankingApp,
  },
  {
    // Contacts is deliberately small: it exists to prove the app API above
    // with a real, data-driven app rather than a placeholder, and it reads
    // CLASS-1A/roster.json, which is already on disk. Delete the entry to
    // remove it — nothing else references it.
    id: 'contacts',
    name: 'Contacts',
    icon: '👥',
    accent: '#2F6BFF',
    render: renderContactsApp,
  },
];

// Pinned to the dock along the bottom. Ids must exist in APPS.
const DOCK = ['customise'];

function appById(id) { return APPS.find(a => a.id === id) || null; }

/* ── Painting the pad ───────────────────────────────────────────── */

// Everything that depends on the pad's own settings. Called on load, on
// owner change, and on every customisation so edits preview live.
function applyPad() {
  const device = $('pad-device');
  const wall = $('pad-wallpaper');
  const w = pad.wallpaper || defaultPad().wallpaper;

  if (w.type === 'image' && w.src) {
    wall.style.backgroundImage = cssUrl(w.src);
    wall.style.backgroundSize = 'cover';
    wall.style.backgroundPosition = 'center';
    wall.style.backgroundRepeat = 'no-repeat';
  } else {
    const preset = wallpaperById(w.id);
    wall.style.backgroundImage = preset.css;
    // The presets carry their own sizing in the shorthand (halftone/carbon
    // are tiled), so these must be cleared rather than left on `cover` from
    // a previously-set photo.
    wall.style.backgroundSize = '';
    wall.style.backgroundPosition = '';
    wall.style.backgroundRepeat = '';
  }

  device.style.setProperty('--pad-accent', pad.accent || '#FFC220');
  $('pad-carrier').textContent = pad.carrier || 'U.A. NET';
}

function renderClock() {
  const now = new Date();
  $('pad-clock').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  $('pad-day').textContent = now.toLocaleDateString([], { weekday: 'long' });
  $('pad-date').textContent = now.toLocaleDateString([], { day: 'numeric', month: 'long' });
}

function renderOwnerLine() {
  const s = ownerStudent();
  $('pad-owner-line').innerHTML = s
    ? escHtml(s.name) + '<span class="pad-owner-quirk">' + escHtml(s.quirk || '') + '</span>'
    : 'No pad selected';
}

function iconHtml(app) {
  return `<button type="button" role="listitem" class="pad-app-btn" onclick="openApp('${app.id}')"
            aria-label="Open ${escHtml(app.name)}">
            <span class="pad-app-ico" style="--ico:${escHtml(app.accent)}">${escHtml(app.icon)}</span>
            <span class="pad-app-name">${escHtml(app.name)}</span>
          </button>`;
}

function renderHome() {
  const docked = new Set(DOCK);
  $('pad-grid').innerHTML = APPS.filter(a => !docked.has(a.id)).map(iconHtml).join('');
  $('pad-dock').innerHTML = DOCK.map(id => appById(id)).filter(Boolean).map(iconHtml).join('');
}

/* ── Opening and closing apps ───────────────────────────────────── */
function openApp(id) {
  const app = appById(id);
  if (!app) return;
  openAppId = id;
  $('pad-app-icon').textContent = app.icon;
  $('pad-app-title').textContent = app.name;
  $('pad-app-body').innerHTML = app.render();
  const win = $('pad-app');
  win.hidden = false;
  // Next frame, so the browser has a chance to lay the panel out at its
  // off-screen start position before the transition to `open` runs.
  requestAnimationFrame(() => win.classList.add('open'));
  if (app.onOpen) app.onOpen();
  $('pad-app-close').focus();
}

function closeApp() {
  const win = $('pad-app');
  win.classList.remove('open');
  openAppId = null;
  setTimeout(() => { if (!openAppId) { win.hidden = true; $('pad-app-body').innerHTML = ''; } }, 240);
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && openAppId) closeApp();
});

/* ══ App: Customise ═════════════════════════════════════════════════
   Wallpaper, accent colour and the carrier text in the status bar.
   Every control applies immediately so the pad behind the panel previews
   the change, then schedules a save.
   ═══════════════════════════════════════════════════════════════════ */
function renderCustomiseApp() {
  const w = pad.wallpaper || {};
  const swatches = WALLPAPERS.map(p => `
    <button type="button" class="wp-swatch${w.type === 'preset' && w.id === p.id ? ' sel' : ''}"
            data-wp="${p.id}" onclick="setWallpaperPreset('${p.id}')"
            aria-label="${escHtml(p.name)} wallpaper">
      <span class="wp-chip" style="background-image:${p.css}"></span>
      <span class="wp-name">${escHtml(p.name)}</span>
    </button>`).join('');

  const accents = ACCENTS.map(a => `
    <button type="button" class="ac-swatch${(pad.accent || '').toLowerCase() === a.value.toLowerCase() ? ' sel' : ''}"
            data-ac="${a.value}" onclick="setAccent('${a.value}')"
            style="--sw:${a.value}" title="${escHtml(a.name)}" aria-label="${escHtml(a.name)} accent"></button>`).join('');

  return `
    <p class="cz-lead">Your pad, your rules. Changes preview straight away and save on their own.</p>

    <section class="cz-block">
      <h3 class="cz-h">Wallpaper</h3>
      <div class="wp-grid">${swatches}</div>
    </section>

    <section class="cz-block">
      <h3 class="cz-h">Your own picture</h3>
      <p class="cz-note">Photos are shrunk to fit before they're stored, so a big one is fine.</p>
      <div class="cz-row">
        <label class="cz-file">
          Choose a photo
          <input type="file" accept="image/*" onchange="onWallpaperFile(this)" hidden>
        </label>
        ${w.type === 'image' ? '<button type="button" class="cz-btn" onclick="clearWallpaperImage()">Remove photo</button>' : ''}
      </div>
      <div class="cz-row">
        <input type="url" id="cz-url" class="cz-input" placeholder="…or paste an image link"
               value="${w.type === 'image' && w.src && !String(w.src).startsWith('data:') ? escHtml(w.src) : ''}">
        <button type="button" class="cz-btn" onclick="setWallpaperUrl()">Use link</button>
      </div>
      <div id="cz-wall-msg" class="cz-msg" role="status"></div>
    </section>

    <section class="cz-block">
      <h3 class="cz-h">Accent</h3>
      <div class="ac-grid">${accents}</div>
      <div class="cz-row">
        <label class="cz-label" for="cz-accent-custom">Or pick your own</label>
        <input type="color" id="cz-accent-custom" class="cz-color" value="${escHtml(pad.accent || '#FFC220')}"
               oninput="setAccent(this.value)">
      </div>
    </section>

    <section class="cz-block">
      <h3 class="cz-h">Network name</h3>
      <p class="cz-note">The text up in the status bar.</p>
      <input type="text" id="cz-carrier" class="cz-input" maxlength="18"
             value="${escHtml(pad.carrier || '')}" placeholder="U.A. NET"
             oninput="setCarrier(this.value)">
    </section>

    <section class="cz-block">
      <button type="button" class="cz-btn danger" onclick="resetPad()">Reset this pad</button>
    </section>`;
}

// Swatch selection is toggled in place rather than by re-rendering the app:
// a re-render would blow away the carrier field's caret mid-typing and drop
// focus while someone drags the colour picker.
function refreshSwatchSelection() {
  const w = pad.wallpaper || {};
  document.querySelectorAll('.wp-swatch').forEach(el => {
    el.classList.toggle('sel', w.type === 'preset' && el.dataset.wp === w.id);
  });
  document.querySelectorAll('.ac-swatch').forEach(el => {
    el.classList.toggle('sel', (pad.accent || '').toLowerCase() === (el.dataset.ac || '').toLowerCase());
  });
}

function czMsg(text, isError) {
  const el = $('cz-wall-msg');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('err', !!isError);
}

function setWallpaperPreset(id) {
  pad.wallpaper = { type: 'preset', id };
  applyPad();
  refreshSwatchSelection();
  czMsg('');
  schedulePadSave();
}

function setAccent(value) {
  pad.accent = value;
  applyPad();
  refreshSwatchSelection();
  schedulePadSave();
}

function setCarrier(value) {
  pad.carrier = value;
  applyPad();
  schedulePadSave();
}

function setWallpaperUrl() {
  const input = $('cz-url');
  if (!input) return;
  const url = input.value.trim();
  if (!url) { czMsg('Paste a link first.', true); return; }
  pad.wallpaper = { type: 'image', src: url };
  applyPad();
  refreshSwatchSelection();
  czMsg('Wallpaper set from link. If it ever stops loading, the pad falls back to a plain background.');
  schedulePadSave();
  if (openAppId === 'customise') $('pad-app-body').innerHTML = renderCustomiseApp();
}

function clearWallpaperImage() {
  pad.wallpaper = defaultPad().wallpaper;
  applyPad();
  schedulePadSave();
  if (openAppId === 'customise') $('pad-app-body').innerHTML = renderCustomiseApp();
}

// Draw the picked file through a canvas at a capped size and re-encode it as
// JPEG. Straight off a modern phone camera an image is several megabytes —
// far past both the Firestore document cap and localStorage's ~5MB — and none
// of that detail survives being shown at phone-wallpaper size anyway. Each
// step down is tried in turn and the first one that fits the budget wins.
const WALLPAPER_STEPS = [
  { maxDim: 1600, quality: 0.72 },
  { maxDim: 1100, quality: 0.62 },
  { maxDim: 800, quality: 0.52 },
];

function downscaleImage(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('That file could not be read.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("That file isn't an image the browser can open."));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const ctx = cv.getContext('2d');
        // JPEG has no alpha: without this, a transparent PNG re-encodes onto
        // black instead of onto the page's own dark ground.
        ctx.fillStyle = '#08090D';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(cv.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function onWallpaperFile(input) {
  const file = input.files && input.files[0];
  input.value = ''; // so picking the same file twice still fires a change
  if (!file) return;
  czMsg('Shrinking your photo…');
  try {
    let chosen = null;
    for (const step of WALLPAPER_STEPS) {
      const dataUri = await downscaleImage(file, step.maxDim, step.quality);
      if (dataUri.length <= MAX_PAD_BYTES) { chosen = dataUri; break; }
    }
    if (!chosen) {
      czMsg("That picture is too detailed to store even shrunk down. Try a smaller one, or paste a link to it instead.", true);
      return;
    }
    pad.wallpaper = { type: 'image', src: chosen };
    applyPad();
    refreshSwatchSelection();
    czMsg('Wallpaper set.');
    schedulePadSave();
    if (openAppId === 'customise') $('pad-app-body').innerHTML = renderCustomiseApp();
  } catch (e) {
    czMsg(e.message || 'That photo could not be used.', true);
  }
}

function resetPad() {
  pad = defaultPad();
  pads[activeFile] = pad;
  applyPad();
  schedulePadSave();
  if (openAppId === 'customise') $('pad-app-body').innerHTML = renderCustomiseApp();
}

/* ══ App: Masaranking ═══════════════════════════════════════════════
   Masahata's ranking chart off the common room fridge (CAMPAIGN/arc.json,
   recurring_elements.ranking_chart), which persists across arcs and which
   several members of Class 1-A care about far more than they admit.

   Unlike a pad, this is ONE list shared by the whole class: a single
   Firestore doc at mha-dnd/masaranking, live to every open Heropad. The DM
   keeps it and nobody else can touch it — that is enforced in
   firestore.rules, not here. Hiding the buttons would be theatre: every
   player holds an 'editor' role, which can write most mha-dnd docs, so the
   doc is named in the rules alongside encounter-state as admin-only.

   Stored as an ordered array of { file, note }. Order IS the ranking —
   there is no rank number in the data, so a reorder can't leave two people
   holding the same rank or a gap where someone was removed.
   ═══════════════════════════════════════════════════════════════════ */
const FS_RANK_DOC = db.collection('mha-dnd').doc('masaranking');

let ranking = null;      // [{ file, note }] in rank order, or null until loaded
let rankUnsub = null;
let canRank = false;     // admin only — see the rules note above
let _rankSaveTimer = null;
let _rankSaveInFlight = false;

// The stored order and the roster drift apart the moment a student is added
// or removed. Reconcile rather than trusting either: keep the ranked order
// for everyone still in the class, drop anyone who left, and put new arrivals
// at the bottom — which is also exactly where Masahata would file them.
function reconcileRanking(stored) {
  const byFile = new Map(ROSTER.map(s => [s.file, s]));
  const seen = new Set();
  const out = [];
  for (const entry of (Array.isArray(stored) ? stored : [])) {
    if (!entry || !byFile.has(entry.file) || seen.has(entry.file)) continue;
    seen.add(entry.file);
    out.push({ file: entry.file, note: typeof entry.note === 'string' ? entry.note : '' });
  }
  for (const s of ROSTER) {
    if (!seen.has(s.file)) out.push({ file: s.file, note: '' });
  }
  return out;
}

function renderMasarankingApp() {
  if (!ranking) return '<p class="ct-empty">Fetching the chart…</p>';
  if (!ranking.length) return '<p class="ct-empty">Nobody on the chart yet.</p>';

  const byFile = new Map(ROSTER.map(s => [s.file, s]));
  const rows = ranking.map((entry, i) => {
    const s = byFile.get(entry.file);
    if (!s) return '';
    const isOwner = entry.file === activeFile;
    const medal = i < 3 ? ` mr-top mr-top${i + 1}` : '';
    const controls = canRank ? `
      <span class="mr-moves">
        <button type="button" class="mr-move" id="mr-up-${escHtml(entry.file)}"
                onclick="moveRank('${escHtml(entry.file)}',-1)" ${i === 0 ? 'disabled' : ''}
                aria-label="Move ${escHtml(s.name)} up">▲</button>
        <button type="button" class="mr-move" id="mr-dn-${escHtml(entry.file)}"
                onclick="moveRank('${escHtml(entry.file)}',1)" ${i === ranking.length - 1 ? 'disabled' : ''}
                aria-label="Move ${escHtml(s.name)} down">▼</button>
      </span>` : '';
    const note = canRank
      ? `<input type="text" class="mr-note-inp" maxlength="60" placeholder="Masahata's note…"
                value="${escHtml(entry.note)}" aria-label="Note for ${escHtml(s.name)}"
                oninput="setRankNote('${escHtml(entry.file)}', this.value)">`
      : (entry.note ? `<span class="mr-note">${escHtml(entry.note)}</span>` : '');

    return `<li class="mr-row${isOwner ? ' me' : ''}${medal}">
      <span class="mr-rank">${i + 1}</span>
      <span class="mr-body">
        <span class="mr-name">${escHtml(s.name)}${isOwner ? '<em>you</em>' : ''}</span>
        <span class="mr-quirk">${escHtml(s.quirk || '')}</span>
        ${note}
      </span>
      ${controls}
    </li>`;
  }).join('');

  return `
    <p class="cz-lead mr-lead">The chart on the common room fridge. Masahata keeps it.
      ${canRank ? 'Yours to rearrange — everyone sees it change.' : 'Arguing with it will not move you up it.'}</p>
    <ol class="mr-list">${rows}</ol>
    ${canRank ? `<div class="cz-row mr-admin">
      <button type="button" class="cz-btn danger" onclick="resetRanking()">Reset to roster order</button>
    </div>` : ''}
    <p class="mr-foot" id="mr-foot"></p>`;
}

function rerenderRankingIfOpen(focusId) {
  if (openAppId !== 'masaranking') return;
  $('pad-app-body').innerHTML = renderMasarankingApp();
  // The row moved out from under the pointer, so the button that was just
  // clicked is a different element now. Put focus back on its replacement or
  // a keyboard user loses their place on every nudge.
  if (focusId) {
    const btn = document.getElementById(focusId);
    if (btn && !btn.disabled) btn.focus();
  }
}

function moveRank(file, delta) {
  if (!canRank || !ranking) return;
  const i = ranking.findIndex(e => e.file === file);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= ranking.length) return;
  const [entry] = ranking.splice(i, 1);
  ranking.splice(j, 0, entry);
  scheduleRankSave();
  rerenderRankingIfOpen((delta < 0 ? 'mr-up-' : 'mr-dn-') + file);
}

// Deliberately does NOT re-render: that would drop the caret mid-sentence.
function setRankNote(file, value) {
  if (!canRank || !ranking) return;
  const entry = ranking.find(e => e.file === file);
  if (!entry) return;
  entry.note = value;
  scheduleRankSave();
}

function resetRanking() {
  if (!canRank) return;
  ranking = ROSTER.map(s => ({ file: s.file, note: '' }));
  scheduleRankSave();
  rerenderRankingIfOpen();
}

function rankFoot(text) {
  const el = $('mr-foot');
  if (el) el.textContent = text || '';
}

function scheduleRankSave() {
  if (!canRank) return;
  clearTimeout(_rankSaveTimer);
  // Cleared as it fires — see the same note on schedulePadSave. A spent timer
  // id is truthy, and startRankLiveSync reads it as "unsaved edit on screen".
  _rankSaveTimer = setTimeout(() => { _rankSaveTimer = null; pushRanking(); }, 500);
  rankFoot('Saving…');
}

async function pushRanking() {
  _rankSaveInFlight = true;
  try {
    await fbAuthReady;
    // Whole-document set, like a pad: the DM is the only writer this doc will
    // ever have, so there is no concurrent edit for a merge to protect.
    await FS_RANK_DOC.set({ entries: ranking, updatedAt: Date.now() });
    rankFoot('Saved — the whole class sees this.');
  } catch (e) {
    rankFoot('Could not save: ' + (e.code || e.message));
  } finally {
    _rankSaveInFlight = false;
  }
}

function startRankLiveSync() {
  if (rankUnsub) { rankUnsub(); rankUnsub = null; }
  rankUnsub = FS_RANK_DOC.onSnapshot(snap => {
    // Cached replays are this tab's own stale copy, not news — same trap the
    // board and the pads guard against.
    if (snap.metadata && snap.metadata.fromCache) return;
    // Don't let the server's older copy land on top of a nudge that hasn't
    // been written yet.
    if (_rankSaveInFlight || _rankSaveTimer) return;
    const next = reconcileRanking(snap.exists ? snap.data().entries : []);
    if (JSON.stringify(next) === JSON.stringify(ranking)) return;
    ranking = next;
    rerenderRankingIfOpen();
  }, err => console.error('[heropad] ranking sync stopped:', err));
}

async function loadRanking() {
  try {
    await fbAuthReady;
    const snap = await FS_RANK_DOC.get();
    ranking = reconcileRanking(snap.exists ? snap.data().entries : []);
  } catch {
    // Offline, or the doc has never been written. Roster order is a truthful
    // starting chart rather than an empty app.
    ranking = reconcileRanking([]);
  }
  rerenderRankingIfOpen();
}

/* ══ App: Contacts ══════════════════════════════════════════════════
   The class list straight off CLASS-1A/roster.json. See the note on the
   APPS entry — this is the worked example of the app API.
   ═══════════════════════════════════════════════════════════════════ */
function renderContactsApp() {
  if (!ROSTER.length) return '<p class="ct-empty">The class list could not be loaded.</p>';
  const rows = ROSTER.map(s => {
    const isOwner = s.file === activeFile;
    const initials = String(s.name || '?').split(/\s+/).map(p => p[0]).slice(0, 2).join('');
    return `<li class="ct-row${isOwner ? ' me' : ''}">
      <span class="ct-avatar">${escHtml(initials)}</span>
      <span class="ct-body">
        <span class="ct-name">${escHtml(s.name)}${isOwner ? '<em>you</em>' : ''}</span>
        <span class="ct-quirk">${escHtml(s.quirk || '')}</span>
      </span>
    </li>`;
  }).join('');
  return `<p class="cz-lead">Class 1-A — ${ROSTER.length} students.</p><ul class="ct-list">${rows}</ul>`;
}

/* ══ Persistence ════════════════════════════════════════════════════ */

function loadLocalPads() {
  try { pads = JSON.parse(localStorage.getItem(LS_PADS) || '{}') || {}; } catch { pads = {}; }
}
function saveLocalPads() {
  try {
    localStorage.setItem(LS_PADS, JSON.stringify(pads));
  } catch {
    // Quota. The pad is still live on screen and still goes to Firestore for
    // anyone signed in; only this device's offline copy is lost, so say so
    // rather than failing silently or throwing out of a change handler.
    setSyncNote('This device is out of storage — your pad is live, but it may not survive a reload here.');
  }
}

let _padSaveTimer = null;
let _padSaveInFlight = false;

function schedulePadSave() {
  pads[activeFile] = pad;
  saveLocalPads();
  if (!canSync || !activeFile) return;
  clearTimeout(_padSaveTimer);
  // Cleared as it fires, not just when it's replaced: startPadLiveSync treats
  // a live timer as "there is an unsaved edit on screen" and refuses remote
  // snapshots while one exists. A spent timer id is still truthy, so leaving
  // it set would wedge live sync shut after the very first save.
  _padSaveTimer = setTimeout(() => { _padSaveTimer = null; pushPad(); }, 500);
}

async function pushPad() {
  const file = activeFile;
  const body = JSON.stringify(pad);
  if (body.length > MAX_PAD_BYTES) {
    setSyncNote('This pad is too big to sync — it stays on this device.');
    return;
  }
  _padSaveInFlight = true;
  try {
    await fbAuthReady;
    // A plain set(): a pad doc is one player's own single-writer state, so
    // there is nothing here for the fsMergeSave three-way merge to protect —
    // no arrays, no second editor. The doc is whole-pad or nothing.
    await db.collection('mha-dnd').doc(padDocId(file)).set({ pad, updatedAt: Date.now() });
    setSyncNote('Saved to your account.');
  } catch (e) {
    setSyncNote('Saved on this device only — syncing failed (' + (e.code || e.message) + ').');
  } finally {
    _padSaveInFlight = false;
  }
}

// Pull the pad for `file` from Firestore, falling back to whatever this
// device already has. The local copy paints first so the pad is never blank
// while the network is in flight.
async function loadPad(file) {
  pad = pads[file] ? Object.assign(defaultPad(), pads[file]) : defaultPad();
  applyPad();
  try {
    await fbAuthReady;
    const snap = await db.collection('mha-dnd').doc(padDocId(file)).get();
    if (snap.exists && snap.data() && snap.data().pad && file === activeFile) {
      pad = Object.assign(defaultPad(), snap.data().pad);
      pads[file] = pad;
      saveLocalPads();
      applyPad();
    }
  } catch {
    // Offline or blocked — the local copy already on screen stands.
  }
}

function startPadLiveSync(file) {
  if (padUnsub) { padUnsub(); padUnsub = null; }
  padUnsub = db.collection('mha-dnd').doc(padDocId(file)).onSnapshot(snap => {
    // Same trap the board and session log hit: when Firestore's streaming
    // channel is blocked (Safari tracking protection, content blockers,
    // proxies) writes keep landing while the listener replays this tab's own
    // stale cache — which would undo the change that was just saved.
    if (snap.metadata && snap.metadata.fromCache) return;
    if (!snap.exists || file !== activeFile) return;
    // Don't let a snapshot land on top of an edit that hasn't been written
    // yet: between a swatch click and the debounced push, the server copy is
    // deliberately older than what's on screen.
    if (_padSaveInFlight || _padSaveTimer) return;
    const remote = snap.data().pad;
    if (!remote || JSON.stringify(remote) === JSON.stringify(pad)) return;
    pad = Object.assign(defaultPad(), remote);
    pads[file] = pad;
    saveLocalPads();
    applyPad();
    if (openAppId === 'customise') $('pad-app-body').innerHTML = renderCustomiseApp();
  }, err => console.error('[heropad] live sync stopped:', err));
}

function setSyncNote(text) {
  $('pad-sync-note').textContent = text;
}

/* ══ Owner selection ════════════════════════════════════════════════ */

function renderOwnerOptions() {
  const pcs = ROSTER.filter(s => s.is_pc);
  const rest = ROSTER.filter(s => !s.is_pc);
  const opt = s => `<option value="${escHtml(s.file)}"${s.file === activeFile ? ' selected' : ''}>${escHtml(s.name)}</option>`;
  $('pad-owner').innerHTML =
    (pcs.length ? `<optgroup label="Player characters">${pcs.map(opt).join('')}</optgroup>` : '') +
    (rest.length ? `<optgroup label="Class 1-A">${rest.map(opt).join('')}</optgroup>` : '');
}

function onOwnerChange(file) {
  activeFile = file;
  try { localStorage.setItem(LS_ACTIVE, file); } catch {}
  closeApp();
  renderOwnerLine();
  loadPad(file);
  startPadLiveSync(file);
}

// Whose pad to open on arrival: the character this account can edit (so a
// player lands on their own pad without touching the picker), else whatever
// this device looked at last, else the first player character.
//
// The canEdit() path deliberately skips admins. canEdit returns true for an
// admin on every id (auth.js:45), so for the DM it would resolve to "the
// first student in the roster" every single time and quietly override the
// pad they were actually last looking at.
function pickDefaultOwner() {
  const remembered = (() => { try { return localStorage.getItem(LS_ACTIVE); } catch { return null; } })();
  const isDm = !!(window.isAdmin && window.isAdmin());
  const mine = (!isDm && window.canEdit) ? ROSTER.find(s => window.canEdit(s.id)) : null;
  if (mine) return mine.file;
  if (remembered && ROSTER.some(s => s.file === remembered)) return remembered;
  const firstPc = ROSTER.find(s => s.is_pc);
  return firstPc ? firstPc.file : (ROSTER[0] ? ROSTER[0].file : null);
}

/* ══ Boot ═══════════════════════════════════════════════════════════ */

// Write access to mha-dnd docs is admin-or-editor (firestore.rules:38). Anyone
// else — signed out, or still 'pending' — gets a fully working pad that simply
// lives in this browser.
document.addEventListener('auth-state-changed', e => {
  const was = canSync;
  canSync = e.detail.role === 'admin' || e.detail.role === 'editor';

  // The ranking chart is the DM's alone (firestore.rules), so the editing
  // controls appear for admins and nobody else. Re-render if the app is
  // already open, since sign-in can land after it was opened.
  const wasRank = canRank;
  canRank = e.detail.role === 'admin';
  if (wasRank !== canRank) rerenderRankingIfOpen();

  if (!canSync) {
    setSyncNote(e.detail.user
      ? 'Saved on this device. Ask the DM for edit access to sync your pad everywhere.'
      : 'Saved on this device. Sign in to carry your pad between devices.');
  } else if (!was) {
    setSyncNote('Signed in — your pad syncs.');
  }
});

(async () => {
  loadLocalPads();
  renderClock();
  setInterval(renderClock, 20000);

  try {
    const res = await fetch('CLASS-1A/roster.json', { cache: 'no-cache' });
    const data = await res.json();
    ROSTER = Array.isArray(data.students) ? data.students : [];
  } catch {
    ROSTER = [];
    setSyncNote('The class roster could not be loaded.');
  }

  renderHome();

  await fbAuthReady;
  activeFile = pickDefaultOwner();
  if (!activeFile) {
    setSyncNote('No characters found in the roster.');
    return;
  }
  renderOwnerOptions();
  renderOwnerLine();
  await loadPad(activeFile);
  startPadLiveSync(activeFile);

  // Class-wide, not per-pad, so it is loaded once and stays subscribed for
  // the life of the page rather than being re-fetched on every owner switch.
  await loadRanking();
  startRankLiveSync();
})();
