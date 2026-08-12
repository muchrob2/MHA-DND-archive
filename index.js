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
      el.title = [
        'Version ' + v.version,
        v.commit ? 'commit ' + v.commit : null,
        built && !isNaN(built) ? 'built ' + built.toLocaleString() : null,
      ].filter(Boolean).join(' · ');
      el.classList.remove('hidden');
    } catch {
      // leave the badge hidden rather than render a wrong or empty version
    }
  }
  refreshVersion();
