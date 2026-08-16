/* Cloud Functions for the MHA D&D archive.
 *
 * ── Why this exists ────────────────────────────────────────────────
 * Everything else in this project is a static site talking straight to
 * Firestore, and that works because the stakes are low: a wrong
 * relationship score is a typo, not an exploit. Money is different. The
 * client cannot be trusted to say "I paid for this", because the client
 * is a web page the player controls.
 *
 * Firestore rules cannot close that on their own. A purchase and a
 * hand-edit are the same shape of write from the same client — one map
 * inside one document changing — and the rules language has no loops, so
 * it cannot walk twenty characters to check that only the caller's
 * inventory moved and only downwards.
 *
 * So inventory moves out of the player-writable character bundle into
 * `inventories/{characterFile}`, which NO client may write (see
 * firestore.rules). Only these functions touch it, through the Admin
 * SDK, which bypasses rules. Prices come from the catalogue bundled
 * beside this file, never from the request — otherwise a player would
 * simply ask to buy a katana for ¥1.
 *
 * ── What is enforced here ──────────────────────────────────────────
 *   · the caller is signed in and their users/{uid} role is real
 *   · an editor may only spend from a character they are assigned
 *   · the price is the server's price, for a real catalogue id
 *   · the purse actually covers it, checked inside the transaction
 *   · the ledger entry is written in the same transaction as the spend
 *
 * ── Deploying ──────────────────────────────────────────────────────
 *   npm --prefix functions install
 *   npm run sync-functions-data        # copies the catalogue + roster in
 *   firebase deploy --only functions,firestore:rules
 *
 * Requires the Blaze plan. Callable functions are billed per invocation;
 * at five players buying lunch this rounds to nothing, but the plan does
 * need a card on file.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const CATALOG = require('./data/shop-catalog.json');
const ROSTER = require('./data/roster.json');
const EATS_MENU = require('./data/eats-menu.json');

initializeApp();
const db = getFirestore();

const BUNDLE_DOC = db.collection('mha-dnd').doc('relationships-bundle');
const LEDGER_DOC = db.collection('mha-dnd').doc('ledger');
const inventoryDoc = (file) => db.collection('inventories').doc(file);

/* ── Money ──────────────────────────────────────────────────────────
   Kept identical to shop.js and heropad.js; scripts/verify-eats.js
   compares every copy against the others. The rule matters: spending
   cash first and breaking a large coin only as a last resort is what
   stops a ¥500 sandwich melting someone's platinum into change. */
const CURRENCY_KEYS = ['yen', 'pp', 'gp', 'ep', 'sp', 'cp'];
const CURRENCY_TO_YEN = { yen: 1, cp: 10, sp: 100, ep: 500, gp: 1000, pp: 10000 };
const MAX_LEDGER_ENTRIES = 400;

function walletTotalYen(currency) {
  return CURRENCY_KEYS.reduce((sum, k) => sum + ((currency && currency[k]) || 0) * CURRENCY_TO_YEN[k], 0);
}

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

function genId(prefix) {
  return prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function ledgerEntry(file, kind, label, unit, amount, yenValue) {
  return { id: genId('led'), ts: Date.now(), file, kind, label, unit, amount, yen: yenValue };
}

function appendToLedger(snap, additions) {
  const data = (snap && snap.exists && snap.data()) || {};
  const existing = Array.isArray(data.entries) ? data.entries : [];
  const merged = existing.concat(additions);
  return Object.assign({}, data, {
    entries: merged.length > MAX_LEDGER_ENTRIES ? merged.slice(merged.length - MAX_LEDGER_ENTRIES) : merged,
  });
}

/* ── Who is asking ──────────────────────────────────────────────────
   Never trust a role sent in the request body. The caller's uid comes
   from the verified auth token; the role is read fresh from Firestore
   on every call, so revoking someone takes effect immediately rather
   than whenever their client happens to reload. */
async function requireCaller(request) {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first.');
  const snap = await db.collection('users').doc(uid).get();
  const data = snap.exists ? snap.data() : {};
  const role = data.role || 'pending';
  if (role !== 'admin' && role !== 'editor') {
    throw new HttpsError('permission-denied', 'Your account is not approved yet.');
  }
  return { uid, role, editableCharacterIds: data.editableCharacterIds || [] };
}

// An editor may only spend from a character the DM assigned them. Admins
// may act for anyone, which is what the grant panel needs.
function requireCharacterAccess(caller, file) {
  const student = (ROSTER.students || []).find((s) => s.file === file);
  if (!student) throw new HttpsError('invalid-argument', 'Unknown character.');
  if (caller.role === 'admin') return student;
  if (!caller.editableCharacterIds.includes(student.id)) {
    throw new HttpsError('permission-denied', 'That is not your character.');
  }
  return student;
}

/* ── Reading an inventory ───────────────────────────────────────────
   During the migration a character may not have been moved out of the
   bundle yet, so a missing inventories/{file} falls back to the copy in
   the bundle rather than handing someone an empty purse. Once
   migrateInventories has run, the fallback never fires. */
async function readInventory(tx, file) {
  const invSnap = await tx.get(inventoryDoc(file));
  if (invSnap.exists) return invSnap.data() || {};
  const bundleSnap = await tx.get(BUNDLE_DOC);
  const characters = (bundleSnap.exists && bundleSnap.data().characters) || {};
  const character = characters[file];
  if (!character) throw new HttpsError('failed-precondition',
    'That character has no sheet yet — open the Class 1-A toolkit and save once.');
  return character.inventory || {};
}

function priceOf(source, id) {
  if (source === 'eats') {
    const item = (EATS_MENU.items || []).find((m) => m.id === id);
    return item ? { name: item.name, price: item.price } : null;
  }
  const item = (CATALOG.items || []).find((m) => m.id === id);
  if (!item) return null;
  // Open-ended and ranged prices are DM judgement calls, not something a
  // client may resolve for itself.
  if (item.priceOpen || item.priceMax) return null;
  return { name: item.name, price: item.price };
}

/* ══ spend ══════════════════════════════════════════════════════════
   The only way money leaves a purse. Takes catalogue ids and
   quantities — never prices — and returns the new balance. */
exports.spend = onCall(async (request) => {
  const caller = await requireCaller(request);
  const { characterFile, lines, source } = request.data || {};
  requireCharacterAccess(caller, characterFile);

  if (source !== 'shop' && source !== 'eats') {
    throw new HttpsError('invalid-argument', 'Unknown source.');
  }
  if (!Array.isArray(lines) || !lines.length || lines.length > 50) {
    throw new HttpsError('invalid-argument', 'Nothing to buy.');
  }

  // Resolve every line against the server's own prices before touching
  // anything, so a bad id fails before a partial spend.
  const resolved = lines.map((l) => {
    const qty = Math.floor(Number(l && l.qty) || 0);
    if (qty < 1 || qty > 99) throw new HttpsError('invalid-argument', 'Bad quantity.');
    const entry = priceOf(source, l && l.id);
    if (!entry) throw new HttpsError('invalid-argument', `Not for sale here: ${l && l.id}`);
    return { qty, name: entry.name, cost: entry.price * qty };
  });
  const total = resolved.reduce((sum, r) => sum + r.cost, 0);

  const result = await db.runTransaction(async (tx) => {
    const inventory = await readInventory(tx, characterFile);
    const ledgerSnap = await tx.get(LEDGER_DOC);

    inventory.currency = inventory.currency || {};
    if (!spendFromWallet(inventory.currency, total)) {
      throw new HttpsError('failed-precondition',
        'Not enough money — the purse holds ¥' + walletTotalYen(inventory.currency).toLocaleString() + '.');
    }

    if (source === 'shop') {
      inventory.items = Array.isArray(inventory.items) ? inventory.items : [];
      for (const r of resolved) {
        inventory.items.push({ id: genId('item'), name: r.name, qty: r.qty, notes: 'Bought in the Shop' });
      }
    }

    const additions = resolved.map((r) => ledgerEntry(
      characterFile, 'purchase',
      source === 'eats' ? `Eats · ${r.name}` : `${r.qty} × ${r.name}`,
      'yen', -r.cost, -r.cost
    ));

    tx.set(inventoryDoc(characterFile), Object.assign({}, inventory, {
      updatedAt: FieldValue.serverTimestamp(),
    }));
    tx.set(LEDGER_DOC, appendToLedger(ledgerSnap, additions));
    return { currency: inventory.currency, spent: total };
  });

  return { ok: true, spent: result.spent, currency: result.currency };
});

/* ══ grantInventory ═════════════════════════════════════════════════
   The admin page's grant panel, moved server-side so the ledger it
   writes is as trustworthy as the spend path. Admin only. */
exports.grantInventory = onCall(async (request) => {
  const caller = await requireCaller(request);
  if (caller.role !== 'admin') throw new HttpsError('permission-denied', 'Admins only.');

  const { files, spec } = request.data || {};
  if (!Array.isArray(files) || !files.length) throw new HttpsError('invalid-argument', 'No recipients.');
  if (!spec || typeof spec !== 'object') throw new HttpsError('invalid-argument', 'No grant.');

  const amount = Math.floor(Number(spec.amount));
  if (!Number.isFinite(amount)) throw new HttpsError('invalid-argument', 'Bad amount.');
  const mode = spec.mode === 'set' ? 'set' : 'add';

  const missing = [];
  for (const file of files) {
    requireCharacterAccess(caller, file);
    await db.runTransaction(async (tx) => {
      let inventory;
      try {
        inventory = await readInventory(tx, file);
      } catch (e) {
        missing.push(file);
        return;
      }
      const ledgerSnap = await tx.get(LEDGER_DOC);

      let delta = amount;
      let unit = null;

      if (spec.kind === 'item') {
        inventory.items = Array.isArray(inventory.items) ? inventory.items : [];
        inventory.items.push({
          id: genId('item'), name: String(spec.itemName || 'Item').slice(0, 120),
          qty: Math.max(1, amount), notes: String(spec.itemNotes || '').slice(0, 500),
        });
        delta = Math.max(1, amount);
      } else if (spec.kind === 'pool') {
        inventory.pools = Array.isArray(inventory.pools) ? inventory.pools : [];
        const target = String(spec.poolName || '').trim().toLowerCase();
        let pool = inventory.pools.find((p) => String(p.name || '').trim().toLowerCase() === target);
        if (!pool) {
          pool = { id: genId('pool'), name: String(spec.poolName || '').trim(), value: 0, max: null };
          inventory.pools.push(pool);
        }
        const before = pool.value || 0;
        pool.value = Math.max(0, mode === 'set' ? amount : before + amount);
        if (spec.poolMax !== null && spec.poolMax !== undefined) pool.max = spec.poolMax;
        delta = pool.value - before;
      } else {
        const field = spec.kind === 'currency' ? 'currency' : spec.kind === 'parts' ? 'parts' : 'points';
        inventory[field] = inventory[field] || {};
        const before = inventory[field][spec.key] || 0;
        inventory[field][spec.key] = Math.max(0, mode === 'set' ? amount : before + amount);
        delta = inventory[field][spec.key] - before;
        if (spec.kind === 'currency') unit = spec.key;
      }

      const entry = ledgerEntry(file, spec.kind, String(spec.summary || 'Granted').slice(0, 160),
        unit, delta, unit ? delta * (CURRENCY_TO_YEN[unit] || 0) : 0);

      tx.set(inventoryDoc(file), Object.assign({}, inventory, {
        updatedAt: FieldValue.serverTimestamp(),
      }));
      tx.set(LEDGER_DOC, appendToLedger(ledgerSnap, [entry]));
    });
  }

  return { ok: true, granted: files.length - missing.length, missing };
});

/* ══ migrateInventories ═════════════════════════════════════════════
   One-time move: copies each character's inventory out of the bundle
   into inventories/{file}. Safe to run more than once — it never
   overwrites an inventory that already exists, so a second run only
   picks up characters added since the first.

   The bundle's own copy is deliberately left in place. Nothing reads it
   after the clients are updated, and leaving it means a bad deploy can
   be rolled back without anyone's money disappearing. Clear it later,
   by hand, once you are happy. */
exports.migrateInventories = onCall(async (request) => {
  const caller = await requireCaller(request);
  if (caller.role !== 'admin') throw new HttpsError('permission-denied', 'Admins only.');

  const bundleSnap = await BUNDLE_DOC.get();
  const characters = (bundleSnap.exists && bundleSnap.data().characters) || {};
  const moved = [];
  const skipped = [];

  for (const [file, character] of Object.entries(characters)) {
    const ref = inventoryDoc(file);
    const existing = await ref.get();
    if (existing.exists) { skipped.push(file); continue; }
    await ref.set(Object.assign({}, character.inventory || {}, {
      migratedAt: FieldValue.serverTimestamp(),
    }));
    moved.push(file);
  }

  return { ok: true, moved, skipped };
});
