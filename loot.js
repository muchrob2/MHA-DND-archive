// Page logic for loot.html. Extracted from the HTML so it can be linted,
// diffed and tested directly rather than regex-scraped out of markup.
// Loaded as a CLASSIC script, not a module: the page wires controls with
// inline onclick= handlers that resolve against globals.
//
// ── What this page is ───────────────────────────────────────────────
// The DM's loot menu. CAMPAIGN/loot.json carries eight tables of items,
// each one hanging off something already written in the campaign — the
// hook field says which. The page renders them as rollable tables: press
// the die on a table and it picks a row and marks it.
//
// No Firebase. The tables are a static file that deploys with the site, so
// this loads with one fetch and works signed out.

let lootDoc = null;
let lootQuery = '';
let lootTier = null;
// Which row each table last rolled, so a roll stays marked while the DM
// reads it and is not lost to a re-render.
const lootRolled = {};

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function dieSize(die) {
  const n = Number(String(die || '').replace(/^d/i, ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Every word has to appear somewhere in the row — name, effect or hook — so
// "silver clinic" finds the blade without knowing what it is called.
function itemMatches(item, table, q) {
  if (!q) return true;
  const hay = [item.name, item.effect, item.hook, item.tier, table.name].join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w));
}

function visibleItems(table) {
  return (table.items || []).filter(i =>
    (!lootTier || i.tier === lootTier) && itemMatches(i, table, lootQuery.trim()));
}

function onLootSearch(value) {
  lootQuery = value;
  render();
}

function filterTier(tier) {
  lootTier = lootTier === tier ? null : tier;
  render();
}

// A roll ignores the search and the tier filter on purpose: the table is the
// table, and a die that only lands on rows you have filtered to is not a die.
function rollTable(tableId) {
  const table = (lootDoc.tables || []).find(t => t.id === tableId);
  const size = table ? dieSize(table.die) : 0;
  if (!size) return;
  lootRolled[tableId] = 1 + Math.floor(Math.random() * size);
  render();
  const row = document.getElementById(`loot-row-${tableId}-${lootRolled[tableId]}`);
  if (row && row.scrollIntoView) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function clearRoll(tableId) {
  delete lootRolled[tableId];
  render();
}

function tableHtml(table) {
  const items = visibleItems(table);
  if (!items.length) return '';
  const rolled = lootRolled[table.id];
  return `<section class="loot-table" id="loot-table-${escHtml(table.id)}">
    <header class="loot-table-head">
      <h2 class="loot-table-name">${escHtml(table.name)}</h2>
      <button class="loot-roll" onclick="rollTable('${escHtml(table.id)}')"
        title="Roll ${escHtml(table.die)} on this table"><svg class="btn-ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="15.5" cy="15.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/></svg>${escHtml(table.die)}</button>
      ${rolled ? `<button class="loot-clear" onclick="clearRoll('${escHtml(table.id)}')" title="Clear the roll">✕</button>` : ''}
    </header>
    ${table.source ? `<p class="loot-source">${escHtml(table.source)}</p>` : ''}
    ${table.rule ? `<p class="loot-rule">${escHtml(table.rule)}</p>` : ''}
    ${table.note ? `<p class="loot-note">${escHtml(table.note)}</p>` : ''}
    <div class="loot-rows">
      ${items.map(i => `<div class="loot-row${rolled === i.roll ? ' is-rolled' : ''}" id="loot-row-${escHtml(table.id)}-${escHtml(i.roll)}">
        <div class="loot-roll-num">${escHtml(i.roll)}</div>
        <div class="loot-body">
          <div class="loot-name">${escHtml(i.name)}<span class="loot-tier tier-${escHtml(i.tier)}">${escHtml(i.tier)}</span></div>
          <div class="loot-effect">${escHtml(i.effect)}</div>
          <div class="loot-hook"><span>Where it comes from</span>${escHtml(i.hook)}</div>
        </div>
      </div>`).join('')}
    </div>
  </section>`;
}

// A rail of every table, with its die and how many rows are showing. Added
// when the file went from eight tables to twelve and 82 items to 194: at that
// size the page is a long scroll, and a DM who wants the chop shop should not
// have to find it. During a search the counts become hit counts, which is the
// fastest way to see WHERE the thing you typed lives.
function renderRail() {
  const wrap = document.getElementById('loot-rail');
  if (!wrap) return;
  wrap.innerHTML = (lootDoc.tables || []).map(t => {
    const shown = visibleItems(t).length;
    return `<button class="loot-rail-btn${shown ? '' : ' no-hits'}"
      onclick="jumpToTable('${escHtml(t.id)}')" title="${escHtml(t.name)}">
      ${escHtml(railLabel(t.name))}
      <span class="loot-rail-n">${shown}</span>
    </button>`;
  }).join('');
}

// "Place — what it is" becomes "Place". A name with no dash is trimmed to
// something a pill can hold, with the full version left in the tooltip.
function railLabel(name) {
  const head = String(name).split(' — ')[0];
  return head.length <= 22 ? head : head.slice(0, 21).trimEnd() + '…';
}

function jumpToTable(id) {
  const el = document.getElementById('loot-table-' + id);
  if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderTiers() {
  const wrap = document.getElementById('loot-tiers');
  if (!wrap) return;
  const counts = new Map();
  for (const t of lootDoc.tables || []) for (const i of t.items || []) counts.set(i.tier, (counts.get(i.tier) || 0) + 1);
  const order = (lootDoc.tiers || [...counts.keys()]).filter(t => counts.has(t));
  wrap.innerHTML = `<button class="loot-tier-btn${lootTier ? '' : ' sel'}" onclick="filterTier(null)">All</button>`
    + order.map(t => `<button class="loot-tier-btn tier-${escHtml(t)}${lootTier === t ? ' sel' : ''}"
        onclick="filterTier('${escHtml(t)}')">${escHtml(t)} <b>${counts.get(t)}</b></button>`).join('');
}

function render() {
  renderTiers();
  renderRail();
  const wrap = document.getElementById('loot-tables');
  const empty = document.getElementById('loot-empty');
  const html = (lootDoc.tables || []).map(tableHtml).join('');
  if (wrap) wrap.innerHTML = html;
  if (empty) empty.style.display = html ? 'none' : '';
  const count = document.getElementById('loot-count');
  if (count) {
    const shown = (lootDoc.tables || []).reduce((n, t) => n + visibleItems(t).length, 0);
    const all = (lootDoc.tables || []).reduce((n, t) => n + (t.items || []).length, 0);
    count.textContent = shown === all ? `${all} items` : `${shown} of ${all}`;
  }
}

async function init() {
  try {
    const res = await fetch('CAMPAIGN/loot.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('bad status');
    lootDoc = await res.json();
    if (!Array.isArray(lootDoc.tables)) throw new Error('no tables');
  } catch {
    document.getElementById('load-error-banner').style.display = '';
    return;
  }
  render();
}

init();
