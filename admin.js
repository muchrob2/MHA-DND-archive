// Page logic for admin.html. Extracted from the HTML so it can be linted,
// diffed and tested directly rather than regex-scraped out of markup.
// Loaded as a CLASSIC script, not a module: the page wires controls with
// inline onclick= handlers that resolve against globals, and top-level
// declarations here become globals exactly as they did inline. type="module"
// would scope them and silently break every handler.

// Runs after auth.js, so fbAuthReady/fsMergeSave are already defined.
const db = firebase.firestore();

let allCharacterOptions = [];

function escHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

async function loadCharacterOptions() {
  const out = [];
  try {
    const roster = await fetch('CLASS-1A/roster.json').then(r => r.json());
    for (const s of (roster.students || [])) {
      if (s.file) out.push({ id: 'Student (1-A)::' + s.name, name: s.name });
    }
  } catch {}
  try {
    const snap = await db.collection('characters').get();
    snap.forEach(doc => {
      const data = doc.data();
      if (data._type === 'Custom') out.push({ id: doc.id, name: data.name || doc.id });
    });
  } catch {}
  return out;
}

async function loadUsers() {
  const snap = await db.collection('users').get();
  const tbody = document.getElementById('users-tbody');
  const tableWrap = document.getElementById('table-wrap');
  const emptyEl = document.getElementById('users-empty');
  tbody.innerHTML = '';
  tableWrap.style.display = snap.empty ? 'none' : '';
  emptyEl.style.display = snap.empty ? '' : 'none';
  snap.forEach(doc => {
    const uid = doc.id;
    const data = doc.data();
    const editable = new Set(data.editableCharacterIds || []);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escHtml(data.email || uid)}</td>
      <td>
        <select id="role-${uid}">
          <option value="pending" ${data.role === 'pending' ? 'selected' : ''}>pending</option>
          <option value="editor" ${data.role === 'editor' ? 'selected' : ''}>editor</option>
          <option value="admin" ${data.role === 'admin' ? 'selected' : ''}>admin</option>
        </select>
      </td>
      <td>
        <div class="char-picker" id="chars-${uid}">
          ${allCharacterOptions.map(c => `
            <label><input type="checkbox" value="${escHtml(c.id)}" ${editable.has(c.id) ? 'checked' : ''}> ${escHtml(c.name)}</label>
          `).join('')}
        </div>
        <button class="save-row-btn" onclick="saveUser('${uid}')">Save</button>
        <span class="row-saved" id="saved-${uid}">Saved ✓</span>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function saveUser(uid) {
  const role = document.getElementById('role-' + uid).value;
  const checks = document.querySelectorAll('#chars-' + uid + ' input[type=checkbox]:checked');
  const editableCharacterIds = [...checks].map(c => c.value);
  try {
    await db.collection('users').doc(uid).update({ role, editableCharacterIds });
    const notice = document.getElementById('saved-' + uid);
    notice.classList.add('show');
    setTimeout(() => notice.classList.remove('show'), 1500);
  } catch (e) {
    alert('Could not save: ' + e.message);
  }
}

/* ── Granting currency / parts / points / items ─────────────
   The toolkit's Inventory tab reads out of the shared
   `mha-dnd/relationships-bundle` document (characters keyed by their
   roster filename), not the `characters` collection — so grants are
   written there.

   Writes go through a real transaction that reads and mutates inside
   the same transaction, rather than through fsMergeSave. fsMergeSave
   builds its write from a document the caller read *earlier*, and it
   resolves primitives local-wins; a grant issued while a player was
   editing HP on the same sheet would carry this page's stale copy of
   that field back over their edit. Reading inside the transaction
   closes that window entirely: the only fields this ever changes are
   the inventory ones it explicitly touches.
   ───────────────────────────────────────────────────────────── */
const FS_BUNDLE_DOC = db.collection('mha-dnd').doc('relationships-bundle');
// Inventories moved out of the bundle so the rules could protect them; the
// DM is the only role allowed to increase a purse.
const FS_INVENTORIES = db.collection('inventories');

// Kept deliberately in step with CLASS-1A/relationships.js — same keys, same
// labels, same handbook sources. A key that disagrees would write a counter
// the toolkit never renders.
const GRANT_CURRENCIES = [
  ['yen', '¥ Yen'], ['pp', 'Platinum (pp)'], ['gp', 'Gold (gp)'],
  ['ep', 'Electrum (ep)'], ['sp', 'Silver (sp)'], ['cp', 'Copper (cp)'],
];
const GRANT_PARTS = [
  ['basic', 'Basic Part (suit, ¥2,000)'], ['pro', 'Pro Part (suit, ¥5,000)'],
  ['advMod', 'Advanced Mod (suit, ¥10,000)'], ['basicTech', 'Basic Tech Part (¥2,000)'],
  ['advanced', 'Advanced Part (¥5,000)'], ['uniqueMod', 'Unique Mod (¥10,000)'],
];
const GRANT_POINTS = [
  ['plusUltra', 'Plus Ultra (cap 1)'], ['ftp', 'Free Time Points'],
  ['awakening', 'Awakening Points (cap 3)'], ['tacticalSurge', 'Tactical Surge uses'],
  ['impactFrame', 'Impact Frame uses'],
];
const MISSION_FTP = [['1','D-rank — 1 FTP'],['2','C-rank — 2 FTP'],['3','B-rank — 3 FTP'],
                     ['4','A-rank — 4 FTP'],['5','S-rank — 5 FTP']];

/* ── The ledger ─────────────────────────────────────────────────────
   Grants are the other half of a character's statement — the shop
   records what they spent, this records what you gave them. Both append
   to mha-dnd/ledger, which the Heropad's Bank app reads.

   The ENTRY SHAPE is documented in full at the top of shop.js and must
   stay identical in all three files; verify-ledger.js fails if they
   drift. CURRENCY_TO_YEN is likewise kept in step with shop.js — it is
   what lets a grant of gold show up as a yen figure on the statement.
   ─────────────────────────────────────────────────────────────────── */
const FS_LEDGER_DOC = db.collection('mha-dnd').doc('ledger');
const MAX_LEDGER_ENTRIES = 400;
const CURRENCY_TO_YEN = { yen: 1, cp: 10, sp: 100, ep: 500, gp: 1000, pp: 10000 };

let rosterStudents = [];

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

// The counter a grant is about to move, read before and after so the ledger
// records the actual delta rather than the number typed into the form. They
// differ whenever mode is "set" — and differ per character, since each starts
// from their own balance. Items have no counter to compare, so they return
// null and the entry records the quantity added instead.
function grantCounterValue(inv, spec) {
  if (spec.kind === 'item') return null;
  if (spec.kind === 'pool') {
    const target = String(spec.poolName || '').trim().toLowerCase();
    const pool = (inv.pools || []).find(p => String(p.name || '').trim().toLowerCase() === target);
    return pool ? (pool.value || 0) : 0;
  }
  const field = spec.kind === 'currency' ? 'currency' : spec.kind === 'parts' ? 'parts' : 'points';
  return (inv[field] || {})[spec.key] || 0;
}

async function loadRecipients() {
  try {
    const roster = await fetch('CLASS-1A/roster.json').then(r => r.json());
    rosterStudents = (roster.students || []).filter(s => s.file);
  } catch { rosterStudents = []; }
  const box = document.getElementById('grant-recipients');
  box.innerHTML = rosterStudents.map(s => `
    <label>
      <input type="checkbox" value="${escHtml(s.file)}" data-pc="${s.is_pc ? '1' : '0'}">
      ${escHtml(s.name)}${s.is_pc ? ' <span class="grant-pc-tag">PC</span>' : ''}
    </label>`).join('') || '<em>Roster unavailable.</em>';
}

function selectRecipients(which) {
  document.querySelectorAll('#grant-recipients input[type=checkbox]').forEach(cb => {
    cb.checked = which === 'all' ? true
               : which === 'pc'  ? cb.dataset.pc === '1'
               : false;
  });
}

function optionsHtml(pairs) {
  return pairs.map(([v, label]) => `<option value="${escHtml(v)}">${escHtml(label)}</option>`).join('');
}

// The "what" half of the form. Rebuilt on every type change because each
// grant kind needs genuinely different inputs — an item needs a name and
// notes, a currency needs a denomination and an amount.
function renderGrantTarget() {
  const kind = document.getElementById('grant-kind').value;
  const el = document.getElementById('grant-target');
  const modeField = document.getElementById('grant-mode-field');

  // Items always append; "set to exact value" is meaningless for them.
  modeField.style.display = kind === 'item' ? 'none' : '';

  if (kind === 'item') {
    el.innerHTML = `
      <div class="grant-field"><label for="grant-item-name">Item name</label>
        <input id="grant-item-name" type="text" placeholder="Standard Hero Medkit"></div>
      <div class="grant-field"><label for="grant-amount">Quantity</label>
        <input id="grant-amount" type="number" min="1" value="1"></div>
      <div class="grant-field"><label for="grant-item-notes">Notes</label>
        <textarea id="grant-item-notes" rows="2" placeholder="Effect, weight, where it came from"></textarea></div>`;
    return;
  }
  if (kind === 'pool') {
    el.innerHTML = `
      <div class="grant-field"><label for="grant-pool-name">Pool name</label>
        <input id="grant-pool-name" type="text" list="dl-grant-pool" placeholder="Fury Points">
        <datalist id="dl-grant-pool">
          ${['Fury Points','Speed Points','Protective Points','Hot Points','Cold Points','Quirk Charges','Charges','Smash %']
            .map(v => `<option value="${v}">`).join('')}
        </datalist></div>
      <div class="grant-field"><label for="grant-amount">Amount</label>
        <input id="grant-amount" type="number" value="1"></div>
      <div class="grant-field"><label for="grant-pool-max">Maximum (optional)</label>
        <input id="grant-pool-max" type="number" min="0" placeholder="leave blank for uncapped"></div>`;
    return;
  }

  const pairs = kind === 'currency' ? GRANT_CURRENCIES : kind === 'parts' ? GRANT_PARTS : GRANT_POINTS;
  const isPoints = kind === 'points';
  el.innerHTML = `
    <div class="grant-field"><label for="grant-key">${isPoints ? 'Point' : kind === 'parts' ? 'Part' : 'Denomination'}</label>
      <select id="grant-key" ${isPoints ? 'onchange="syncFtpHelper()"' : ''}>${optionsHtml(pairs)}</select></div>
    <div class="grant-field"><label for="grant-amount">Amount</label>
      <input id="grant-amount" type="number" value="${isPoints ? 1 : 100}"></div>
    ${isPoints ? `
    <div class="grant-field" id="grant-ftp-helper" style="display:none;">
      <label for="grant-ftp-rank">Mission rank</label>
      <select id="grant-ftp-rank" onchange="document.getElementById('grant-amount').value = this.value;">
        ${optionsHtml(MISSION_FTP)}
      </select>
    </div>` : ''}`;
  if (isPoints) syncFtpHelper();
}

// FTP is the one point type the handbook awards on a fixed per-mission
// scale, so offer that scale rather than making the DM remember it.
function syncFtpHelper() {
  const helper = document.getElementById('grant-ftp-helper');
  if (!helper) return;
  helper.style.display = document.getElementById('grant-key').value === 'ftp' ? '' : 'none';
}

function setGrantStatus(text, cls) {
  const el = document.getElementById('grant-status');
  el.textContent = text;
  el.className = cls || '';
}

function logGrant(text) {
  const wrap = document.getElementById('grant-log-wrap');
  const list = document.getElementById('grant-log');
  wrap.style.display = '';
  const li = document.createElement('li');
  li.textContent = `${new Date().toLocaleTimeString()} — ${text}`;
  list.prepend(li);
}

// Applies one grant to one character's inventory, in place. Split out from
// the transaction so the same rules apply to every recipient and so the
// clamping logic sits in one readable place.
function applyGrantToInventory(inv, spec) {
  const { kind, key, amount, mode, itemName, itemNotes, poolName, poolMax } = spec;

  if (kind === 'item') {
    inv.items = Array.isArray(inv.items) ? inv.items : [];
    inv.items.push({ id: genId('item'), name: itemName, qty: Math.max(1, amount), notes: itemNotes || '' });
    return;
  }

  if (kind === 'pool') {
    inv.pools = Array.isArray(inv.pools) ? inv.pools : [];
    const target = poolName.trim().toLowerCase();
    let pool = inv.pools.find(p => String(p.name || '').trim().toLowerCase() === target);
    if (!pool) {
      pool = { id: genId('pool'), name: poolName.trim(), value: 0, max: null };
      inv.pools.push(pool);
    }
    pool.value = Math.max(0, mode === 'set' ? amount : (pool.value || 0) + amount);
    if (poolMax !== null) pool.max = poolMax;
    return;
  }

  const field = kind === 'currency' ? 'currency' : kind === 'parts' ? 'parts' : 'points';
  inv[field] = inv[field] || {};
  const current = inv[field][key] || 0;
  // Floored at 0 so a negative amount reads as "spend/deduct" without ever
  // driving a counter below empty.
  inv[field][key] = Math.max(0, mode === 'set' ? amount : current + amount);
}

function readGrantForm() {
  const kind = document.getElementById('grant-kind').value;
  const amountEl = document.getElementById('grant-amount');
  const amount = parseInt(amountEl?.value, 10);
  if (isNaN(amount)) return { error: 'Enter an amount.' };

  const spec = {
    kind,
    mode: document.getElementById('grant-mode').value,
    amount,
    key: document.getElementById('grant-key')?.value,
  };

  if (kind === 'item') {
    spec.itemName = document.getElementById('grant-item-name').value.trim();
    spec.itemNotes = document.getElementById('grant-item-notes').value.trim();
    if (!spec.itemName) return { error: 'Give the item a name.' };
    if (amount < 1) return { error: 'Quantity must be at least 1.' };
  }
  if (kind === 'pool') {
    spec.poolName = document.getElementById('grant-pool-name').value.trim();
    if (!spec.poolName) return { error: 'Give the pool a name.' };
    const rawMax = document.getElementById('grant-pool-max').value;
    spec.poolMax = rawMax === '' ? null : Math.max(0, parseInt(rawMax, 10) || 0);
  }
  return { spec };
}

function grantSummary(spec) {
  if (spec.kind === 'item') return `${spec.amount}× ${spec.itemName}`;
  const verb = spec.mode === 'set' ? 'set to' : (spec.amount < 0 ? 'deducted' : 'granted');
  if (spec.kind === 'pool') return `${spec.poolName} ${verb} ${Math.abs(spec.amount)}`;
  const table = spec.kind === 'currency' ? GRANT_CURRENCIES : spec.kind === 'parts' ? GRANT_PARTS : GRANT_POINTS;
  const label = (table.find(([k]) => k === spec.key) || [null, spec.key])[1];
  return `${label} ${verb} ${Math.abs(spec.amount)}`;
}

async function applyGrant() {
  const files = [...document.querySelectorAll('#grant-recipients input[type=checkbox]:checked')].map(cb => cb.value);
  if (!files.length) { setGrantStatus('Pick at least one recipient.', 'err'); return; }

  const { spec, error } = readGrantForm();
  if (error) { setGrantStatus(error, 'err'); return; }

  const btn = document.getElementById('grant-apply-btn');
  btn.disabled = true;
  setGrantStatus('Granting…', '');
  try {
    // One transaction per recipient: they are separate documents now, and
    // a single failure should not take the rest of the grant with it.
    //
    // "No inventory document yet" and "the write blew up" are different
    // problems with different fixes — the first wants the migration button
    // below, the second wants the actual error read. Lumping a thrown
    // exception in with the missing ones reported a permission failure or a
    // dropped connection as "not yet in the bundle", which sends the DM to
    // re-run a migration that was never the problem.
    const missing = [];
    const failed = [];
    for (const file of files) {
      try {
        await db.runTransaction(async (tx) => {
          const invRef = FS_INVENTORIES.doc(file);
          const invSnap = await tx.get(invRef);
          const ledgerSnap = await tx.get(FS_LEDGER_DOC);
          if (!invSnap.exists) { missing.push(file); return; }
          const inv = invSnap.data() || {};

          const before = grantCounterValue(inv, spec);
          applyGrantToInventory(inv, spec);
          const after = grantCounterValue(inv, spec);
          const delta = before === null ? Math.max(1, spec.amount) : after - before;

          const entry = ledgerEntry(file, spec.kind, grantSummary(spec),
            spec.kind === 'currency' ? spec.key : null, delta,
            spec.kind === 'currency' ? delta * (CURRENCY_TO_YEN[spec.key] || 0) : 0);

          tx.set(invRef, inv);
          tx.set(FS_LEDGER_DOC, appendToLedger(ledgerSnap, [entry]));
        });
      } catch (e) {
        console.error('[admin] grant to ' + file + ' failed:', e);
        failed.push({ file, message: e.code || e.message || String(e) });
      }
    }

    const nameOf = f => (rosterStudents.find(s => s.file === f) || {}).name || f;
    const granted = files.length - missing.length - failed.length;
    logGrant(`${grantSummary(spec)} → ${granted} character${granted === 1 ? '' : 's'}`);

    const notes = [];
    if (missing.length) notes.push(`no inventory yet (run the migration below): ${missing.map(nameOf).join(', ')}`);
    if (failed.length) notes.push(`failed: ${failed.map(f => `${nameOf(f.file)} — ${f.message}`).join('; ')}`);
    setGrantStatus(
      notes.length
        ? `Granted to ${granted}. ${notes.join('. ')}`
        : `Granted to ${granted} character${granted === 1 ? '' : 's'} ✓`,
      failed.length ? 'err' : missing.length ? 'warn' : 'ok'
    );
  } catch (e) {
    setGrantStatus('Could not grant: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

document.addEventListener('auth-state-changed', async (state) => {
  const { role } = state.detail;
  const gate = document.getElementById('gate-message');
  const body = document.getElementById('admin-body');
  if (role !== 'admin') {
    gate.style.display = '';
    body.style.display = 'none';
    gate.textContent = state.detail.user ? 'You do not have admin access.' : 'Sign in with an admin account to view this page.';
    return;
  }
  gate.style.display = 'none';
  body.style.display = '';
  allCharacterOptions = await loadCharacterOptions();
  await loadUsers();
  await loadRecipients();
  renderGrantTarget();
});


/* ── One-time migration ─────────────────────────────────────────────
   Copies each character's inventory out of the shared bundle into its own
   document, where the rules can protect it. Creating an inventory is
   admin-only, so this belongs here.

   Safe to run more than once: it never overwrites an inventory that
   already exists, so a second run only picks up characters added since
   the first. The bundle's copies are left exactly where they are —
   nothing reads them once this has run, and leaving them means a bad day
   can be undone without anyone's money disappearing.
   ─────────────────────────────────────────────────────────────────── */
async function migrateInventories() {
  const btn = document.getElementById('migrate-btn');
  const out = document.getElementById('migrate-status');
  if (btn) btn.disabled = true;
  if (out) out.textContent = 'Migrating…';
  try {
    const snap = await FS_BUNDLE_DOC.get();
    const characters = (snap.exists && snap.data().characters) || {};
    const moved = [];
    const skipped = [];
    for (const [file, character] of Object.entries(characters)) {
      const ref = FS_INVENTORIES.doc(file);
      const existing = await ref.get();
      if (existing.exists) { skipped.push(file); continue; }
      await ref.set(character.inventory || {});
      moved.push(file);
    }
    if (out) {
      out.textContent = moved.length
        ? `Moved ${moved.length} inventor${moved.length === 1 ? 'y' : 'ies'}` +
          (skipped.length ? `, left ${skipped.length} already in place.` : '.')
        : `Nothing to move — all ${skipped.length} are already in place.`;
    }
  } catch (e) {
    if (out) out.textContent = 'Migration failed: ' + (e.code || e.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}
