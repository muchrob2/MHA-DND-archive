// Page logic for shop.html. Extracted from the HTML so it can be linted,
// diffed and tested directly rather than regex-scraped out of markup.
// Loaded as a CLASSIC script, not a module: the page wires controls with
// inline onclick= handlers that resolve against globals, and top-level
// declarations here become globals exactly as they did inline. type="module"
// would scope them and silently break every handler.
//
// Runs after auth.js, so fbAuthReady is already defined.
//
// The catalogue is data, not code — see CAMPAIGN/shop-catalog.json, which
// holds every entry in the handbook that carries a printed Yen price.
// Purchases are written into the same shared character bundle the Class 1-A
// toolkit reads (`mha-dnd/relationships-bundle`), so a bought item shows up
// on the Inventory tab without anyone reloading.

const db = firebase.firestore();
const FS_BUNDLE_DOC = db.collection('mha-dnd').doc('relationships-bundle');

// Kept in step with CLASS-1A/relationships.js. verify-inventory-grants.js
// asserts the three files still agree, since a drifted key would spend or
// credit a counter that the Inventory tab never renders.
const CURRENCY_KEYS = ['yen', 'pp', 'gp', 'ep', 'sp', 'cp'];
const CURRENCY_TO_YEN = { yen: 1, cp: 10, sp: 100, ep: 500, gp: 1000, pp: 10000 };
const CURRENCY_SHORT = { yen: '¥', pp: 'pp', gp: 'gp', ep: 'ep', sp: 'sp', cp: 'cp' };

let CATALOG = { items: [], categories: [] };
let ROSTER = [];
let BUNDLE = null;          // last known server copy of the character bundle
let canBuy = false;         // admin or editor; everyone else browses
let activeCategory = 'all';
let searchTerm = '';
let activeCharFile = null;
let buyingItem = null;

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function genId(prefix) {
  return prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function yen(n) { return '¥' + Number(n || 0).toLocaleString(); }

/* ── Wallet maths ──────────────────────────────────────────
   A purse holds six denominations, so "can they afford this" is a
   question about total value, not about the Yen field alone.

   spendFromWallet deliberately does NOT collapse the purse into one Yen
   figure and re-expand it: that would silently melt a player's platinum
   into small change on their first 500-Yen sandwich. It spends the way a
   person does — cash first, then whole coins that fit, and only breaks a
   larger coin when nothing smaller covers the remainder, putting the
   change back as Yen.

   Both are pure and top-level so scripts/verify-shop-purchases.js can
   drive them without a browser or a Firestore connection.
   ───────────────────────────────────────────────────────────── */
function walletTotalYen(currency) {
  return CURRENCY_KEYS.reduce((sum, k) => sum + (currency?.[k] || 0) * CURRENCY_TO_YEN[k], 0);
}

// Mutates `currency`. Returns true if the purse covered the cost, false if
// it could not — in which case nothing is deducted.
function spendFromWallet(currency, cost) {
  if (cost < 0) return false;
  if (walletTotalYen(currency) < cost) return false;
  let owed = cost;

  // 1. Loose Yen first.
  const fromYen = Math.min(currency.yen || 0, owed);
  currency.yen = (currency.yen || 0) - fromYen;
  owed -= fromYen;

  // 2. Whole coins, smallest denomination up, so the big coins survive.
  const ascending = ['cp', 'sp', 'ep', 'gp', 'pp'];
  for (const k of ascending) {
    if (owed <= 0) break;
    const rate = CURRENCY_TO_YEN[k];
    const use = Math.min(currency[k] || 0, Math.floor(owed / rate));
    if (use > 0) { currency[k] = (currency[k] || 0) - use; owed -= use * rate; }
  }

  // 3. A remainder smaller than any coin still held: break the smallest
  //    coin that covers it and keep the change as Yen. Step 2 guarantees
  //    every remaining coin is worth more than `owed`, and the total check
  //    above guarantees at least one such coin exists.
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
  return owed <= 0;
}

/* ── Applying a purchase ───────────────────────────────────
   What a purchase *does* depends on the entry's `kind`:
     item    — appends an inventory row (with a stable id, so the toolkit's
               merge layer treats it as an addition rather than replacing
               the whole array)
     part    — increments the matching crafting-part counter instead, since
               parts are quantities on the Inventory tab, not rows
     service — deducts money only. A hospital stay is not a thing you carry,
               and adding "Hospital Stay ×3" to a backpack reads as a bug.
   ───────────────────────────────────────────────────────────── */
function applyPurchase(inventory, entry, qty, unitPrice) {
  const cost = unitPrice * qty;
  inventory.currency = inventory.currency || { yen: 0, cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 };
  if (!spendFromWallet(inventory.currency, cost)) return { ok: false, cost };

  if (entry.kind === 'part') {
    inventory.parts = inventory.parts || {};
    inventory.parts[entry.partKey] = (inventory.parts[entry.partKey] || 0) + qty;
  } else if (entry.kind === 'item') {
    inventory.items = Array.isArray(inventory.items) ? inventory.items : [];
    inventory.items.push({
      id: genId('item'),
      name: entry.name,
      qty: qty,
      notes: itemNotes(entry),
    });
  }
  return { ok: true, cost };
}

// The line written into the inventory row's notes. Everything the handbook
// prints about the entry, so the sheet is usable without opening the shop.
function itemNotes(entry) {
  return [
    entry.damage,
    entry.range,
    entry.properties,
    entry.ammo,
    entry.stats,
    entry.turnaround ? 'Build/turnaround: ' + entry.turnaround : null,
    entry.effect,
    'Bought from the shop.',
  ].filter(Boolean).join(' · ');
}

function priceLabel(entry) {
  if (entry.price === 0) return 'School-issued';
  if (entry.priceMax) return yen(entry.price) + '–' + Number(entry.priceMax).toLocaleString();
  return yen(entry.price) + (entry.priceOpen ? '+' : '');
}

/* ── Character list ────────────────────────────────────────── */
// PCs first: this is a shop, and the overwhelmingly common case is a player
// spending their own character's money.
function sortedCharacters() {
  return ROSTER.slice().sort((a, b) => {
    if (!!a.is_pc !== !!b.is_pc) return a.is_pc ? -1 : 1;
    return a.id - b.id;
  });
}

function charOptionsHtml(selectedFile) {
  return sortedCharacters().map(s => {
    const inv = BUNDLE?.characters?.[s.file]?.inventory;
    const purse = inv ? ' — ' + yen(walletTotalYen(inv.currency)) : '';
    return `<option value="${escHtml(s.file)}" ${s.file === selectedFile ? 'selected' : ''}>${
      escHtml(s.name)}${s.is_pc ? ' (PC)' : ''}${purse}</option>`;
  }).join('');
}

function currentInventory(file) {
  return BUNDLE?.characters?.[file]?.inventory || null;
}

function renderWallet() {
  const sel = document.getElementById('wallet-char');
  sel.innerHTML = charOptionsHtml(activeCharFile);

  const inv = currentInventory(activeCharFile);
  const totalEl = document.getElementById('wallet-total');
  const breakdownEl = document.getElementById('wallet-breakdown');
  const noteEl = document.getElementById('wallet-note');

  if (!inv) {
    totalEl.textContent = '—';
    breakdownEl.textContent = '';
  } else {
    const cur = inv.currency || {};
    totalEl.textContent = yen(walletTotalYen(cur));
    breakdownEl.textContent = CURRENCY_KEYS
      .filter(k => (cur[k] || 0) > 0)
      .map(k => (k === 'yen' ? yen(cur[k]) : cur[k] + CURRENCY_SHORT[k]))
      .join(' · ');
  }

  noteEl.textContent = canBuy
    ? ''
    : 'Browsing only — sign in as a player or the DM to buy.';
  noteEl.className = canBuy ? '' : 'wallet-warn';
}

/* ── Catalogue rendering ───────────────────────────────────── */
function renderCategories() {
  const el = document.getElementById('shop-cats');
  const counts = {};
  for (const it of CATALOG.items) counts[it.category] = (counts[it.category] || 0) + 1;
  const chips = [`<button type="button" class="cat-chip${activeCategory === 'all' ? ' active' : ''}"
      onclick="onCategory('all')">All <span>${CATALOG.items.length}</span></button>`];
  for (const c of CATALOG.categories) {
    if (!counts[c.id]) continue;
    chips.push(`<button type="button" class="cat-chip${activeCategory === c.id ? ' active' : ''}"
      onclick="onCategory('${escHtml(c.id)}')">${escHtml(c.label)} <span>${counts[c.id]}</span></button>`);
  }
  el.innerHTML = chips.join('');
}

function visibleItems() {
  const q = searchTerm.trim().toLowerCase();
  return CATALOG.items.filter(it => {
    if (activeCategory !== 'all' && it.category !== activeCategory) return false;
    if (!q) return true;
    return [it.name, it.effect, it.properties, it.damage, it.stats]
      .filter(Boolean).join(' ').toLowerCase().includes(q);
  });
}

function renderGrid() {
  const items = visibleItems();
  const grid = document.getElementById('shop-grid');
  const empty = document.getElementById('shop-empty');
  const count = document.getElementById('shop-count');

  empty.style.display = items.length ? 'none' : '';
  count.textContent = items.length
    ? `${items.length} item${items.length === 1 ? '' : 's'}`
    : '';

  grid.innerHTML = items.map(it => {
    const chips = [
      it.damage ? `<span class="shop-chip shop-chip-dmg">${escHtml(it.damage)}</span>` : '',
      it.range ? `<span class="shop-chip">${escHtml(it.range)}</span>` : '',
      it.ammo ? `<span class="shop-chip">${escHtml(it.ammo)}</span>` : '',
      it.stats ? `<span class="shop-chip">${escHtml(it.stats)}</span>` : '',
      it.turnaround ? `<span class="shop-chip">⏱ ${escHtml(it.turnaround)}</span>` : '',
      it.unit ? `<span class="shop-chip">${escHtml(it.unit)}</span>` : '',
    ].filter(Boolean).join('');

    return `
    <div class="shop-card">
      <div class="shop-card-head">
        <span class="shop-name">${escHtml(it.name)}</span>
        <span class="shop-price">${escHtml(priceLabel(it))}</span>
      </div>
      ${it.properties ? `<div class="shop-props">${escHtml(it.properties)}</div>` : ''}
      ${chips ? `<div class="shop-chips">${chips}</div>` : ''}
      ${it.effect ? `<div class="shop-effect">${escHtml(it.effect)}</div>` : ''}
      <div class="shop-card-foot">
        <span class="shop-kind shop-kind-${escHtml(it.kind)}">${
          it.kind === 'part' ? 'crafting part' : it.kind === 'service' ? 'service' : 'inventory item'}</span>
        <button type="button" class="shop-buy" ${canBuy ? '' : 'disabled'}
          onclick="openBuy('${escHtml(it.id)}')">${canBuy ? 'Buy' : 'Sign in to buy'}</button>
      </div>
    </div>`;
  }).join('');
}

function onCategory(id) { activeCategory = id; renderCategories(); renderGrid(); }
function onSearch(v) { searchTerm = v; renderGrid(); }
function onCharChange(file) { activeCharFile = file; renderWallet(); }

/* ── Buy dialog ────────────────────────────────────────────── */
function openBuy(itemId) {
  if (!canBuy) return;
  buyingItem = CATALOG.items.find(i => i.id === itemId);
  if (!buyingItem) return;

  document.getElementById('buy-modal-title').textContent = 'Buy ' + buyingItem.name;
  document.getElementById('buy-item-line').innerHTML = [
    buyingItem.damage, buyingItem.stats, buyingItem.properties,
  ].filter(Boolean).join(' · ') || escHtml(buyingItem.effect || '');

  document.getElementById('buy-char').innerHTML = charOptionsHtml(activeCharFile);
  document.getElementById('buy-qty').value = 1;

  const priceInput = document.getElementById('buy-price');
  priceInput.value = buyingItem.price;
  // A fixed price is shown but locked; the handbook's ranged and open-ended
  // prices ("¥10,000–40,000", "¥250,000+") are the DM's call, so those stay
  // editable rather than silently charging the bottom of the range.
  const negotiable = !!(buyingItem.priceMax || buyingItem.priceOpen);
  priceInput.readOnly = !negotiable;
  priceInput.classList.toggle('locked', !negotiable);

  document.getElementById('buy-error').textContent = '';
  document.getElementById('buy-overlay').classList.add('open');
  refreshBuyMath();
}

function closeBuy() {
  document.getElementById('buy-overlay').classList.remove('open');
  buyingItem = null;
}

function readBuyForm() {
  const qty = Math.max(1, parseInt(document.getElementById('buy-qty').value, 10) || 1);
  const unit = Math.max(0, parseInt(document.getElementById('buy-price').value, 10) || 0);
  const file = document.getElementById('buy-char').value;
  return { qty, unit, file, cost: qty * unit };
}

// Live "can they afford it" readout. Advisory only — the authoritative check
// runs inside the transaction against server state, because this page's copy
// of the purse can be seconds old and two tabs must not both spend it.
function refreshBuyMath() {
  if (!buyingItem) return;
  const { qty, unit, file, cost } = readBuyForm();
  const inv = currentInventory(file);
  const have = inv ? walletTotalYen(inv.currency) : 0;
  const after = have - cost;
  const el = document.getElementById('buy-math');
  const confirmBtn = document.getElementById('buy-confirm');

  if (!inv) {
    el.innerHTML = `<span class="buy-warn">That character has no sheet in the shared bundle yet — open the Class 1-A toolkit and save once first.</span>`;
    confirmBtn.disabled = true;
    return;
  }
  const short = after < 0;
  el.innerHTML = `
    <div class="buy-math-row"><span>${qty} × ${yen(unit)}</span><strong>${yen(cost)}</strong></div>
    <div class="buy-math-row"><span>Purse</span><span>${yen(have)}</span></div>
    <div class="buy-math-row ${short ? 'buy-warn' : 'buy-ok'}">
      <span>${short ? 'Short by' : 'After purchase'}</span>
      <strong>${yen(Math.abs(after))}</strong>
    </div>`;
  confirmBtn.disabled = short;
}

async function confirmPurchase() {
  if (!buyingItem) return;
  const entry = buyingItem;
  const { qty, unit, file, cost } = readBuyForm();
  const errEl = document.getElementById('buy-error');
  const confirmBtn = document.getElementById('buy-confirm');
  errEl.textContent = '';
  confirmBtn.disabled = true;

  try {
    // Read, check and deduct all inside one transaction. Checking against
    // the page's cached purse instead would let two open tabs each see the
    // same balance and both spend it.
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(FS_BUNDLE_DOC);
      if (!snap.exists) throw new Error('No character bundle found — open the Class 1-A toolkit and save once first.');
      const data = snap.data();
      const characters = data.characters || {};
      const character = characters[file];
      if (!character) throw new Error('That character has no sheet in the shared bundle yet.');

      character.inventory = character.inventory || {};
      const result = applyPurchase(character.inventory, entry, qty, unit);
      if (!result.ok) {
        throw new Error('Not enough money — the purse holds ' +
          yen(walletTotalYen(character.inventory.currency)) + '.');
      }
      tx.set(FS_BUNDLE_DOC, Object.assign({}, data, { characters }));
    });

    const who = (ROSTER.find(s => s.file === file) || {}).name || file;
    logReceipt(`${qty} × ${entry.name} → ${who} (${yen(cost)})`);
    closeBuy();
    await refreshBundle();
  } catch (e) {
    errEl.textContent = e.message;
  } finally {
    confirmBtn.disabled = false;
    refreshBuyMath();
  }
}

function logReceipt(text) {
  const wrap = document.getElementById('receipt-wrap');
  const list = document.getElementById('receipt-log');
  wrap.style.display = '';
  const li = document.createElement('li');
  li.textContent = `${new Date().toLocaleTimeString()} — ${text}`;
  list.prepend(li);
}

/* ── Data loading ──────────────────────────────────────────── */
async function refreshBundle() {
  try {
    const snap = await FS_BUNDLE_DOC.get();
    BUNDLE = snap.exists ? snap.data() : null;
  } catch {
    BUNDLE = null;
  }
  renderWallet();
}

document.addEventListener('auth-state-changed', (e) => {
  // Matches the Class 1-A toolkit's own rule (see canWrite there): an editor
  // may spend, a pending or signed-out visitor may only browse. Firestore
  // rules enforce this for real; this only decides what the page offers.
  canBuy = e.detail.role === 'admin' || e.detail.role === 'editor';
  renderWallet();
  renderGrid();
});

(async () => {
  const [catalog, roster] = await Promise.all([
    fetch('CAMPAIGN/shop-catalog.json').then(r => r.json()).catch(() => null),
    fetch('CLASS-1A/roster.json').then(r => r.json()).catch(() => null),
  ]);
  if (catalog) CATALOG = catalog;
  ROSTER = (roster?.students || []).filter(s => s.file);
  activeCharFile = (sortedCharacters()[0] || {}).file || null;

  renderCategories();
  renderGrid();

  await fbAuthReady;
  await refreshBundle();

  // Keep the purse honest while the page is open: the DM may grant money
  // from the admin page, or the player may spend from their own sheet.
  FS_BUNDLE_DOC.onSnapshot((snap) => {
    if (!snap.exists || snap.metadata?.fromCache) return;
    BUNDLE = snap.data();
    renderWallet();
    if (buyingItem) refreshBuyMath();
  }, err => console.error('[shop] live sync stopped:', err));
})();

/* ── Modal chrome ──────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  const overlay = document.getElementById('buy-overlay');
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeBuy(); });
  const closeBtn = document.getElementById('buy-modal-close');
  closeBtn.addEventListener('click', closeBuy);
  closeBtn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); closeBuy(); }
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('buy-overlay')?.classList.contains('open')) closeBuy();
});
