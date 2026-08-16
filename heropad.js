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
// `anim` names a keyframe class in heropad.css (pad-anim-<name>). Motion is
// disabled wholesale by base.css under prefers-reduced-motion, so an animated
// wallpaper degrades to its first frame rather than needing a second variant.
const WALLPAPERS = [
  { id: 'aurora', name: 'Aurora', anim: 'aurora',
    css: 'radial-gradient(60% 45% at 20% 20%, rgba(18,210,150,.55), transparent 60%), radial-gradient(55% 45% at 80% 30%, rgba(47,107,255,.55), transparent 60%), radial-gradient(60% 50% at 50% 90%, rgba(168,85,247,.5), transparent 62%), linear-gradient(180deg, #0A1020 0%, #06070E 100%)' },
  { id: 'ember', name: 'Ember', anim: 'ember',
    css: 'radial-gradient(70% 50% at 50% 108%, rgba(255,46,77,.6), transparent 62%), radial-gradient(50% 40% at 30% 90%, rgba(255,160,35,.45), transparent 60%), linear-gradient(180deg, #140609 0%, #08070A 100%)' },
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
  { id: 'scanline', name: 'Scanline', anim: 'scan',
    css: 'repeating-linear-gradient(0deg, rgba(18,210,150,.10) 0 2px, transparent 2px 5px), radial-gradient(80% 60% at 50% 40%, rgba(18,210,150,.22), transparent 70%), linear-gradient(180deg, #061410 0%, #05080A 100%)' },
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

// Yen per £1, used by the Exchange app. A static site has no way to know
// today's rate, so this is a starting figure the player edits rather than a
// number pretending to be live — see the note on that app. Stored on the pad
// so an edit syncs with everything else; RATE_SET_ON is what the app shows
// so nobody mistakes a stale default for a current rate.
const DEFAULT_GBP_RATE = 190;
const RATE_SET_ON = 'August 2026';

function defaultPad() {
  return {
    wallpaper: { type: 'preset', id: 'aurora' },
    accent: '#FFC220',
    carrier: 'U.A. NET',
    notes: '',
    gbpRate: DEFAULT_GBP_RATE,
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

// Same shape as the generators in shop.js and admin.js. Ids only ever need to
// be unique within a document, and the timestamp prefix keeps them sortable
// by eye when reading raw Firestore data.
function genId(prefix) {
  return prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

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
    id: 'bank',
    name: 'Bank',
    icon: '🏦',
    accent: '#12D296',
    render: renderBankApp,
    // Money that moved in the last day. Null once it goes quiet, so the
    // badge means "something happened" rather than "this app exists".
    onOpen: markBankRead,
    badge: () => {
      const n = unreadBankCount();
      return n ? (n > 99 ? '99+' : n) : null;
    },
  },
  {
    id: 'quirks',
    name: 'Quirks',
    icon: '📖',
    accent: '#A855F7',
    render: renderQuirksApp,
    onOpen: loadQuirks,
  },
  {
    id: 'masaranking',
    name: 'Masaranking',
    icon: '🧲',
    accent: '#FF2E4D',
    render: renderMasarankingApp,
    badge: () => {
      if (!ranking) return null;
      const i = ranking.findIndex(r => r.file === activeFile);
      return i >= 0 ? '#' + (i + 1) : null;
    },
  },
  {
    id: 'notes',
    name: 'Notes',
    icon: '📝',
    accent: '#FFC220',
    render: renderNotesApp,
    onOpen: focusNotes,
  },
  {
    id: 'exchange',
    name: 'Exchange',
    icon: '💱',
    accent: '#3DDC64',
    render: renderExchangeApp,
  },
  {
    id: 'dice',
    name: 'Dice',
    icon: '🎲',
    accent: '#F2F5FA',
    render: renderDiceApp,
  },
  {
    id: 'eats',
    name: 'Eats',
    icon: '🍜',
    accent: '#FF6B35',
    render: renderEatsApp,
  },
  {
    id: 'board',
    name: 'Board',
    icon: '🖍',
    accent: '#12D296',
    render: renderBoardApp,
    onOpen: mountBoard,
  },
  {
    id: 'tally',
    name: 'Tally',
    icon: '🧮',
    accent: '#A855F7',
    render: renderTallyApp,
  },
  {
    // Was Contacts, now the class list doubles as the messaging app: tap a
    // classmate to open the thread with them.
    id: 'messages',
    name: 'Messages',
    icon: '💬',
    accent: '#2F6BFF',
    render: renderMessagesApp,
    badge: () => {
      const n = unreadMessageCount();
      return n || null;
    },
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

  // Animation classes are cleared first: a preset swap must not leave the
  // previous wallpaper's keyframes running under the new one.
  wall.className = '';

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
    if (preset.anim) wall.className = 'pad-anim-' + preset.anim;
  }

  device.style.setProperty('--pad-accent', pad.accent || '#FFC220');
  $('pad-carrier').textContent = pad.carrier || 'U.A. NET';
}

function renderClock() {
  const now = new Date();
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  $('pad-clock').textContent = time;
  $('pad-day').textContent = now.toLocaleDateString([], { weekday: 'long' });
  $('pad-date').textContent = now.toLocaleDateString([], { day: 'numeric', month: 'long' });
  // Only the time is refreshed while locked — rebuilding the whole lock
  // screen every 20 seconds would make the notification stack flicker.
  if (locked) $('lock-time').textContent = time;
}

function renderOwnerLine() {
  const s = ownerStudent();
  $('pad-owner-line').innerHTML = s
    ? escHtml(s.name) + '<span class="pad-owner-quirk">' + escHtml(s.quirk || '') + '</span>'
    : 'No pad selected';
}

/* ── Badges ─────────────────────────────────────────────────────────
   A number on an icon is the cheapest way to make a home screen feel
   live, and the only honest source for one is data the pad already has.
   An app whose badge() returns null (or that has none) shows nothing —
   a permanent badge is just decoration that trains you to ignore badges.
   ─────────────────────────────────────────────────────────────────── */
function appBadge(app) {
  if (!app.badge) return null;
  try { return app.badge(); } catch { return null; }
}

function iconHtml(app) {
  const badge = appBadge(app);
  return `<button type="button" role="listitem" class="pad-app-btn" onclick="openApp('${app.id}')"
            aria-label="Open ${escHtml(app.name)}${badge ? ', ' + escHtml(String(badge)) + ' new' : ''}">
            <span class="pad-app-ico" style="--ico:${escHtml(app.accent)}">${escHtml(app.icon)}${
              badge ? `<i class="pad-badge">${escHtml(String(badge))}</i>` : ''}</span>
            <span class="pad-app-name">${escHtml(app.name)}</span>
          </button>`;
}

function renderHome() {
  const docked = new Set(DOCK);
  $('pad-grid').innerHTML = APPS.filter(a => !docked.has(a.id)).map(iconHtml).join('');
  $('pad-dock').innerHTML = DOCK.map(id => appById(id)).filter(Boolean).map(iconHtml).join('');
  renderWidget();
}

// The home-screen balance widget. Hidden rather than shown empty when the
// character has no purse in the shared bundle — a widget reading "—" is
// worse than no widget.
function renderWidget() {
  const el = $('pad-widget');
  const purse = ownerPurse();
  if (!purse) { el.hidden = true; return; }
  el.hidden = false;
  $('widget-balance').textContent = yenStr(walletTotalYen(purse));
  const recent = ownerEntries()[0];
  $('widget-sub').textContent = recent
    ? `Last: ${recent.label}`
    : 'No transactions yet';
}

/* ── Lock screen ────────────────────────────────────────────────────
   The pad opens locked, so picking it up feels like picking up a phone
   rather than loading a web page. One tap anywhere unlocks it.

   Notifications are derived, never stored: the most recent money
   movements and the owner's current place on the fridge chart. Both come
   from documents the pad is already subscribed to, so the lock screen
   costs no extra reads and updates itself.
   ─────────────────────────────────────────────────────────────────── */
let locked = false;

function lockNotifications() {
  const out = [];
  const since = bankLastReadAt();
  for (const e of ownerEntries().filter(e => (e.ts || 0) > since).slice(0, 2)) {
    out.push({
      icon: BANK_ICONS[e.kind] || '•',
      app: 'Bank',
      title: e.label || e.kind,
      meta: e.yen ? (e.yen > 0 ? '+' : '−') + yenStr(Math.abs(e.yen)) : '',
      ts: e.ts,
    });
  }
  if (ranking) {
    const i = ranking.findIndex(r => r.file === activeFile);
    if (i >= 0) {
      out.push({
        icon: '🧲', app: 'Masaranking',
        title: `You are #${i + 1} on the fridge`,
        meta: ranking[i].note || '',
        ts: null,
      });
    }
  }
  return out.slice(0, 3);
}

function renderLock() {
  const now = new Date();
  $('lock-time').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  $('lock-date').textContent = now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  const s = ownerStudent();
  $('lock-owner').textContent = s ? s.name : '';

  const notifs = lockNotifications();
  $('lock-notifs').innerHTML = notifs.map(n => `
    <div class="lock-notif">
      <span class="lock-notif-ico">${escHtml(n.icon)}</span>
      <span class="lock-notif-body">
        <span class="lock-notif-app">${escHtml(n.app)}${
          n.ts ? ' · ' + new Date(n.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span>
        <span class="lock-notif-title">${escHtml(n.title)}</span>
      </span>
      ${n.meta ? `<span class="lock-notif-meta">${escHtml(n.meta)}</span>` : ''}
    </div>`).join('');
}

function lockPad() {
  closeApp();
  locked = true;
  renderLock();
  const el = $('pad-lock');
  el.hidden = false;
  $('pad-device').classList.add('locked');
  requestAnimationFrame(() => el.classList.add('open'));
}

function unlockPad() {
  if (!locked) return;
  locked = false;
  const el = $('pad-lock');
  el.classList.remove('open');
  $('pad-device').classList.remove('locked');
  // Repaint the home screen on the way out: badges and the widget may have
  // moved while the pad sat locked.
  renderHome();
  setTimeout(() => { if (!locked) el.hidden = true; }, 320);
}

document.addEventListener('keydown', e => {
  if (locked && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); unlockPad(); }
});

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
  // The rank badge on the home screen and the lock screen's "you are #N"
  // notification both move when the chart does, whether or not it is open.
  if (locked) renderLock(); else if (!openAppId) renderHome();
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

/* ══ App: Bank ══════════════════════════════════════════════════════
   The statement behind the shop. Two shared documents feed it:

     mha-dnd/relationships-bundle  the purse itself (the same document the
                                   shop spends from and the toolkit's
                                   Inventory tab renders)
     mha-dnd/ledger                what moved, and why

   The ledger is append-only and written by shop.js (purchases) and
   admin.js (DM grants), each inside the same Firestore transaction that
   moves the money — so a line on this statement cannot exist without the
   matching change to the purse, or vice versa. The ENTRY SHAPE is
   documented at the top of shop.js; verify-ledger.js fails if the three
   files drift apart.

   Read-only by design. A bank app that let you edit your own balance
   would not be a bank app.
   ═══════════════════════════════════════════════════════════════════ */
const FS_LEDGER_DOC = db.collection('mha-dnd').doc('ledger');
const FS_BUNDLE_DOC = db.collection('mha-dnd').doc('relationships-bundle');
// Inventories live apart from the bundle now, in a collection no client may
// write — see firestore.rules and functions/index.js.
const FS_INVENTORIES = db.collection('inventories');
let inventories = {};

// Kept in step with shop.js and CLASS-1A/relationships.js — a drifted key
// would show a denomination the rest of the site never fills in.
const CURRENCY_KEYS = ['yen', 'pp', 'gp', 'ep', 'sp', 'cp'];
const CURRENCY_TO_YEN = { yen: 1, cp: 10, sp: 100, ep: 500, gp: 1000, pp: 10000 };
const CURRENCY_SHORT = { yen: '¥', pp: 'pp', gp: 'gp', ep: 'ep', sp: 'sp', cp: 'cp' };

// The ledger's ENTRY SHAPE is documented in full at the top of shop.js and
// must stay identical in all three files that touch it; verify-ledger.js
// fails if they drift. These two are the writer half, used by the Eats app —
// the Bank itself only ever reads.



/* ── What counts as unread ──────────────────────────────────────────
   The badge used to count anything from the last 24 hours, which meant
   opening the Bank did nothing to it — the number sat there until the
   transactions aged out on their own. A notification you cannot dismiss
   by reading it trains people to ignore the badge.

   Read state is per-device, like the one Messages keeps: a "seen at"
   timestamp shared between all twenty students would mean the DM opening
   the Bank cleared everyone's.

   First visit stores "now" rather than 0, so a player who has never
   opened the app is not greeted by a badge counting the entire campaign's
   ledger. ─────────────────────────────────────────────────────────── */
function bankReadKey() { return 'mha-heropad-bankread-' + activeFile; }

function bankLastReadAt() {
  try {
    const stored = Number(localStorage.getItem(bankReadKey()));
    if (stored) return stored;
    const now = Date.now();
    localStorage.setItem(bankReadKey(), String(now));
    return now;
  } catch { return Date.now(); }
}

function markBankRead() {
  try { localStorage.setItem(bankReadKey(), String(Date.now())); } catch {}
  // The badge and the lock screen both read this, so repaint whichever is
  // on screen — otherwise the number lingers until something else moves.
  if (locked) renderLock(); else renderHome();
}

function unreadBankCount() {
  if (!ledger || !activeFile) return 0;
  const since = bankLastReadAt();
  return ownerEntries().filter(e => (e.ts || 0) > since).length;
}

let ledger = null;        // [{...}] once loaded, null while fetching
let bundle = null;        // the shared character bundle, for the balance
let bankFilter = 'all';   // all | in | out

function yenStr(n) { return '¥' + Number(n || 0).toLocaleString(); }

function walletTotalYen(currency) {
  return CURRENCY_KEYS.reduce((sum, k) => sum + (currency?.[k] || 0) * CURRENCY_TO_YEN[k], 0);
}

function ownerPurse() {
  const own = inventories[activeFile];
  if (own && own.currency) return own.currency;
  // Falls back to the bundle for anyone the migration has not moved yet.
  const character = bundle && bundle.characters && bundle.characters[activeFile];
  return (character && character.inventory && character.inventory.currency) || null;
}

function ownerEntries() {
  if (!ledger) return [];
  // Newest first — a statement is read from the top.
  return ledger.filter(e => e && e.file === activeFile).slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

function entryMatchesFilter(entry) {
  if (bankFilter === 'all') return true;
  // "In" and "out" are about money. A granted medkit is neither, so it shows
  // only under All rather than being silently filed as income.
  if (!entry.yen) return false;
  return bankFilter === 'in' ? entry.yen > 0 : entry.yen < 0;
}

function setBankFilter(next) {
  bankFilter = next;
  if (openAppId === 'bank') $('pad-app-body').innerHTML = renderBankApp();
}

function bankDayLabel(ts) {
  const d = new Date(ts || 0);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(d, today)) return 'Today';
  if (sameDay(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'long' });
}

const BANK_ICONS = {
  purchase: '🛒', currency: '💴', item: '📦', parts: '⚙', points: '⭐', pool: '🔋',
};

function renderBankApp() {
  const purse = ownerPurse();
  const all = ownerEntries();
  const shown = all.filter(entryMatchesFilter);

  const breakdown = purse
    ? CURRENCY_KEYS.filter(k => purse[k]).map(k =>
        `<span class="bk-coin">${purse[k].toLocaleString()}<em>${CURRENCY_SHORT[k]}</em></span>`).join('')
    : '';

  // Only money counts toward the totals; item and points entries carry yen 0.
  const moneyIn = all.reduce((s, e) => s + (e.yen > 0 ? e.yen : 0), 0);
  const moneyOut = all.reduce((s, e) => s + (e.yen < 0 ? -e.yen : 0), 0);

  const balanceCard = `
    <section class="bk-balance">
      <div class="bk-balance-label">Balance</div>
      <div class="bk-balance-value">${purse ? yenStr(walletTotalYen(purse)) : '—'}</div>
      <div class="bk-coins">${breakdown || '<span class="bk-coin-empty">Empty purse</span>'}</div>
      <div class="bk-flow">
        <span class="bk-flow-in">▲ ${yenStr(moneyIn)} in</span>
        <span class="bk-flow-out">▼ ${yenStr(moneyOut)} out</span>
      </div>
    </section>`;

  if (!purse && !all.length) {
    return balanceCard + `<p class="bk-empty">This character has no sheet in the shared bundle yet.
      Open the Class 1-A toolkit and save once, and the account opens.</p>`;
  }

  const tabs = [['all', 'All'], ['in', 'In'], ['out', 'Out']].map(([id, label]) =>
    `<button type="button" class="bk-tab${bankFilter === id ? ' sel' : ''}"
             onclick="setBankFilter('${id}')">${label}</button>`).join('');

  let rows = '';
  if (!shown.length) {
    rows = all.length
      ? '<p class="bk-empty">Nothing under this filter.</p>'
      : `<p class="bk-empty">No transactions yet. Anything bought in the Shop —
         or granted by the DM — lands here from now on.</p>`;
  } else {
    let lastDay = null;
    for (const e of shown) {
      const day = bankDayLabel(e.ts);
      if (day !== lastDay) { rows += `<div class="bk-day">${escHtml(day)}</div>`; lastDay = day; }
      const isMoney = !!e.yen;
      const sign = e.yen > 0 || (!isMoney && e.amount > 0) ? 'pos' : e.yen < 0 ? 'neg' : '';
      const figure = isMoney
        ? (e.yen > 0 ? '+' : '−') + yenStr(Math.abs(e.yen))
        : (e.amount > 0 ? '+' : '') + e.amount;
      // A grant made in platinum is worth ¥20,000, but "2pp" is what actually
      // changed hands — show both rather than silently converting it away.
      const native = isMoney && e.unit && e.unit !== 'yen'
        ? ` · ${Math.abs(e.amount)}${CURRENCY_SHORT[e.unit] || e.unit}`
        : '';
      rows += `<div class="bk-row">
        <span class="bk-ico">${BANK_ICONS[e.kind] || '•'}</span>
        <span class="bk-body">
          <span class="bk-label">${escHtml(e.label || e.kind)}</span>
          <span class="bk-time">${new Date(e.ts || 0).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${escHtml(native)}</span>
        </span>
        <span class="bk-amount ${sign}">${escHtml(figure)}</span>
      </div>`;
    }
  }

  return balanceCard + `<div class="bk-tabs">${tabs}</div><div class="bk-list">${rows}</div>`;
}

// A ledger or purse change moves three things at once: the open statement,
// the home screen's badge and widget, and the lock screen's notifications.
function rerenderBankIfOpen() {
  if (openAppId === 'bank') $('pad-app-body').innerHTML = renderBankApp();
  if (locked) renderLock(); else renderHome();
}

async function loadBank() {
  try {
    await fbAuthReady;
    const [ledgerSnap, bundleSnap, invSnap] = await Promise.all([
      FS_LEDGER_DOC.get(), FS_BUNDLE_DOC.get(), FS_INVENTORIES.get(),
    ]);
    ledger = ledgerSnap.exists && Array.isArray(ledgerSnap.data().entries) ? ledgerSnap.data().entries : [];
    bundle = bundleSnap.exists ? bundleSnap.data() : null;
    const next = {};
    invSnap.forEach(doc => { next[doc.id] = doc.data(); });
    inventories = next;
  } catch {
    // Offline or blocked — an empty statement is better than a stuck spinner.
    ledger = ledger || [];
  }
  rerenderBankIfOpen();
}

function startBankLiveSync() {
  // Nothing on this page writes either document, so unlike the pads and the
  // ranking chart there is no in-flight local edit for a snapshot to trample
  // — every update can be applied as it arrives. Cached replays are still
  // skipped: they are this tab's own stale copy, not news.
  FS_LEDGER_DOC.onSnapshot(snap => {
    if (!snap.exists || (snap.metadata && snap.metadata.fromCache)) return;
    ledger = Array.isArray(snap.data().entries) ? snap.data().entries : [];
    rerenderBankIfOpen();
  }, err => console.error('[heropad] ledger sync stopped:', err));

  FS_BUNDLE_DOC.onSnapshot(snap => {
    if (!snap.exists || (snap.metadata && snap.metadata.fromCache)) return;
    bundle = snap.data();
    rerenderBankIfOpen();
  }, err => console.error('[heropad] purse sync stopped:', err));

  // The purse itself. A spend lands here rather than in the bundle now, so
  // this is what keeps the Bank, the widget and the Eats prices honest.
  FS_INVENTORIES.onSnapshot(snap => {
    if (snap.metadata && snap.metadata.fromCache) return;
    const next = {};
    snap.forEach(doc => { next[doc.id] = doc.data(); });
    inventories = next;
    rerenderBankIfOpen();
    if (openAppId === 'eats') $('pad-app-body').innerHTML = renderEatsApp();
  }, err => console.error('[heropad] inventory sync stopped:', err));
}

/* ══ App: Quirks ════════════════════════════════════════════════════
   The class's quirks, searchable. Everything here is already on disk in
   the per-character files — quirk type, rarity, save DC, the compendium
   source and the weakness — but the only way to read it was to open the
   toolkit and click through twenty classmates one at a time.

   dm_notes is deliberately never touched. The character files carry it,
   and this is a player-facing app.
   ═══════════════════════════════════════════════════════════════════ */
let quirks = null;         // [{name, quirk, ...}] once loaded
// The in-flight fetch, not a boolean. A second caller has to be able to await
// the first one's work: opening the app fires this via onOpen, and anything
// else that wants the data would otherwise get an immediate return and find
// `quirks` still null.
let quirksPromise = null;
let quirkQuery = '';
let openQuirk = null;

function loadQuirks() {
  if (quirks) return Promise.resolve();
  if (quirksPromise) return quirksPromise;
  quirksPromise = (async () => {
    try {
      const loaded = await Promise.all(ROSTER.map(s =>
        fetch('CLASS-1A/' + s.file).then(r => r.json())
          .then(c => ({
            file: s.file,
            name: c.name || s.name,
            quirk: c.quirk || s.quirk || '',
            type: c.quirk_type || '',
            rarity: c.quirk_rarity || '',
            saveDC: c.quirk_save_DC || null,
            ability: c.quirk_ability || '',
            summary: (c.quirk_mechanics && c.quirk_mechanics.source) || '',
            weakness: (c.quirk_mechanics && c.quirk_mechanics.weakness) || '',
            physiology: c.physiology || s.physiology || '',
          }))
          .catch(() => null)
      ));
      quirks = loaded.filter(Boolean);
    } catch {
      quirks = [];
    }
    if (openAppId === 'quirks') $('pad-app-body').innerHTML = renderQuirksApp();
  })();
  return quirksPromise;
}

function setQuirkQuery(v) {
  quirkQuery = v.toLowerCase();
  // Only the list is replaced — re-rendering the whole app would drop the
  // caret out of the search box on every keystroke.
  const list = $('qk-list');
  if (list) list.innerHTML = quirkListHtml();
}

function toggleQuirk(file) {
  openQuirk = openQuirk === file ? null : file;
  const list = $('qk-list');
  if (list) list.innerHTML = quirkListHtml();
}

function quirkListHtml() {
  if (!quirks) return '<p class="bk-empty">Reading the class files…</p>';
  const q = quirkQuery.trim();
  const hits = quirks.filter(k => !q ||
    (k.name + ' ' + k.quirk + ' ' + k.type + ' ' + k.rarity + ' ' + k.summary).toLowerCase().includes(q));
  if (!hits.length) return '<p class="bk-empty">Nothing matches that.</p>';

  return hits.map(k => {
    const open = openQuirk === k.file;
    const chips = [k.type, k.rarity, k.physiology].filter(Boolean)
      .map(c => `<span class="qk-chip">${escHtml(c)}</span>`).join('');
    return `<div class="qk-card${open ? ' open' : ''}">
      <button type="button" class="qk-head" onclick="toggleQuirk('${escHtml(k.file)}')"
              aria-expanded="${open}">
        <span class="qk-head-body">
          <span class="qk-quirk">${escHtml(k.quirk)}</span>
          <span class="qk-who">${escHtml(k.name)}</span>
        </span>
        <span class="qk-caret">${open ? '▾' : '▸'}</span>
      </button>
      ${open ? `<div class="qk-detail">
        <div class="qk-chips">${chips}</div>
        ${k.saveDC ? `<div class="qk-stat"><span>Save DC</span><strong>${escHtml(String(k.saveDC))}</strong></div>` : ''}
        ${k.ability ? `<div class="qk-stat"><span>Ability</span><strong>${escHtml(k.ability)}</strong></div>` : ''}
        ${k.summary ? `<p class="qk-text">${escHtml(k.summary)}</p>` : ''}
        ${k.weakness ? `<p class="qk-weak"><em>Weakness</em> ${escHtml(k.weakness)}</p>` : ''}
      </div>` : ''}
    </div>`;
  }).join('');
}

function renderQuirksApp() {
  return `
    <input type="search" id="qk-search" class="cz-input qk-search" placeholder="Search quirks, types, names…"
           value="${escHtml(quirkQuery)}" oninput="setQuirkQuery(this.value)" aria-label="Search quirks">
    <div id="qk-list">${quirkListHtml()}</div>`;
}

/* ══ App: Notes ═════════════════════════════════════════════════════
   A private notepad per character, stored in that character's pad
   document — so it syncs with everything else on the pad and needs no
   new plumbing. Signed-out players still get one; it just stays on the
   device, same as their wallpaper.
   ═══════════════════════════════════════════════════════════════════ */
function renderNotesApp() {
  return `
    <p class="cz-lead">Leads, suspicions, who owes you money. Saves as you type.</p>
    <textarea id="nt-body" class="nt-body" placeholder="Write anything…"
              oninput="setNotes(this.value)" aria-label="Your notes">${escHtml(pad.notes || '')}</textarea>
    <div class="nt-foot" id="nt-foot"></div>`;
}

function focusNotes() {
  const el = $('nt-body');
  if (el && el.focus) el.focus();
}

function setNotes(value) {
  pad.notes = value;
  schedulePadSave();
  const foot = $('nt-foot');
  if (foot) {
    const words = value.trim() ? value.trim().split(/\s+/).length : 0;
    foot.textContent = words ? `${words} word${words === 1 ? '' : 's'} · saved` : '';
  }
}

/* ══ App: Exchange ══════════════════════════════════════════════════
   Yen to pounds, for when a handbook price needs translating into money
   that means something.

   ── On the rate ──────────────────────────────────────────────────
   This is a static site with no backend, so there is no honest way for
   it to know today's rate. Rather than hardcode a number and let it
   quietly rot into a lie, the rate is a visible, editable field: it
   starts at DEFAULT_GBP_RATE, shows the month that default was written,
   and whatever the player types is stored on their pad and syncs like
   any other setting. A wrong rate is then obviously a wrong rate, and
   one tap from being right.

   Live rates would mean a third-party API call on every open — a new
   network dependency, a new failure mode, and a real-world request from
   a page about a fictional school. Not worth it for a converter.
   ═══════════════════════════════════════════════════════════════════ */
let fxAmount = 1000;    // in whichever currency is currently the source
let fxFromYen = true;   // false converts the other way, pounds to yen

function fxRate() {
  const r = Number(pad.gbpRate);
  return r > 0 ? r : DEFAULT_GBP_RATE;
}

function gbpStr(n) {
  return Number(n || 0).toLocaleString(undefined, {
    style: 'currency', currency: 'GBP', maximumFractionDigits: 2,
  });
}

function fxConvert(amount) {
  const n = Number(amount) || 0;
  return fxFromYen ? n / fxRate() : n * fxRate();
}

function fxResultStr() {
  const out = fxConvert(fxAmount);
  return fxFromYen ? gbpStr(out) : yenStr(Math.round(out));
}

// Handbook prices worth having a feel for, rather than round numbers for
// their own sake — a cheap meal up to a serious piece of support gear.
const FX_QUICK = [500, 2000, 5000, 20000, 100000];

function fxQuickHtml() {
  return FX_QUICK.map(v => `
    <button type="button" class="fx-quick" onclick="setFxAmount(${v}, true)">
      <span>${yenStr(v)}</span>
      <em>${escHtml(gbpStr(v / fxRate()))}</em>
    </button>`).join('');
}

function renderExchangeApp() {
  const purse = ownerPurse();
  const purseYen = purse ? walletTotalYen(purse) : null;

  return `
    <div class="fx-dir">
      <button type="button" class="fx-dir-btn${fxFromYen ? ' sel' : ''}" onclick="setFxDir(true)">¥ → £</button>
      <button type="button" class="fx-dir-btn${!fxFromYen ? ' sel' : ''}" onclick="setFxDir(false)">£ → ¥</button>
    </div>

    <label class="fx-field">
      <span class="fx-field-label">${fxFromYen ? 'Yen' : 'Pounds'}</span>
      <input type="number" id="fx-amount" class="fx-input" inputmode="decimal" min="0"
             value="${escHtml(String(fxAmount))}" oninput="setFxAmount(this.value)"
             aria-label="Amount to convert">
    </label>

    <div class="fx-result" id="fx-result">${escHtml(fxResultStr())}</div>

    <div class="fx-rate">
      <span class="fx-rate-label">Rate</span>
      <span class="fx-rate-body">
        <input type="number" id="fx-rate-input" class="fx-rate-input" min="1" step="0.01"
               value="${escHtml(String(fxRate()))}" oninput="setFxRate(this.value)"
               aria-label="Yen per pound">
        <span class="fx-rate-unit">yen to £1</span>
      </span>
    </div>
    <p class="fx-note">Set from a rate current in ${escHtml(RATE_SET_ON)}. Edit it and it saves to your pad —
      this page can't look up a live rate on its own.</p>

    ${purseYen !== null ? `<div class="fx-purse">
      <span class="fx-purse-label">Your balance</span>
      <span class="fx-purse-yen">${yenStr(purseYen)}</span>
      <span class="fx-purse-gbp">${escHtml(gbpStr(purseYen / fxRate()))}</span>
    </div>` : ''}

    <p class="dc-history-label">Common prices</p>
    <div class="fx-quicks" id="fx-quicks">${fxQuickHtml()}</div>`;
}

// Only the result and the quick table are repainted, never the whole app:
// re-rendering would drop the caret out of whichever field is being typed in.
function fxRepaint() {
  const res = $('fx-result');
  if (res) res.textContent = fxResultStr();
  const quicks = $('fx-quicks');
  if (quicks) quicks.innerHTML = fxQuickHtml();
}

function setFxAmount(value, full) {
  fxAmount = Math.max(0, Number(value) || 0);
  if (full) { $('pad-app-body').innerHTML = renderExchangeApp(); return; }
  fxRepaint();
}

function setFxDir(fromYen) {
  // Carry the converted figure across, so flipping the direction reads as
  // "and back again" rather than resetting to an unrelated number.
  fxAmount = Math.round(fxConvert(fxAmount) * 100) / 100;
  fxFromYen = fromYen;
  $('pad-app-body').innerHTML = renderExchangeApp();
}

function setFxRate(value) {
  const n = Number(value);
  pad.gbpRate = n > 0 ? n : DEFAULT_GBP_RATE;
  schedulePadSave();
  fxRepaint();
}

/* ══ App: Dice ══════════════════════════════════════════════════════
   A roller on the phone, because the phone is what is already in their
   hand. Deliberately its own thing rather than a link to the toolkit's
   roller: history is per-session and lives nowhere.
   ═══════════════════════════════════════════════════════════════════ */
const DICE_FACES = [4, 6, 8, 10, 12, 20, 100];
let diceSides = 20;
let diceCount = 1;
let diceMod = 0;
let diceHistory = [];
let diceLast = null;

function renderDiceApp() {
  const faces = DICE_FACES.map(n =>
    `<button type="button" class="dc-die${n === diceSides ? ' sel' : ''}"
             onclick="setDie(${n})">d${n}</button>`).join('');

  const result = diceLast
    ? `<div class="dc-result">
         <div class="dc-total">${diceLast.total}</div>
         <div class="dc-breakdown">${escHtml(diceLast.detail)}</div>
       </div>`
    : '<div class="dc-result empty">Pick a die and roll</div>';

  return `
    <div class="dc-dice">${faces}</div>
    <div class="dc-controls">
      <div class="dc-step">
        <span class="dc-step-label">Dice</span>
        <button type="button" onclick="adjustDice(-1)" aria-label="One fewer die">−</button>
        <span class="dc-step-val" id="dc-count">${diceCount}</span>
        <button type="button" onclick="adjustDice(1)" aria-label="One more die">+</button>
      </div>
      <div class="dc-step">
        <span class="dc-step-label">Modifier</span>
        <button type="button" onclick="adjustMod(-1)" aria-label="Lower the modifier">−</button>
        <span class="dc-step-val" id="dc-mod">${diceMod >= 0 ? '+' : ''}${diceMod}</span>
        <button type="button" onclick="adjustMod(1)" aria-label="Raise the modifier">+</button>
      </div>
    </div>
    <button type="button" class="dc-roll" onclick="rollDice()">Roll ${diceCount}d${diceSides}${
      diceMod ? (diceMod > 0 ? '+' : '') + diceMod : ''}</button>
    ${result}
    ${diceHistory.length ? `<p class="dc-history-label">Recent</p>
      <div class="dc-history">${diceHistory.map(h =>
        `<span class="dc-chip"><em>${escHtml(h.label)}</em>${h.total}</span>`).join('')}</div>` : ''}`;
}

function setDie(n) { diceSides = n; $('pad-app-body').innerHTML = renderDiceApp(); }
function adjustDice(d) { diceCount = Math.min(12, Math.max(1, diceCount + d)); $('pad-app-body').innerHTML = renderDiceApp(); }
function adjustMod(d) { diceMod = Math.min(50, Math.max(-50, diceMod + d)); $('pad-app-body').innerHTML = renderDiceApp(); }

function rollDice() {
  const rolls = [];
  for (let i = 0; i < diceCount; i++) rolls.push(1 + Math.floor(Math.random() * diceSides));
  const sum = rolls.reduce((a, b) => a + b, 0);
  const label = `${diceCount}d${diceSides}${diceMod ? (diceMod > 0 ? '+' : '') + diceMod : ''}`;
  diceLast = {
    total: sum + diceMod,
    detail: rolls.join(' + ') + (diceMod ? ` ${diceMod > 0 ? '+' : '−'} ${Math.abs(diceMod)}` : ''),
  };
  diceHistory = [{ label, total: sum + diceMod }].concat(diceHistory).slice(0, 8);
  $('pad-app-body').innerHTML = renderDiceApp();
}

/* ══ App: Messages ══════════════════════════════════════════════════
   The class list, and a thread with each of them. Tap a classmate to
   open the conversation; messages are sent as whoever the pad belongs to.

   ⚠ NOT PRIVATE, and the app says so on screen. Every mha-dnd document
   is world-readable by design (firestore.rules), so a thread is private
   the way a note passed in class is private: nobody is reading it unless
   they want to, and the DM can whenever they like. Anything that must
   actually be secret belongs somewhere else.

   One document holds every thread. Messages merge per-id through
   fsMergeSave, so two players typing at once cannot overwrite each
   other's lines.
   ═══════════════════════════════════════════════════════════════════ */
const FS_MSG_DOC = db.collection('mha-dnd').doc('messages');
const MAX_MESSAGES = 500;

let messages = null;        // [{id, ts, from, to, text}]
let msgThread = null;       // roster file of whoever's thread is open
// Shown inside the app. Routing failures to #pad-sync-note put them in the
// owner bar OUTSIDE the device, where a phone user never sees them — the app
// simply appeared to do nothing.
let msgStatus = '';
let _msgSyncedBaseline = null;
let _msgSaveInFlight = false;

// Threads are keyed by the pair, order-independent, so both halves of a
// conversation land in the same place regardless of who wrote first.
function threadKey(a, b) { return [a, b].sort().join('|'); }

function threadMessages(otherFile) {
  if (!messages || !activeFile) return [];
  const key = threadKey(activeFile, otherFile);
  return messages
    .filter(m => threadKey(m.from, m.to) === key)
    .sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

// "Unread" is anything addressed to this character since they last opened
// the app, which is per-device state — a read receipt shared between all
// twenty students is not something a badge should be inventing.
function lastReadAt() {
  try { return Number(localStorage.getItem('mha-heropad-read-' + activeFile)) || 0; } catch { return 0; }
}
function markMessagesRead() {
  try { localStorage.setItem('mha-heropad-read-' + activeFile, String(Date.now())); } catch {}
}
function unreadMessageCount() {
  if (!messages || !activeFile) return 0;
  const since = lastReadAt();
  return messages.filter(m => m.to === activeFile && (m.ts || 0) > since).length;
}

function renderMessagesApp() {
  if (!ROSTER.length) return '<p class="ct-empty">The class list could not be loaded.</p>';
  if (msgThread) return renderThread();

  const rows = ROSTER.filter(s => s.file !== activeFile).map(s => {
    const thread = threadMessages(s.file);
    const last = thread[thread.length - 1];
    const initials = String(s.name || '?').split(/\s+/).map(p => p[0]).slice(0, 2).join('');
    const unread = last && last.to === activeFile && (last.ts || 0) > lastReadAt();
    return `<button type="button" class="ct-row${unread ? ' unread' : ''}" onclick="openThread('${escHtml(s.file)}')">
      <span class="ct-avatar">${escHtml(initials)}</span>
      <span class="ct-body">
        <span class="ct-name">${escHtml(s.name)}</span>
        <span class="ct-quirk">${last ? escHtml((last.from === activeFile ? 'You: ' : '') + last.text) : escHtml(s.quirk || '')}</span>
      </span>
      ${unread ? '<span class="ct-dot"></span>' : ''}
    </button>`;
  }).join('');

  return `<p class="cz-lead">Anyone can read these — including the DM. Pass notes accordingly.</p>
    <div class="ct-list">${rows}</div>`;
}

function renderThread() {
  const who = ROSTER.find(s => s.file === msgThread);
  const lines = threadMessages(msgThread);
  const body = lines.length
    ? lines.map(m => `<div class="msg${m.from === activeFile ? ' mine' : ''}">
        <span class="msg-text">${escHtml(m.text)}</span>
        <span class="msg-time">${new Date(m.ts || 0).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>`).join('')
    : '<p class="bk-empty">No messages yet. Say something.</p>';

  return `
    <button type="button" class="msg-back" onclick="closeThread()">← All chats</button>
    <div class="msg-who">${escHtml(who ? who.name : 'Unknown')}</div>
    <div class="msg-list" id="msg-list">${body}</div>
    ${msgStatus ? `<p class="et-status">${escHtml(msgStatus)}</p>` : ''}
    <form class="msg-form" onsubmit="sendMessage(event)">
      <input type="text" id="msg-input" class="cz-input" maxlength="300" autocomplete="off"
             placeholder="${canSync ? 'Message…' : 'Sign in to send messages'}"
             aria-label="Your message" ${canSync ? '' : 'disabled'}>
      <button type="submit" class="msg-send" aria-label="Send" ${canSync ? '' : 'disabled'}>➤</button>
    </form>`;
}

function openThread(file) {
  msgThread = file;
  markMessagesRead();
  $('pad-app-body').innerHTML = renderMessagesApp();
  const input = $('msg-input');
  if (input && input.focus) input.focus();
  scrollThreadToEnd();
  renderHome();   // the badge just cleared
}

function closeThread() {
  msgThread = null;
  $('pad-app-body').innerHTML = renderMessagesApp();
}

function scrollThreadToEnd() {
  const list = $('msg-list');
  if (list && typeof list.scrollHeight === 'number') list.scrollTop = list.scrollHeight;
}

async function sendMessage(ev) {
  if (ev && ev.preventDefault) ev.preventDefault();
  const input = $('msg-input');
  const text = input ? input.value.trim() : '';
  if (!text || !msgThread || !activeFile) return;
  if (!canSync) {
    msgStatus = 'Sign in to send messages — this device can only read them.';
    $('pad-app-body').innerHTML = renderMessagesApp();
    return;
  }
  msgStatus = '';

  const entry = { id: genId('msg'), ts: Date.now(), from: activeFile, to: msgThread, text };
  messages = (messages || []).concat([entry]);
  if (messages.length > MAX_MESSAGES) messages = messages.slice(messages.length - MAX_MESSAGES);
  if (input) input.value = '';
  $('pad-app-body').innerHTML = renderMessagesApp();
  const again = $('msg-input');
  if (again && again.focus) again.focus();
  scrollThreadToEnd();

  _msgSaveInFlight = true;
  try {
    await fbAuthReady;
    // Per-id merge: two people typing at the same moment both keep their line.
    const merged = await fsMergeSave(FS_MSG_DOC, { messages }, _msgSyncedBaseline,
      [{ path: 'messages', idKey: 'id' }]);
    _msgSyncedBaseline = merged;
    messages = Array.isArray(merged.messages) ? merged.messages : messages;
  } catch (e) {
    msgStatus = 'Message not sent: ' + (e.code || e.message);
    $('pad-app-body').innerHTML = renderMessagesApp();
  } finally {
    _msgSaveInFlight = false;
  }
}

async function loadMessages() {
  try {
    await fbAuthReady;
    const snap = await FS_MSG_DOC.get();
    messages = snap.exists && Array.isArray(snap.data().messages) ? snap.data().messages : [];
    _msgSyncedBaseline = fsCloneDoc({ messages });
  } catch {
    messages = messages || [];
  }
}

function startMessageLiveSync() {
  FS_MSG_DOC.onSnapshot(snap => {
    if (!snap.exists || (snap.metadata && snap.metadata.fromCache)) return;
    if (_msgSaveInFlight) return;   // our own line is still in flight
    messages = Array.isArray(snap.data().messages) ? snap.data().messages : [];
    _msgSyncedBaseline = fsCloneDoc({ messages });
    if (openAppId === 'messages') {
      $('pad-app-body').innerHTML = renderMessagesApp();
      scrollThreadToEnd();
    } else if (locked) renderLock(); else renderHome();
  }, err => console.error('[heropad] messages sync stopped:', err));
}

/* ══ App: Tally ═════════════════════════════════════════════════════
   Named counters. "Times Toshida's head got stuck", "detentions",
   "Bakugo-style explosions" — whatever the table decides is worth
   counting. Stored on the pad, so each character keeps their own and
   they sync like any other pad setting.
   ═══════════════════════════════════════════════════════════════════ */
function tallies() {
  if (!Array.isArray(pad.tallies)) pad.tallies = [];
  return pad.tallies;
}

function renderTallyApp() {
  const list = tallies();
  const rows = list.length ? list.map(t => `
    <div class="tl-row">
      <span class="tl-name">${escHtml(t.name)}</span>
      <span class="tl-controls">
        <button type="button" onclick="bumpTally('${escHtml(t.id)}',-1)" aria-label="Subtract one from ${escHtml(t.name)}">−</button>
        <span class="tl-count">${Number(t.count) || 0}</span>
        <button type="button" onclick="bumpTally('${escHtml(t.id)}',1)" aria-label="Add one to ${escHtml(t.name)}">+</button>
        <button type="button" class="tl-del" onclick="removeTally('${escHtml(t.id)}')" aria-label="Delete ${escHtml(t.name)}">✕</button>
      </span>
    </div>`).join('') : '<p class="bk-empty">Nothing counted yet. Add something worth keeping score of.</p>';

  return `
    <form class="tl-form" onsubmit="addTally(event)">
      <input type="text" id="tl-new" class="cz-input" maxlength="40" autocomplete="off"
             placeholder="What are you counting?" aria-label="New tally name">
      <button type="submit" class="cz-btn">Add</button>
    </form>
    <div class="tl-list">${rows}</div>`;
}

function addTally(ev) {
  if (ev && ev.preventDefault) ev.preventDefault();
  const input = $('tl-new');
  const name = input ? input.value.trim() : '';
  if (!name) return;
  tallies().push({ id: genId('tly'), name, count: 0 });
  schedulePadSave();
  $('pad-app-body').innerHTML = renderTallyApp();
  const again = $('tl-new');
  if (again && again.focus) again.focus();
}

function bumpTally(id, delta) {
  const t = tallies().find(x => x.id === id);
  if (!t) return;
  // Floored at zero: a negative count of "detentions" is not a thing.
  t.count = Math.max(0, (Number(t.count) || 0) + delta);
  schedulePadSave();
  $('pad-app-body').innerHTML = renderTallyApp();
}

function removeTally(id) {
  pad.tallies = tallies().filter(x => x.id !== id);
  schedulePadSave();
  $('pad-app-body').innerHTML = renderTallyApp();
}

/* ══ App: Eats ══════════════════════════════════════════════════════
   Food delivery, and it costs real money: an order spends from the same
   purse the Shop spends from and writes the same kind of ledger entry,
   so lunch turns up on the Bank statement next to the combat knives.

   spendFromWallet below is a faithful port of the one in shop.js —
   cash first, then whole coins, breaking a larger coin only as a last
   resort — because collapsing a purse into yen and back would melt a
   player's platinum into small change on their first bowl of ramen.
   verify-eats.js runs both copies against the same cases and fails if
   they ever disagree.
   ═══════════════════════════════════════════════════════════════════ */
// Loaded from CAMPAIGN/eats-menu.json — the same file the Cloud Function
// prices orders from, so what is shown and what is charged cannot drift.
let EATS_MENU = [];

async function loadEatsMenu() {
  try {
    const data = await fetch('CAMPAIGN/eats-menu.json', { cache: 'no-cache' }).then(r => r.json());
    EATS_MENU = Array.isArray(data.items) ? data.items : [];
  } catch {
    EATS_MENU = [];
  }
  if (openAppId === 'eats') $('pad-app-body').innerHTML = renderEatsApp();
}

const EATS_LABEL = 'Eats';   // ledger entries are prefixed with this
let eatsStatus = '';

// Ported from shop.js — see the note above. Kept byte-comparable in
// behaviour, not in text, so verify-eats.js drives both and compares.
function spendFromWallet(currency, cost) {
  if (cost < 0) return false;
  if (walletTotalYen(currency) < cost) return false;
  let owed = cost;

  const fromYen = Math.min(currency.yen || 0, owed);
  currency.yen = (currency.yen || 0) - fromYen;
  owed -= fromYen;

  const ascending = ['cp', 'sp', 'ep', 'gp', 'pp'];
  for (const k of ascending) {
    if (owed <= 0) break;
    const rate = CURRENCY_TO_YEN[k];
    const use = Math.min(currency[k] || 0, Math.floor(owed / rate));
    if (use > 0) { currency[k] = (currency[k] || 0) - use; owed -= use * rate; }
  }

  if (owed > 0) {
    for (const k of ascending) {
      if ((currency[k] || 0) > 0 && CURRENCY_TO_YEN[k] >= owed) {
        currency[k] -= 1;
        currency.yen = (currency.yen || 0) + (CURRENCY_TO_YEN[k] - owed);
        owed = 0;
        break;
      }
    }
  }
  return owed === 0;
}

function eatsOrders() {
  return ownerEntries().filter(e => String(e.label || '').startsWith(EATS_LABEL + ' ·')).slice(0, 5);
}

function renderEatsApp() {
  const purse = ownerPurse();
  const have = purse ? walletTotalYen(purse) : 0;
  const recent = eatsOrders();

  const items = EATS_MENU.map(m => {
    const afford = purse && have >= m.price;
    return `<div class="et-item${afford ? '' : ' poor'}">
      <span class="et-ico">${escHtml(m.icon)}</span>
      <span class="et-body">
        <span class="et-name">${escHtml(m.name)}</span>
        <span class="et-desc">${escHtml(m.desc)}</span>
      </span>
      <button type="button" class="et-buy" onclick="orderFood('${escHtml(m.id)}')"
              ${canSync && afford ? '' : 'disabled'}>${yenStr(m.price)}</button>
    </div>`;
  }).join('');

  return `
    <div class="et-head">
      <span class="et-head-label">U.A. Eats</span>
      <span class="et-head-purse">${purse ? yenStr(have) : 'No purse'}</span>
    </div>
    ${!canSync ? '<p class="et-note">Sign in to order — this device can only browse the menu.</p>' : ''}
    ${eatsStatus ? `<p class="et-status">${escHtml(eatsStatus)}</p>` : ''}
    <div class="et-list">${items}</div>
    ${recent.length ? `<p class="dc-history-label">Recent orders</p>
      <div class="et-recent">${recent.map(o =>
        `<div class="et-recent-row"><span>${escHtml(String(o.label).replace(EATS_LABEL + ' · ', ''))}</span>
         <em>${yenStr(Math.abs(o.yen))}</em></div>`).join('')}</div>` : ''}`;
}

async function orderFood(id) {
  const item = EATS_MENU.find(m => m.id === id);
  if (!item || !canSync || !activeFile) return;
  eatsStatus = 'Ordering…';
  $('pad-app-body').innerHTML = renderEatsApp();

  try {
    // The pad cannot spend. It names the item; the Cloud Function looks up
    // the price, checks this is your character, moves the money and writes
    // the ledger. inventories/{file} refuses every client write, so there is
    // no faster path from here even for someone reading this comment in
    // devtools.
    await fbCall('spend', { characterFile: activeFile, source: 'eats', lines: [{ id, qty: 1 }] });
    eatsStatus = `${item.name} ordered. It is on its way.`;
  } catch (e) {
    eatsStatus = (e && e.message) || 'That order did not go through.';
  }
  $('pad-app-body').innerHTML = renderEatsApp();
}

/* ══ App: Board ═════════════════════════════════════════════════════
   A shared whiteboard. Everyone draws on the same surface and sees each
   other's strokes as they land — the communal scrap of paper that
   normally gets passed around the table.

   Strokes are stored in normalised 0–1000 coordinates rather than
   pixels, so a phone and a laptop draw on the same board rather than on
   two differently-scaled ones. Points are thinned as they are captured:
   a raw pointer trail is hundreds of points a second and would fill the
   1MB document in a couple of minutes.

   Per-stroke merge through fsMergeSave means two people drawing at once
   keep both drawings.
   ═══════════════════════════════════════════════════════════════════ */
const FS_BOARD_DOC = db.collection('mha-dnd').doc('whiteboard');
const MAX_STROKES = 300;
const BOARD_UNITS = 1000;          // coordinate space, both axes
const BOARD_MIN_STEP = 6;          // in board units, between captured points

const BOARD_COLOURS = ['#FFC220', '#FF2E4D', '#12D296', '#2F6BFF', '#A855F7', '#F2F5FA'];
let boardStrokes = null;
let boardColour = BOARD_COLOURS[0];
let boardWidth = 4;
let _boardBaseline = null;
let _boardSaveInFlight = false;
let _boardDrawing = null;
let boardStatus = '';   // shown in the app, for the same reason as msgStatus

function renderBoardApp() {
  const swatches = BOARD_COLOURS.map(c =>
    `<button type="button" class="bd-swatch${c === boardColour ? ' sel' : ''}" style="--sw:${c}"
             onclick="setBoardColour('${c}')" aria-label="Draw in ${c}"></button>`).join('');
  return `
    ${boardStatus ? `<p class="et-status">${escHtml(boardStatus)}</p>` : ''}
    ${!canSync ? '<p class="et-note">Signed out — you can see the board, but not draw on it.</p>' : ''}
    <div class="bd-tools">
      <div class="bd-swatches">${swatches}</div>
      <div class="bd-sizes">
        ${[2, 4, 8].map(w => `<button type="button" class="bd-size${w === boardWidth ? ' sel' : ''}"
            onclick="setBoardWidth(${w})" aria-label="Pen size ${w}"><i style="height:${w}px"></i></button>`).join('')}
      </div>
    </div>
    <canvas id="bd-canvas" class="bd-canvas" aria-label="Shared whiteboard"></canvas>
    <div class="bd-actions">
      <button type="button" class="cz-btn" onclick="undoMyStroke()">Undo mine</button>
      ${window.isAdmin && window.isAdmin() ? '<button type="button" class="cz-btn danger" onclick="clearBoard()">Wipe the board</button>' : ''}
      <span class="bd-count" id="bd-count"></span>
    </div>
    <p class="fx-note">Everyone in the class draws on this same board.</p>`;
}

function setBoardColour(c) { boardColour = c; $('pad-app-body').innerHTML = renderBoardApp(); mountBoard(); }
function setBoardWidth(w) { boardWidth = w; $('pad-app-body').innerHTML = renderBoardApp(); mountBoard(); }

function boardCtx() {
  const cv = $('bd-canvas');
  if (!cv || typeof cv.getContext !== 'function') return null;
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  // Match the backing store to the element's real size, so lines are crisp
  // and coordinates map 1:1 with what the pointer reports.
  const rect = typeof cv.getBoundingClientRect === 'function' ? cv.getBoundingClientRect() : null;
  const w = Math.max(1, Math.round((rect && rect.width) || cv.clientWidth || 300));
  const h = Math.max(1, Math.round((rect && rect.height) || cv.clientHeight || 300));
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  if (typeof ctx.setTransform === 'function') ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function drawBoard() {
  const c = boardCtx();
  if (!c) return;
  const { ctx, w, h } = c;
  ctx.clearRect(0, 0, w, h);
  const all = (boardStrokes || []).concat(_boardDrawing ? [_boardDrawing] : []);
  for (const s of all) {
    const pts = s.pts || [];
    if (pts.length < 4) continue;
    ctx.beginPath();
    ctx.strokeStyle = s.color || '#fff';
    ctx.lineWidth = s.w || 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.moveTo(pts[0] / BOARD_UNITS * w, pts[1] / BOARD_UNITS * h);
    for (let i = 2; i < pts.length; i += 2) {
      ctx.lineTo(pts[i] / BOARD_UNITS * w, pts[i + 1] / BOARD_UNITS * h);
    }
    ctx.stroke();
  }
  const count = $('bd-count');
  if (count) count.textContent = `${(boardStrokes || []).length} stroke${(boardStrokes || []).length === 1 ? '' : 's'}`;
}

function mountBoard() {
  const cv = $('bd-canvas');
  if (!cv || typeof cv.addEventListener !== 'function') return;
  if (cv.dataset && cv.dataset.wired === '1') { drawBoard(); return; }
  if (cv.dataset) cv.dataset.wired = '1';

  const toBoard = (ev) => {
    const rect = cv.getBoundingClientRect();
    return [
      Math.round((ev.clientX - rect.left) / Math.max(1, rect.width) * BOARD_UNITS),
      Math.round((ev.clientY - rect.top) / Math.max(1, rect.height) * BOARD_UNITS),
    ];
  };

  cv.addEventListener('pointerdown', (ev) => {
    if (!canSync) {
      boardStatus = 'Sign in to draw on the shared board.';
      $('pad-app-body').innerHTML = renderBoardApp();
      mountBoard();
      return;
    }
    ev.preventDefault();
    if (cv.setPointerCapture) cv.setPointerCapture(ev.pointerId);
    const [x, y] = toBoard(ev);
    _boardDrawing = { id: genId('str'), file: activeFile, color: boardColour, w: boardWidth, pts: [x, y] };
    drawBoard();
  });

  cv.addEventListener('pointermove', (ev) => {
    if (!_boardDrawing) return;
    const [x, y] = toBoard(ev);
    const pts = _boardDrawing.pts;
    const dx = x - pts[pts.length - 2], dy = y - pts[pts.length - 1];
    // Thinning: a raw pointer trail is hundreds of points a second.
    if (dx * dx + dy * dy < BOARD_MIN_STEP * BOARD_MIN_STEP) return;
    pts.push(x, y);
    drawBoard();
  });

  const finish = () => {
    if (!_boardDrawing) return;
    const stroke = _boardDrawing;
    _boardDrawing = null;
    if (stroke.pts.length >= 4) commitStroke(stroke);
    else drawBoard();
  };
  // ⚠ Deliberately NOT bound to pointerleave. Calling setPointerCapture in
  // pointerdown transfers the pointer to this element, and the browser fires
  // pointerleave as part of that transfer — so a leave-ends-the-stroke
  // handler kills every touch stroke the moment it begins, and the stroke is
  // then thrown away for having fewer than two points. Nothing draws at all
  // on a phone, while a mouse works fine because it never leaves the canvas
  // mid-drag. Capture already guarantees pointerup arrives here even if the
  // finger travels outside the element, which is what pointerleave was
  // wrongly standing in for.
  cv.addEventListener('pointerup', finish);
  cv.addEventListener('pointercancel', finish);

  drawBoard();
}

async function commitStroke(stroke) {
  boardStrokes = (boardStrokes || []).concat([stroke]);
  if (boardStrokes.length > MAX_STROKES) boardStrokes = boardStrokes.slice(boardStrokes.length - MAX_STROKES);
  drawBoard();
  await pushBoard();
}

async function pushBoard() {
  _boardSaveInFlight = true;
  try {
    await fbAuthReady;
    const merged = await fsMergeSave(FS_BOARD_DOC, { strokes: boardStrokes }, _boardBaseline,
      [{ path: 'strokes', idKey: 'id' }]);
    _boardBaseline = merged;
    boardStrokes = Array.isArray(merged.strokes) ? merged.strokes : boardStrokes;
    drawBoard();
  } catch (e) {
    boardStatus = 'The board did not save: ' + (e.code || e.message);
    if (openAppId === 'board') { $('pad-app-body').innerHTML = renderBoardApp(); mountBoard(); }
  } finally {
    _boardSaveInFlight = false;
  }
}

function undoMyStroke() {
  if (!canSync || !boardStrokes) return;
  for (let i = boardStrokes.length - 1; i >= 0; i--) {
    if (boardStrokes[i].file === activeFile) {
      boardStrokes = boardStrokes.slice(0, i).concat(boardStrokes.slice(i + 1));
      drawBoard();
      pushBoard();
      return;
    }
  }
}

function clearBoard() {
  if (!(window.isAdmin && window.isAdmin())) return;
  boardStrokes = [];
  drawBoard();
  pushBoard();
}

async function loadBoard() {
  try {
    await fbAuthReady;
    const snap = await FS_BOARD_DOC.get();
    boardStrokes = snap.exists && Array.isArray(snap.data().strokes) ? snap.data().strokes : [];
    _boardBaseline = fsCloneDoc({ strokes: boardStrokes });
  } catch {
    boardStrokes = boardStrokes || [];
  }
}

function startBoardLiveSync() {
  FS_BOARD_DOC.onSnapshot(snap => {
    if (!snap.exists || (snap.metadata && snap.metadata.fromCache)) return;
    // Never apply a remote board over a stroke still being drawn or saved:
    // the line would vanish from under the pen.
    if (_boardSaveInFlight || _boardDrawing) return;
    boardStrokes = Array.isArray(snap.data().strokes) ? snap.data().strokes : [];
    _boardBaseline = fsCloneDoc({ strokes: boardStrokes });
    if (openAppId === 'board') drawBoard();
  }, err => console.error('[heropad] board sync stopped:', err));
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

/* ══ Owner selection ════════════════════════════════════════════════
   A player is asked who they are exactly once, on a setup screen inside
   the device, and the answer is remembered on this device from then on.
   It was a dropdown above the phone before, which meant re-picking your
   own character on every single visit — the pad is meant to be personal
   kit, and being handed a class list every time you pick it up is the
   opposite of that.

   The screen is skipped entirely when something already identifies the
   player: a remembered choice, or an account with edit rights to exactly
   one character. It is only ever shown when the answer is genuinely
   unknown, or when someone taps Switch.
   ═══════════════════════════════════════════════════════════════════ */
let setupShowAll = false;

function renderSetup() {
  const pcs = ROSTER.filter(s => s.is_pc);
  const rest = ROSTER.filter(s => !s.is_pc);
  const shown = setupShowAll ? pcs.concat(rest) : pcs;

  $('setup-list').innerHTML = shown.map(s => `
    <button type="button" role="listitem" class="setup-pick${s.file === activeFile ? ' sel' : ''}"
            onclick="chooseOwner('${escHtml(s.file)}')">
      <span class="setup-pick-name">${escHtml(s.name)}</span>
      <span class="setup-pick-quirk">${escHtml(s.quirk || '')}</span>
    </button>`).join('') || '<p class="bk-empty">The class roster could not be loaded.</p>';

  const allBtn = $('setup-all-btn');
  allBtn.textContent = setupShowAll ? 'Just the player characters' : 'Show the rest of Class 1-A';
  allBtn.hidden = !rest.length;
  // Cancel only makes sense once a pad is already open behind the screen.
  $('setup-cancel-btn').hidden = !activeFile;
}

function openSetup() {
  closeApp();
  renderSetup();
  $('pad-setup').hidden = false;
  requestAnimationFrame(() => $('pad-setup').classList.add('open'));
}

function closeSetup() {
  const el = $('pad-setup');
  el.classList.remove('open');
  setTimeout(() => { if (!el.classList.contains('open')) el.hidden = true; }, 240);
}

function toggleSetupAll() {
  setupShowAll = !setupShowAll;
  renderSetup();
}

// No need to repaint the Bank or the ranking chart for the new owner here:
// openSetup() closes whatever app was open before this screen appears, so a
// pick always lands back on the home screen. Switching character out from
// under an open statement would silently swap the numbers being read anyway.
function chooseOwner(file) {
  activeFile = file;
  try { localStorage.setItem(LS_ACTIVE, file); } catch {}
  closeSetup();
  renderOwnerName();
  renderOwnerLine();
  loadPad(file);
  startPadLiveSync(file);
  renderHome();   // badges and the widget are per-character
}

function renderOwnerName() {
  const s = ownerStudent();
  $('pad-owner-name').textContent = s ? s.name : 'Not set';
}

// Whose pad to open on arrival, or null when nothing identifies the player
// and the setup screen should ask.
//
// The canEdit() path deliberately skips admins. canEdit returns true for an
// admin on every id (auth.js:45), so for the DM it would resolve to "the
// first student in the roster" every single time and quietly override the
// pad they were actually last looking at.
function pickDefaultOwner() {
  const remembered = (() => { try { return localStorage.getItem(LS_ACTIVE); } catch { return null; } })();
  if (remembered && ROSTER.some(s => s.file === remembered)) return remembered;
  const isDm = !!(window.isAdmin && window.isAdmin());
  const mine = (!isDm && window.canEdit) ? ROSTER.find(s => window.canEdit(s.id)) : null;
  return mine ? mine.file : null;
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

  // Class-wide, not per-pad, so these load once and stay subscribed for the
  // life of the page rather than being re-fetched on every owner switch.
  // Started before the owner is known so the apps are warm either way.
  await Promise.all([loadRanking(), loadBank(), loadMessages(), loadBoard(), loadEatsMenu()]);
  startRankLiveSync();
  startBankLiveSync();
  startMessageLiveSync();
  startBoardLiveSync();

  activeFile = pickDefaultOwner();
  if (!activeFile) {
    if (!ROSTER.length) { setSyncNote('No characters found in the roster.'); return; }
    renderOwnerName();
    openSetup();   // first visit on this device — ask once, then never again
    return;
  }
  renderOwnerName();
  renderOwnerLine();
  await loadPad(activeFile);
  startPadLiveSync(activeFile);
  renderHome();   // badges and the widget, now that the owner and data are known
  lockPad();      // the pad opens locked, like a phone does
})();
