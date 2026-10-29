// Page logic for index.html. Extracted from the HTML so it can be linted,
// diffed and tested directly rather than regex-scraped out of markup.
// Loaded as a CLASSIC script, not a module: the page wires controls with
// inline onclick= handlers that resolve against globals, and top-level
// declarations here become globals exactly as they did inline. type="module"
// would scope them and silently break every handler.

  // Note: this is a UI convenience, not access control. It only decides which
  // nav links/labels render on this device so DM-only spoilers aren't visible
  // on a shared screen — it does not gate reads or writes. Actual permissions
  // are enforced server-side by Firestore rules (see firestore.rules:
  // isAdmin()/isEditorFor()), independent of this PIN.
  const DM_PIN = '6560';
  let pinEntry = '';

  function chooseRole(role) {
    sessionStorage.setItem('mha-role', role);
    applyRole(role);
  }

  function applyRole(role) {
    document.getElementById('role-screen').classList.add('hidden');
    document.getElementById('pin-screen').classList.remove('visible');
    document.getElementById('app').classList.add('visible');
    if (role === 'player') {
      document.getElementById('dm-only').style.display = 'none';
      document.getElementById('header-label').textContent = 'U.A. High School — Class 1-A';
    } else {
      document.getElementById('dm-only').style.display = '';
      document.getElementById('header-label').textContent = 'U.A. High School — DM Command';
    }
  }

  function switchRole() {
    sessionStorage.removeItem('mha-role');
    pinEntry = '';
    updateDots();
    document.getElementById('pin-error').textContent = '';
    document.getElementById('role-screen').classList.remove('hidden');
    document.getElementById('pin-screen').classList.remove('visible');
    document.getElementById('app').classList.remove('visible');
  }

  function showPin() {
    pinEntry = '';
    updateDots();
    document.getElementById('pin-error').textContent = '';
    document.getElementById('role-screen').classList.add('hidden');
    document.getElementById('pin-screen').classList.add('visible');
  }

  function hidePin() {
    pinEntry = '';
    updateDots();
    document.getElementById('pin-error').textContent = '';
    document.getElementById('pin-screen').classList.remove('visible');
    document.getElementById('role-screen').classList.remove('hidden');
  }

  function pinPress(digit) {
    if (pinEntry.length >= 4) return;
    pinEntry += digit;
    updateDots();
    if (pinEntry.length === 4) {
      setTimeout(checkPin, 120);
    }
  }

  function pinDelete() {
    pinEntry = pinEntry.slice(0, -1);
    updateDots();
    document.getElementById('pin-error').textContent = '';
  }

  function updateDots() {
    for (let i = 0; i < 4; i++) {
      const dot = document.getElementById('dot-' + i);
      dot.classList.toggle('filled', i < pinEntry.length);
      dot.classList.remove('error');
    }
  }

  function checkPin() {
    if (pinEntry === DM_PIN) {
      chooseRole('dm');
    } else {
      for (let i = 0; i < 4; i++) {
        document.getElementById('dot-' + i).classList.add('error');
        document.getElementById('dot-' + i).classList.remove('filled');
      }
      document.getElementById('pin-error').textContent = 'Incorrect code — try again';
      setTimeout(() => {
        pinEntry = '';
        updateDots();
      }, 800);
    }
  }

  document.addEventListener('keydown', e => {
    if (!document.getElementById('pin-screen').classList.contains('visible')) return;
    if (e.key >= '0' && e.key <= '9') pinPress(e.key);
    if (e.key === 'Backspace') pinDelete();
  });

  const saved = sessionStorage.getItem('mha-role');
  if (saved) applyRole(saved);

  // ── "Last updated" indicator ──
  // Shows when the site content was last pushed, sourced from the latest
  // commit on main via the GitHub API. Cached in localStorage for 10 minutes
  // so repeat visits/reloads don't hammer the (unauthenticated, rate-limited)
  // API — a stale cache is shown immediately while a fresh check happens
  // behind it, so the indicator never blocks or blanks on reload.
  const LAST_UPDATED_CACHE_KEY = 'mha_last_updated_cache';
  const LAST_UPDATED_TTL_MS = 10 * 60 * 1000;
  const LAST_UPDATED_API = 'https://api.github.com/repos/muchrob2/MHA-DND-archive/commits/main';

  function formatTimeAgo(iso) {
    const then = new Date(iso).getTime();
    const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (diffSec < 60) return 'Updated just now';
    const diffMin = Math.round(diffSec / 60);
    if (diffMin < 60) return `Updated ${diffMin}m ago`;
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return `Updated ${diffHr}h ago`;
    const diffDay = Math.round(diffHr / 24);
    if (diffDay < 14) return `Updated ${diffDay}d ago`;
    return 'Updated ' + new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function renderLastUpdated(iso, isStale) {
    const el = document.getElementById('last-updated');
    const textEl = document.getElementById('last-updated-text');
    textEl.textContent = formatTimeAgo(iso);
    el.title = 'Last commit: ' + new Date(iso).toLocaleString();
    el.classList.toggle('stale', !!isStale);
    el.classList.remove('hidden');
  }

  async function refreshLastUpdated() {
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(LAST_UPDATED_CACHE_KEY) || 'null'); } catch {}
    if (cached && cached.date) {
      renderLastUpdated(cached.date, false);
      if (Date.now() - cached.fetchedAt < LAST_UPDATED_TTL_MS) return; // still fresh enough, skip the fetch
    }
    try {
      const res = await fetch(LAST_UPDATED_API, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error('bad status');
      const data = await res.json();
      const iso = data.commit?.committer?.date || data.commit?.author?.date;
      if (!iso) throw new Error('no date in response');
      localStorage.setItem(LAST_UPDATED_CACHE_KEY, JSON.stringify({ date: iso, fetchedAt: Date.now() }));
      renderLastUpdated(iso, false);
    } catch {
      if (cached && cached.date) renderLastUpdated(cached.date, true); // show what we have, marked stale
      // else: leave the indicator hidden rather than show something wrong
    }
  }
  refreshLastUpdated();

  // ── Build version badge ──
  // version.json is rewritten by the Pages workflow on every deploy (see
  // .github/workflows/pages.yml), so this moves forward on its own without
  // anyone editing it. The copy committed to the repo is a fallback so the
  // badge still renders under `python3 server.py` locally.
  //
  // Deliberately NOT cached in localStorage, unlike the last-updated
  // indicator above: that one is rate-limited by the GitHub API, whereas
  // this is a small same-origin file, and caching it is exactly how you end
  // up showing a stale version right after shipping. `cache: 'no-cache'`
  // revalidates rather than trusting the browser's copy, which matters on
  // Pages where the CDN will happily serve an old one.
  async function refreshVersion() {
    const el = document.getElementById('version-badge');
    if (!el) return;
    try {
      const res = await fetch('version.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('bad status');
      const v = await res.json();
      if (!v || !v.version) throw new Error('no version field');
      el.textContent = 'v' + v.version;
      const built = v.built ? new Date(v.built) : null;
      // The badge is a link to the notes now, so say where it goes.
      el.title = [
        'Version ' + v.version,
        v.commit ? 'commit ' + v.commit : null,
        built && !isNaN(built) ? 'built ' + built.toLocaleString() : null,
        'Click for what changed',
      ].filter(Boolean).join(' · ');
      el.classList.remove('hidden');
    } catch {
      // leave the badge hidden rather than render a wrong or empty version
    }
  }
  refreshVersion();

  /* ── Something new to read ─────────────────────────────────
     The badge links to the notes; this says whether there is anything in
     them you have not seen. The last version this browser looked at is
     remembered, and the dot appears when the notes have moved past it —
     which means it is the notes being written that lights it up, not a
     deploy, because a deploy with nothing written up yet is not news.

     First visit sets the mark and shows nothing: arriving at a dashboard
     with "28 new" on it is noise. */
  const UPDATES_SEEN_KEY = 'mha-updates-seen';

  async function markUnreadUpdates() {
    const badge = document.getElementById('version-badge');
    if (!badge) return;
    let entries;
    try {
      const doc = await (await fetch('updates.json', { cache: 'no-cache' })).json();
      entries = doc.updates || [];
    } catch { return; }
    const newest = Number((entries[0] || {}).build) || 0;
    if (!newest) return;
    let seen = 0;
    try { seen = Number(localStorage.getItem(UPDATES_SEEN_KEY)) || 0; } catch { return; }
    if (!seen) {
      try { localStorage.setItem(UPDATES_SEEN_KEY, String(newest)); } catch {}
      return;
    }
    if (newest <= seen) return;
    const n = entries.filter(u => Number(u.build) > seen).length;
    badge.classList.add('has-unread');
    badge.dataset.unread = String(n);
    badge.title = `${n} update${n === 1 ? '' : 's'} you have not read · ` + badge.title;
  }
  markUnreadUpdates();
  /* ── Where we left off ─────────────────────────────────────
     The dashboard knew nothing about the campaign it is the front door to.
     This reads the most recent session out of the session log and puts it at
     the top of the DM's half of the page: the number, the date, the title,
     and the "next time" line the log now carries.

     Read over the Firestore REST API rather than with the SDK, because this
     page deliberately loads no Firebase: three SDK scripts and auth.js to
     render one sentence would be the slowest thing on the dashboard. The
     mha-dnd documents are world-readable by rule (firestore.rules), which is
     the same access the session log page itself has, so there is nothing to
     authenticate for. If the request fails the strip stays hidden — a
     dashboard that says "couldn't load" where a recap should be is worse
     than a dashboard that says nothing.

     It renders inside #dm-only, so a player's device never shows it: "next
     time" is the DM's note to themselves and frequently a spoiler. */
  const FS_REST = 'https://firestore.googleapis.com/v1/projects/mha-dnd-archive/databases/(default)/documents/mha-dnd/session-log';

  // Shared by both strips. It was declared inside renderLastSession, which
  // was fine while that was the only thing printing live data.
  const esc = (t) => String(t == null ? '' : t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Firestore's REST shape wraps every value in its type. Only the four
  // fields this strip shows are unwrapped; the rest is left alone.
  function fsValue(v) {
    if (!v || typeof v !== 'object') return undefined;
    if ('stringValue' in v) return v.stringValue;
    if ('integerValue' in v) return Number(v.integerValue);
    if ('doubleValue' in v) return Number(v.doubleValue);
    if ('booleanValue' in v) return v.booleanValue;
    if ('nullValue' in v) return null;
    if ('arrayValue' in v) return (v.arrayValue.values || []).map(fsValue);
    if ('mapValue' in v) {
      const out = {};
      for (const [k, inner] of Object.entries(v.mapValue.fields || {})) out[k] = fsValue(inner);
      return out;
    }
    return undefined;
  }

  function latestSession(sessions) {
    // Highest session number wins, and a log with no numbers falls back to
    // the latest date rather than to nothing.
    let best = null;
    for (const s of sessions) {
      if (!s) continue;
      if (!best) { best = s; continue; }
      const a = Number(s.number) || 0, b = Number(best.number) || 0;
      if (a > b || (a === b && String(s.date || '') > String(best.date || ''))) best = s;
    }
    return best;
  }

  function renderLastSession(s) {
    const wrap = document.getElementById('last-session');
    if (!wrap || !s) return;
    const date = s.date ? new Date(s.date + 'T00:00:00') : null;
    const when = date && !isNaN(date) ? date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    wrap.innerHTML = `<a class="last-session-inner" href="session-log.html">
        <div class="last-session-label">Where you left off${s.number ? ' · Session ' + esc(s.number) : ''}${when ? ' · ' + esc(when) : ''}</div>
        <div class="last-session-title">${esc(s.title || 'Untitled session')}</div>
        ${s.next ? `<div class="last-session-next"><span>Next time</span>${esc(s.next)}</div>` : ''}
      </a>`;
    wrap.classList.remove('hidden');
  }

  /* ── The glance strip ────────────────────────────────────────────
     What the dashboard could not say until now: whether a fight is
     running, and how much attention Byakko are paying. Both are live
     documents that every other page already reads, and a menu that
     knows neither is a menu rather than a dashboard.

     Read over REST like the session strip above, for the same reason —
     this page loads no Firebase SDK and is not going to start for two
     numbers. Every row hides itself when there is nothing to say, so a
     quiet strip means a quiet table rather than a failed load.

     It is NOT inside #dm-only. Whose turn it is and what the Heat is
     are the two things a player most wants to know before they open
     anything, and both documents are world-readable by design.
     ─────────────────────────────────────────────────────────────── */
  const FS_DOC = (name) =>
    'https://firestore.googleapis.com/v1/projects/mha-dnd-archive/databases/(default)/documents/mha-dnd/' + name;

  // 0-1 quiet, 2-7 warming, 8-10 hot. The bands themselves live in
  // byakko-data.js, which this page does not load — this is only picking a
  // colour, and getting that wrong costs a shade rather than a fact.
  function heatMood(level) {
    return level >= 8 ? 'hot' : level >= 4 ? 'warm' : 'quiet';
  }

  async function readDoc(name) {
    const res = await fetch(FS_DOC(name), { cache: 'no-cache' });
    if (!res.ok) throw new Error('bad status');
    const doc = await res.json();
    return doc.fields || {};
  }

  function glanceRow(href, label, value, extra) {
    return `<a class="glance-item${extra ? ' mood-' + extra : ''}" href="${href}">
        <span class="glance-label">${esc(label)}</span>
        <span class="glance-value">${esc(value)}</span>
      </a>`;
  }

  async function loadGlance() {
    const wrap = document.getElementById('glance');
    if (!wrap) return;
    const rows = [];

    // A fight, if one is running. `currentIndex` points into the DM's own
    // ordering, so the name is read out of that array rather than sorted
    // here — see the note in table.js.
    try {
      const f = await readDoc('encounter-state');
      const combatants = fsValue(f.combatants) || [];
      if (Array.isArray(combatants) && combatants.length) {
        const n = combatants.length;
        const raw = Number(fsValue(f.currentIndex));
        const i = Number.isFinite(raw) ? ((raw % n) + n) % n : 0;
        const now = combatants[i] || {};
        const round = fsValue(f.round);
        rows.push(glanceRow('table.html',
          'In the fight' + (round ? ' · round ' + round : ''),
          (now.name || 'somebody') + '\u2019s turn', 'live'));
      }
    } catch {}

    try {
      const f = await readDoc('heat');
      const level = Number(fsValue(f.heat));
      if (Number.isFinite(level)) {
        const beaten = fsValue(f.beaten) || {};
        const count = beaten && typeof beaten === 'object' ? Object.keys(beaten).length : 0;
        rows.push(glanceRow('heat.html', 'Byakko Heat',
          level + ' of 10' + (count ? ' · ' + count + ' beaten' : ''), heatMood(level)));
      }
    } catch {}

    if (!rows.length) return;      // nothing happening; the strip stays gone
    wrap.innerHTML = rows.join('');
    wrap.classList.remove('hidden');
  }
  loadGlance();

  async function loadLastSession() {
    if (!document.getElementById('last-session')) return;
    try {
      const res = await fetch(FS_REST, { cache: 'no-cache' });
      if (!res.ok) throw new Error('bad status');
      const doc = await res.json();
      const sessions = fsValue((doc.fields || {}).sessions) || [];
      if (!Array.isArray(sessions) || !sessions.length) return;
      renderLastSession(latestSession(sessions));
    } catch {
      // Stays hidden. The log itself is one click away either way.
    }
  }
  loadLastSession();

