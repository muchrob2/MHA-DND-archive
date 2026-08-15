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

/* ── Basket ────────────────────────────────────────────────
   Stored as [{ id, qty, unitPrice }] — catalogue ids and numbers only,
   never whole entries. The catalogue is the source of truth for names,
   stats and prices; a basket holding its own copy would quietly serve a
   stale one after the catalogue is edited.

   Deliberately client-side and NOT in Firestore. A basket is one person's
   unfinished intent, not shared campaign state: syncing it would put two
   players in the same trolley, and a half-built list is exactly the sort
   of thing that should evaporate rather than sync. It survives a reload
   via localStorage and nothing more.

   One basket, not one per character. Switching who is paying re-costs the
   same list against a different purse, which is what a DM kitting out
   several students actually wants.
   ───────────────────────────────────────────────────────────── */
const BASKET_KEY = 'mha-shop-basket';
let basket = [];

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

/* ── Applying a basket ─────────────────────────────────────
   What a line *does* depends on its entry's `kind`:
     item    — appends an inventory row (with a stable id, so the toolkit's
               merge layer treats it as an addition rather than replacing
               the whole array)
     part    — increments the matching crafting-part counter instead, since
               parts are quantities on the Inventory tab, not rows
     service — deducts money only. A hospital stay is not a thing you carry,
               and adding "Hospital Stay ×3" to a backpack reads as a bug.

   A basket checks out as ONE all-or-nothing spend rather than as a series
   of individual purchases. Spending per line would let a basket half
   succeed — the first few items delivered, the rest refused when the money
   ran out — which is both surprising and annoying to unpick by hand. It
   also makes the affordability question match what the drawer shows the
   buyer: one total against one purse.
   ───────────────────────────────────────────────────────────── */
function lineCost(line) { return line.unitPrice * line.qty; }

function basketTotal(lines) {
  return (lines || []).reduce((sum, l) => sum + lineCost(l), 0);
}

function applyLineEffect(inventory, entry, qty) {
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
  // services: money only, handled by the single spend below
}

// `lines` is [{ entry, qty, unitPrice }]. Mutates `inventory`; on failure it
// mutates nothing, so a refused checkout leaves the sheet exactly as it was.
function applyBasket(inventory, lines) {
  const total = basketTotal(lines);
  inventory.currency = inventory.currency || { yen: 0, cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 };
  if (!spendFromWallet(inventory.currency, total)) return { ok: false, total };
  for (const line of lines) applyLineEffect(inventory, line.entry, line.qty);
  return { ok: true, total };
}

// Single-line convenience, kept so a one-off purchase has an obvious call
// and so the basket path and the single path can never diverge.
function applyPurchase(inventory, entry, qty, unitPrice) {
  const res = applyBasket(inventory, [{ entry, qty, unitPrice }]);
  return { ok: res.ok, cost: res.total };
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

// Remembers the last options markup written into the character picker. The
// bundle listener fires on every edit anyone makes to any character, and
// re-assigning a <select>'s innerHTML closes it mid-choice and drops the
// highlighted option — so the picker is only rewritten when it would
// actually differ.
let _lastCharOptions = '';

function renderWallet() {
  const sel = document.getElementById('wallet-char');
  const optionsHtml = charOptionsHtml(activeCharFile);
  if (optionsHtml !== _lastCharOptions) {
    sel.innerHTML = optionsHtml;
    _lastCharOptions = optionsHtml;
  }

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

  // The purse just moved (or a different character was selected), which is
  // exactly when what they can afford changes.
  applyAffordability();
}

/* ── Catalogue rendering ───────────────────────────────────── */
function renderCategories() {
  const el = document.getElementById('shop-cats');
  const counts = {};
  for (const it of CATALOG.items) counts[it.category] = (counts[it.category] || 0) + 1;
  const chip = (id, label, icon, n) => `<button type="button"
      class="cat-chip${activeCategory === id ? ' active' : ''}" onclick="onCategory('${escHtml(id)}')"
      >${icon ? `<span class="cat-ico">${icon}</span>` : ''}<span>${escHtml(label)}</span><span class="cat-n">${n}</span></button>`;

  const chips = [chip('all', 'Everything', '✦', CATALOG.items.length)];
  for (const c of CATALOG.categories) {
    if (!counts[c.id]) continue;
    chips.push(chip(c.id, c.label, CATEGORY_ICONS[c.id] || '', counts[c.id]));
  }
  el.innerHTML = chips.join('');
}

// Pure, so the filter rules can be tested without a DOM, and so the count and
// the visibility toggle below can never disagree about what is showing.
function visibleItems() {
  const q = searchTerm.trim().toLowerCase();
  return CATALOG.items.filter(it => {
    if (activeCategory !== 'all' && it.category !== activeCategory) return false;
    if (!q) return true;
    return searchHaystack(it).includes(q);
  });
}

function searchHaystack(it) {
  return [it.name, it.effect, it.properties, it.damage, it.stats]
    .filter(Boolean).join(' ').toLowerCase();
}

// Purely decorative — the category rail reads much faster with a glyph than
// with thirteen similarly-shaped words. Kept in the page rather than in
// shop-catalog.json: the catalogue is game data, this is presentation.
const CATEGORY_ICONS = {
  firearms: '🔫', melee: '⚔', explosives: '💥', parts: '⚙',
  'suits-pro': '🦸', 'suits-student': '🎓', gear: '🧰', provisions: '🍱',
  licenses: '📋', medical: '🏥', training: '🥋', media: '📺', underworld: '🕶',
};

function cardHtml(it) {
  const chips = [
    it.damage ? `<span class="shop-chip shop-chip-dmg">${escHtml(it.damage)}</span>` : '',
    it.range ? `<span class="shop-chip">${escHtml(it.range)}</span>` : '',
    it.ammo ? `<span class="shop-chip">${escHtml(it.ammo)}</span>` : '',
    it.stats ? `<span class="shop-chip">${escHtml(it.stats)}</span>` : '',
    it.turnaround ? `<span class="shop-chip">⏱ ${escHtml(it.turnaround)}</span>` : '',
    it.unit ? `<span class="shop-chip">${escHtml(it.unit)}</span>` : '',
  ].filter(Boolean).join('');

  // The inner <span> counters the price slab's skew so the digits stay
  // upright inside a slanted tag.
  return `
    <article class="shop-card${it.price === 0 ? ' is-free' : ''}"
             data-id="${escHtml(it.id)}" data-cat="${escHtml(it.category)}">
      <div class="shop-card-top">
        <h3 class="shop-name">${escHtml(it.name)}</h3>
        <div class="shop-price"><span>${escHtml(priceLabel(it))}</span></div>
      </div>
      ${it.properties ? `<div class="shop-props">${escHtml(it.properties)}</div>` : ''}
      ${chips ? `<div class="shop-chips">${chips}</div>` : ''}
      ${it.effect ? `<p class="shop-effect">${escHtml(it.effect)}</p>` : ''}
      <div class="shop-card-foot">
        <span class="shop-kind shop-kind-${escHtml(it.kind)}">${
          it.kind === 'part' ? 'crafting part' : it.kind === 'service' ? 'service' : 'inventory item'}</span>
        <button type="button" class="shop-buy" ${canBuy ? '' : 'disabled'}
          onclick="basketAdd('${escHtml(it.id)}')">${canBuy ? '+ Add' : 'Sign in'}</button>
      </div>
    </article>`;
}

/* The whole catalogue is built into the DOM exactly once, and searching or
   switching category only flips each card's `hidden` flag.

   The obvious implementation — rebuild innerHTML from the filtered list on
   every keystroke — re-parses ~50 KB of markup and re-lays-out 84 cards for
   each character typed, and throws away scroll position while doing it.
   Toggling a boolean on 84 existing nodes costs a fraction of that and keeps
   the page still under the cursor. At this catalogue size neither approach is
   slow, but only one of them stays that way as entries are added. */
function renderGrid() {
  const grid = document.getElementById('shop-grid');
  grid.innerHTML = CATALOG.items.map(cardHtml).join('');
  applyFilter();
  applyAffordability();
  applyBasketBadges();
}

function applyFilter() {
  const shown = visibleItems();
  const shownIds = new Set(shown.map(i => i.id));
  const grid = document.getElementById('shop-grid');
  const cards = grid.querySelectorAll('.shop-card');
  for (let i = 0; i < cards.length; i++) {
    cards[i].hidden = !shownIds.has(cards[i].dataset.id);
  }
  document.getElementById('shop-empty').style.display = shown.length ? 'none' : '';
  document.getElementById('shop-count').textContent =
    shown.length ? `${shown.length} item${shown.length === 1 ? '' : 's'}` : '';
}

// Marks what the selected character cannot currently afford. Advisory only —
// the card stays readable and its button still opens the dialog, which
// explains the shortfall in Yen rather than just refusing.
//
// Kept out of applyFilter deliberately: affordability changes when the
// character or their purse changes, not on every keystroke, so pairing it
// with the search path would do this work for nothing on each character typed.
function applyAffordability() {
  const inv = currentInventory(activeCharFile);
  const purse = inv ? walletTotalYen(inv.currency) : 0;
  const priceById = new Map(CATALOG.items.map(i => [i.id, i.price]));
  const cards = document.getElementById('shop-grid').querySelectorAll('.shop-card');
  for (let i = 0; i < cards.length; i++) {
    const price = priceById.get(cards[i].dataset.id);
    // No sheet loaded yet means "unknown", not "broke" — don't grey the whole
    // catalogue out while the bundle is still in flight.
    const locked = inv != null && price != null && price > purse;
    cards[i].classList.toggle('is-locked', locked);
  }
}

function onCategory(id) { activeCategory = id; renderCategories(); applyFilter(); }
function onSearch(v) { searchTerm = v; applyFilter(); }
function onCharChange(file) { activeCharFile = file; renderWallet(); }

/* ── Basket state ──────────────────────────────────────────── */
function entryById(id) { return CATALOG.items.find(i => i.id === id) || null; }

// Whether the handbook leaves this one's price open. Fixed prices are not up
// for debate; ranged ("¥10,000–40,000") and open-ended ("¥250,000+") ones are
// the DM's call, so those stay editable rather than silently charging the
// bottom of the range.
function isNegotiable(entry) { return !!(entry && (entry.priceMax || entry.priceOpen)); }

function saveBasket() {
  try { localStorage.setItem(BASKET_KEY, JSON.stringify(basket)); } catch {}
}

function loadBasket() {
  let raw = null;
  try { raw = localStorage.getItem(BASKET_KEY); } catch {}
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    // Drop anything whose catalogue entry has since disappeared, and clamp
    // the numbers: this came from storage a user can edit by hand.
    basket = parsed
      .filter(l => l && entryById(l.id))
      .map(l => ({
        id: l.id,
        qty: Math.max(1, Math.min(999, parseInt(l.qty, 10) || 1)),
        unitPrice: Math.max(0, parseInt(l.unitPrice, 10) || entryById(l.id).price),
      }));
  } catch {}
}

// Resolves stored lines against the live catalogue: [{ entry, qty, unitPrice }]
function basketLines() {
  return basket.map(l => ({ entry: entryById(l.id), qty: l.qty, unitPrice: l.unitPrice }))
               .filter(l => l.entry);
}
function basketCount() { return basket.reduce((n, l) => n + l.qty, 0); }

function basketAdd(id) {
  if (!canBuy) return;
  const entry = entryById(id);
  if (!entry) return;
  const line = basket.find(l => l.id === id);
  if (line) line.qty = Math.min(999, line.qty + 1);
  else basket.push({ id, qty: 1, unitPrice: entry.price });
  saveBasket();
  renderBasket();
  applyBasketBadges();
  flashBasketTab();
}

function basketSetQty(id, value) {
  const qty = Math.max(0, Math.min(999, parseInt(value, 10) || 0));
  const idx = basket.findIndex(l => l.id === id);
  if (idx === -1) return;
  if (qty === 0) basket.splice(idx, 1);
  else basket[idx].qty = qty;
  saveBasket();
  renderBasket();
  applyBasketBadges();
}

function basketStep(id, delta) {
  const line = basket.find(l => l.id === id);
  if (line) basketSetQty(id, line.qty + delta);
}

function basketSetPrice(id, value) {
  const line = basket.find(l => l.id === id);
  if (!line) return;
  line.unitPrice = Math.max(0, parseInt(value, 10) || 0);
  saveBasket();
  renderBasketTotals();   // not a full re-render: the caret is in this field
}

function basketRemove(id) {
  basket = basket.filter(l => l.id !== id);
  saveBasket();
  renderBasket();
  applyBasketBadges();
}

function basketClear() {
  if (basket.length && !confirm('Empty the basket?')) return;
  basket = [];
  saveBasket();
  renderBasket();
  applyBasketBadges();
}

/* ── Basket rendering ──────────────────────────────────────── */
function openBasket()  { document.getElementById('basket-overlay').classList.add('open'); renderBasket(); }
function closeBasket() { document.getElementById('basket-overlay').classList.remove('open'); }

function flashBasketTab() {
  const tab = document.getElementById('basket-tab');
  if (!tab) return;
  tab.classList.remove('bump');
  // reading offsetWidth restarts the animation rather than letting a second
  // add within its duration do nothing
  void tab.offsetWidth;
  tab.classList.add('bump');
}

function renderBasketTab() {
  const tab = document.getElementById('basket-tab');
  const n = basketCount();
  tab.hidden = !canBuy;
  document.getElementById('basket-tab-count').textContent = n;
  document.getElementById('basket-tab-total').textContent = yen(basketTotal(basketLines()));
  tab.classList.toggle('empty', n === 0);
}

function renderBasket() {
  renderBasketTab();
  const listEl = document.getElementById('basket-list');
  const lines = basketLines();

  if (!lines.length) {
    listEl.innerHTML = `<div class="basket-empty">Nothing in the basket yet.<br>Add something from the catalogue.</div>`;
  } else {
    listEl.innerHTML = lines.map(l => {
      const negotiable = isNegotiable(l.entry);
      return `
      <div class="basket-line" data-cat="${escHtml(l.entry.category)}">
        <div class="basket-line-main">
          <span class="basket-line-name">${escHtml(l.entry.name)}</span>
          <button type="button" class="basket-x" title="Remove" aria-label="Remove ${escHtml(l.entry.name)}"
            onclick="basketRemove('${escHtml(l.entry.id)}')">✕</button>
        </div>
        <div class="basket-line-controls">
          <div class="basket-stepper">
            <button type="button" onclick="basketStep('${escHtml(l.entry.id)}',-1)" aria-label="One fewer">−</button>
            <input type="number" min="0" max="999" value="${l.qty}"
              onchange="basketSetQty('${escHtml(l.entry.id)}',this.value)" aria-label="Quantity">
            <button type="button" onclick="basketStep('${escHtml(l.entry.id)}',1)" aria-label="One more">+</button>
          </div>
          <label class="basket-price">
            <span>¥</span>
            <input type="number" min="0" step="100" value="${l.unitPrice}" ${negotiable ? '' : 'readonly'}
              class="${negotiable ? '' : 'locked'}"
              title="${negotiable ? 'Handbook gives a range — set the price' : 'Fixed handbook price'}"
              oninput="basketSetPrice('${escHtml(l.entry.id)}',this.value)" aria-label="Unit price">
          </label>
          <span class="basket-line-total">${yen(lineCost(l))}</span>
        </div>
      </div>`;
    }).join('');
  }

  document.getElementById('basket-char').innerHTML = charOptionsHtml(activeCharFile);
  renderBasketTotals();
}

// Split out so editing a price does not rebuild the list under the caret.
function renderBasketTotals() {
  const lines = basketLines();
  const total = basketTotal(lines);
  const file = document.getElementById('basket-char').value || activeCharFile;
  const inv = currentInventory(file);
  const have = inv ? walletTotalYen(inv.currency) : 0;
  const after = have - total;
  const short = after < 0;

  const mathEl = document.getElementById('basket-math');
  const btn = document.getElementById('basket-checkout');

  // Line totals track a price edit without a full re-render.
  const els = document.querySelectorAll('.basket-line-total');
  for (let i = 0; i < els.length && i < lines.length; i++) {
    els[i].textContent = yen(lineCost(lines[i]));
  }

  if (!lines.length) {
    mathEl.innerHTML = '';
    btn.disabled = true;
    btn.textContent = 'Checkout';
    return;
  }
  if (!inv) {
    mathEl.innerHTML = `<div class="buy-math-row buy-warn"><span>That character has no sheet in the shared bundle yet — open the Class 1-A toolkit and save once first.</span></div>`;
    btn.disabled = true;
    return;
  }

  mathEl.innerHTML = `
    <div class="buy-math-row"><span>${basketCount()} item${basketCount() === 1 ? '' : 's'}</span><strong>${yen(total)}</strong></div>
    <div class="buy-math-row"><span>Purse</span><span>${yen(have)}</span></div>
    <div class="buy-math-row ${short ? 'buy-warn' : 'buy-ok'}">
      <span>${short ? 'Short by' : 'Left after'}</span><strong>${yen(Math.abs(after))}</strong>
    </div>`;
  btn.disabled = short;
  btn.textContent = short ? 'Not enough money' : 'Checkout';
}

function onBasketCharChange(file) {
  // Keep the two character pickers in step; the drawer's is just a second
  // view of the same choice.
  activeCharFile = file;
  renderWallet();
  renderBasketTotals();
}

// Reflects basket membership back onto the catalogue cards, so you can see
// what is already in the trolley without opening it.
function applyBasketBadges() {
  const inBasket = new Map(basket.map(l => [l.id, l.qty]));
  const cards = document.getElementById('shop-grid').querySelectorAll('.shop-card');
  for (let i = 0; i < cards.length; i++) {
    const qty = inBasket.get(cards[i].dataset.id);
    cards[i].classList.toggle('in-basket', qty != null);
    const btn = cards[i].querySelector('.shop-buy');
    if (btn && canBuy) btn.textContent = qty != null ? `In basket · ${qty}` : '+ Add';
  }
}

/* ── Checkout ──────────────────────────────────────────────── */
async function checkout() {
  const lines = basketLines();
  if (!lines.length) return;
  const file = document.getElementById('basket-char').value || activeCharFile;
  const errEl = document.getElementById('basket-error');
  const btn = document.getElementById('basket-checkout');
  errEl.textContent = '';
  btn.disabled = true;

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
      const result = applyBasket(character.inventory, lines);
      if (!result.ok) {
        throw new Error('Not enough money — the purse holds ' +
          yen(walletTotalYen(character.inventory.currency)) + '.');
      }
      tx.set(FS_BUNDLE_DOC, Object.assign({}, data, { characters }));
    });

    const who = (ROSTER.find(s => s.file === file) || {}).name || file;
    const total = basketTotal(lines);
    for (const l of lines) logReceipt(`${l.qty} × ${l.entry.name} → ${who} (${yen(lineCost(l))})`);
    logReceipt(`— checkout total ${yen(total)} —`);

    // Only cleared once the write has committed. Clearing optimistically
    // would lose the list on any failure, and a rebuilt basket is far more
    // irritating than a second click.
    basket = [];
    saveBasket();
    renderBasket();
    applyBasketBadges();
    closeBasket();
    await refreshBundle();
  } catch (e) {
    errEl.textContent = e.message;
  } finally {
    btn.disabled = false;
    renderBasketTotals();
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
  renderBasket();
});

(async () => {
  const [catalog, roster] = await Promise.all([
    fetch('CAMPAIGN/shop-catalog.json').then(r => r.json()).catch(() => null),
    fetch('CLASS-1A/roster.json').then(r => r.json()).catch(() => null),
  ]);
  if (catalog) CATALOG = catalog;
  ROSTER = (roster?.students || []).filter(s => s.file);
  activeCharFile = (sortedCharacters()[0] || {}).file || null;

  loadBasket();   // after CATALOG, which loadBasket validates ids against
  renderCategories();
  renderGrid();
  renderBasket();

  await fbAuthReady;
  await refreshBundle();

  // Keep the purse honest while the page is open: the DM may grant money
  // from the admin page, or the player may spend from their own sheet.
  FS_BUNDLE_DOC.onSnapshot((snap) => {
    if (!snap.exists || snap.metadata?.fromCache) return;
    BUNDLE = snap.data();
    renderWallet();
    renderBasketTotals();   // the purse moved; the checkout maths must follow
  }, err => console.error('[shop] live sync stopped:', err));
})();

/* ── Drawer chrome ─────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  const overlay = document.getElementById('basket-overlay');
  // Clicking the scrim closes; clicking inside the drawer must not.
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeBasket(); });
  const closeBtn = document.getElementById('basket-close');
  closeBtn.addEventListener('click', closeBasket);
  closeBtn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); closeBasket(); }
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('basket-overlay')?.classList.contains('open')) closeBasket();
});
