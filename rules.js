// Page logic for rules.html. Extracted from the HTML so it can be linted,
// diffed and tested directly rather than regex-scraped out of markup.
// Loaded as a CLASSIC script, not a module: the page wires controls with
// inline onclick= handlers that resolve against globals.
//
// ── What this page is ───────────────────────────────────────────────
// The quick reference. Ten sections of one-line mechanics — the d20, your
// turn, moving, cover, areas, damage, dying, conditions, rests, and how the
// toolkit itself handles the fiddly bits — all searchable in one box.
//
// It is for everyone, not the DM: before this, a player who wanted to know
// what Prone does had two PDFs and no search. The conditions reference lived
// inside the Encounter Manager, which players cannot open.
//
// ── No Firebase, no fetch ───────────────────────────────────────────
// rules-data.js is a script tag above this one, so RULES_REFERENCE is already
// in memory when this runs. Nothing to load, nothing to fail, works signed
// out and offline. The same file feeds the Encounter Manager's Rules panel
// and the Heropad's Rules app, so none of the three can drift.

let rulesQuery = '';
let rulesOpenSection = null; // null = every section open

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Wrap the matched run in each hit so the eye lands on it. Built from the
// ESCAPED string and injected as HTML, so the only tags that can reach the
// DOM are the <mark>s this adds — the text itself is already inert.
function rulesHighlight(text, query) {
  const safe = escHtml(text);
  const words = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return safe;
  // Longest first: highlighting "cover" before "cover-stacking" would leave
  // the longer match split across two <mark>s.
  const pattern = words.sort((a, b) => b.length - a.length)
    .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return safe.replace(new RegExp('(' + pattern + ')', 'gi'), '<mark>$1</mark>');
}

function visibleEntries(section) {
  return section.entries.filter(e => rulesEntryMatches(e, section, rulesQuery));
}

function visibleSections() {
  return RULES_REFERENCE.sections.filter(s =>
    (!rulesOpenSection || s.id === rulesOpenSection) && visibleEntries(s).length);
}

// Typing releases the picked section, for two reasons: a search has to look
// everywhere or it can silently hide the answer, and if the pick survived the
// search, clearing the box would drop you back into one section of eight rules
// looking like the page had broken.
function onRulesSearch(value) {
  rulesQuery = value;
  if (value.trim()) rulesOpenSection = null;
  renderRules();
}

function pickSection(id) {
  rulesOpenSection = rulesOpenSection === id ? null : id;
  renderRules();
  if (rulesOpenSection) {
    const el = document.getElementById('sec-' + rulesOpenSection);
    if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function clearRulesSearch() {
  rulesQuery = '';
  const input = document.getElementById('rules-search');
  if (input) { input.value = ''; input.focus(); }
  renderRules();
}

function renderRail() {
  const rail = document.getElementById('rules-rail');
  if (!rail) return;
  const q = rulesQuery.trim();
  rail.innerHTML = RULES_REFERENCE.sections.map(s => {
    const n = visibleEntries(s).length;
    // During a search the rail becomes a result count per section rather than
    // a filter — tapping one while a query is live would hide the rest of the
    // hits, so the buttons go inert and just report.
    const sel = q ? (n ? ' has-hits' : ' no-hits') : (rulesOpenSection === s.id ? ' sel' : '');
    return `<button class="rules-rail-btn${sel}" ${q ? 'disabled' : ''}
      onclick="pickSection('${escHtml(s.id)}')" title="${escHtml(s.blurb)}">
      <span class="rr-icon">${escHtml(s.icon)}</span>
      <span class="rr-name">${escHtml(s.name)}</span>
      <span class="rr-count">${n}</span>
    </button>`;
  }).join('');
}

function sectionHtml(section) {
  const entries = visibleEntries(section);
  return `<section class="rules-sec" id="sec-${escHtml(section.id)}">
    <header class="rules-sec-head">
      <span class="rules-sec-icon">${escHtml(section.icon)}</span>
      <div>
        <h2 class="rules-sec-name">${escHtml(section.name)}</h2>
        <p class="rules-sec-blurb">${escHtml(section.blurb)}</p>
      </div>
      <a class="rules-sec-link" href="#sec-${escHtml(section.id)}"
        title="Link straight to this section">#</a>
    </header>
    <div class="rules-entries">
      ${entries.map(e => `<div class="rules-entry">
        <div class="rules-entry-name">${rulesHighlight(e.name, rulesQuery)}</div>
        <div class="rules-entry-text">${rulesHighlight(e.text, rulesQuery)}</div>
      </div>`).join('')}
    </div>
  </section>`;
}

function renderRules() {
  renderRail();
  const secs = visibleSections();
  const wrap = document.getElementById('rules-body');
  if (wrap) wrap.innerHTML = secs.map(sectionHtml).join('');
  const empty = document.getElementById('rules-empty');
  if (empty) empty.style.display = secs.length ? 'none' : '';
  const clear = document.getElementById('rules-clear');
  if (clear) clear.style.display = rulesQuery.trim() ? '' : 'none';

  const count = document.getElementById('rules-count');
  if (count) {
    const shown = secs.reduce((n, s) => n + visibleEntries(s).length, 0);
    const all = rulesEntryCount();
    count.textContent = shown === all ? `${all} rules` : `${shown} of ${all}`;
  }
}

// "/" focuses the search from anywhere on the page, Escape clears it — the
// same two keys campaigns.html uses, so the habit carries between pages.
function onRulesKey(e) {
  const input = document.getElementById('rules-search');
  if (!input) return;
  const typing = document.activeElement === input;
  if (e.key === '/' && !typing) { e.preventDefault(); input.focus(); input.select(); return; }
  if (e.key === 'Escape' && typing) {
    if (rulesQuery.trim()) clearRulesSearch(); else input.blur();
  }
}

function init() {
  document.addEventListener('keydown', onRulesKey);
  renderRules();
  const src = document.getElementById('rules-source');
  if (src) src.textContent = RULES_REFERENCE.source;
  // A link straight into a section (#sec-conditions from the Heropad, or a
  // bookmark) lands after the first render, so the anchor has something to
  // scroll to by the time the browser looks for it.
  if (location.hash) {
    const el = document.getElementById(location.hash.slice(1));
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start' });
  }
}

init();
