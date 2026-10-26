// Page logic for updates.html. Extracted from the HTML so it can be linted,
// diffed and tested directly rather than regex-scraped out of markup.
// Loaded as a CLASSIC script, not a module: the page wires controls with
// inline onclick= handlers that resolve against globals, and top-level
// declarations here become globals exactly as they did inline.
//
// ── What this page is ───────────────────────────────────────────────
// The patch notes. updates.json carries one entry per update that went
// live, newest first; version/build/date/commit in it are read out of git
// by hand at authoring time and checked by scripts/verify-updates.js, so an
// entry cannot claim a release that never shipped.
//
// There is no Firebase here. The notes are a static file that deploys with
// the site, so the page loads with one fetch and works signed out.

let updatesDoc = null;
let activeTag = null;

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(d) {
  const parsed = new Date(String(d) + 'T00:00:00');
  if (isNaN(parsed)) return escHtml(d);
  return parsed.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

// The live build, so a reader can tell whether the top entry is what they
// are actually looking at. Fails quietly: a missing version.json is not
// worth a banner on a page of notes.
async function showLiveVersion() {
  const el = document.getElementById('live-version');
  if (!el) return;
  try {
    const v = await (await fetch('version.json', { cache: 'no-cache' })).json();
    if (!v || !v.version) return;
    el.textContent = 'running v' + v.version;
    const top = updatesDoc && updatesDoc.updates && updatesDoc.updates[0];
    if (!top) return;
    if (top.version === v.version) { el.classList.add('is-current'); return; }
    // The notes are written by hand and the version is stamped by the deploy,
    // so the two drift. Saying so is better than a reader wondering whether
    // the newest entry is what they are looking at.
    if (Number(v.build) > Number(top.build)) {
      const note = document.createElement('div');
      note.id = 'upd-ahead';
      note.textContent = `You are running ${v.version}. These notes stop at ${top.version} — the newest change is not written up yet.`;
      const list = document.getElementById('upd-list');
      if (list && list.parentNode) list.parentNode.insertBefore(note, list);
    }
  } catch { /* leave it blank */ }
}

function visibleUpdates() {
  const all = (updatesDoc && updatesDoc.updates) || [];
  return activeTag ? all.filter(u => (u.tags || []).includes(activeTag)) : all;
}

function renderFilters() {
  const wrap = document.getElementById('upd-filters');
  if (!wrap) return;
  const all = (updatesDoc && updatesDoc.updates) || [];
  // Only tags something actually carries, with the count, in the order the
  // file lists them — a filter for a tag with nothing behind it is a dead end.
  const counts = new Map();
  for (const u of all) for (const t of u.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  const order = ((updatesDoc && updatesDoc.tags) || [...counts.keys()]).filter(t => counts.has(t));
  wrap.innerHTML = `<button class="upd-tag${activeTag ? '' : ' sel'}" onclick="filterTag(null)">
      Everything <b>${all.length}</b></button>`
    + order.map(t => `<button class="upd-tag tag-${escHtml(t)}${activeTag === t ? ' sel' : ''}"
        onclick="filterTag('${escHtml(t)}')">${escHtml(t)} <b>${counts.get(t)}</b></button>`).join('');
}

function filterTag(tag) {
  activeTag = activeTag === tag ? null : tag;
  render();
}

function updateHtml(u) {
  return `<article class="upd-card">
    <header class="upd-head">
      <span class="upd-version">${escHtml(u.version)}</span>
      <h2 class="upd-title">${escHtml(u.title)}</h2>
      <span class="upd-date">${formatDate(u.date)}</span>
    </header>
    <ul class="upd-items">
      ${(u.items || []).map(i => `<li>${escHtml(i)}</li>`).join('')}
    </ul>
    <footer class="upd-foot">
      ${(u.tags || []).map(t => `<span class="upd-chip tag-${escHtml(t)}">${escHtml(t)}</span>`).join('')}
      <span class="upd-commit">${escHtml(u.commit)}${u.pr ? ' · #' + escHtml(u.pr) : ''}</span>
    </footer>
  </article>`;
}

function render() {
  renderFilters();
  const list = document.getElementById('upd-list');
  const empty = document.getElementById('upd-empty');
  const shown = visibleUpdates();
  if (list) list.innerHTML = shown.map(updateHtml).join('');
  if (empty) empty.style.display = shown.length ? 'none' : '';
}

async function init() {
  try {
    const res = await fetch('updates.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('bad status');
    updatesDoc = await res.json();
    if (!Array.isArray(updatesDoc.updates)) throw new Error('no updates array');
  } catch {
    document.getElementById('load-error-banner').style.display = '';
    return;
  }
  render();
  showLiveVersion();
}

init();
