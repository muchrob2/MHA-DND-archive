#!/usr/bin/env node
// Checks the transaction ledger that the Heropad's Bank app reads.
//
//   node scripts/verify-ledger.js
//
// The ledger has three files in it and no type system between them:
//
//   shop.js     writes an entry per basket line on checkout
//   admin.js    writes an entry per recipient when the DM grants
//   heropad.js  reads them and renders the statement
//
// A field renamed in one and not the others fails silently — the money still
// moves, the statement just quietly renders "undefined" or drops the line.
// These checks pin the entry shape, the currency conversion table, and the
// one property that makes the whole thing trustworthy: that money and its
// ledger entry are written in the SAME Firestore transaction, so a purchase
// can never exist without a statement line or vice versa.
//
// It parses and pattern-matches, then executes the two pure helpers against
// a fake snapshot. Nothing here touches Firestore or the DOM.

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(repoRoot, p), 'utf8');

const shopSrc = read('shop.js');
const adminSrc = read('admin.js');
const padSrc = read('heropad.js');

let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}${ok || !detail ? '' : ': ' + detail}`);
  if (!ok) failed++;
}

/* ── One document, one name ─────────────────────────────────────── */
for (const [name, src] of [['shop.js', shopSrc], ['admin.js', adminSrc], ['heropad.js', padSrc]]) {
  check(`${name} addresses mha-dnd/ledger`, /doc\('ledger'\)/.test(src));
}

/* ── The entry shape ────────────────────────────────────────────── */
// Both writers build entries through an identically-shaped ledgerEntry().
const FIELDS = ['id', 'ts', 'file', 'kind', 'label', 'unit', 'amount', 'yen'];
for (const [name, src] of [['shop.js', shopSrc], ['admin.js', adminSrc]]) {
  const fn = src.match(/function ledgerEntry\([^)]*\)\s*\{[\s\S]*?\n\}/);
  check(`${name} defines ledgerEntry()`, !!fn);
  if (!fn) continue;
  for (const field of FIELDS) {
    check(`${name} ledgerEntry sets "${field}"`, new RegExp(`\\b${field}\\b`).test(fn[0]));
  }
}

// The reader must not reference a field the writers never set. Scoped to the
// Bank renderer — `e` elsewhere in the file is a caught error or a DOM event,
// and matching those would flag `e.message` as a missing ledger field.
const bankFns = ['renderBankApp', 'ownerEntries', 'entryMatchesFilter']
  .map(n => padSrc.match(new RegExp(`function ${n}\\([^)]*\\)[\\s\\S]*?\\n\\}`)));
check('heropad.js defines the Bank reader functions', bankFns.every(Boolean));
if (bankFns.every(Boolean)) {
  const bankRender = [bankFns.map(m => m[0]).join('\n')];
  const readFields = new Set([...bankRender[0].matchAll(/\be\.([a-zA-Z]+)\b/g)].map(m => m[1]));
  const unknown = [...readFields].filter(f => !FIELDS.includes(f));
  check('heropad.js reads only fields the writers set', unknown.length === 0,
    'unknown entry fields: ' + unknown.join(', '));
  // And the reverse: a field nothing reads is dead weight in every entry.
  const unread = FIELDS.filter(f => f !== 'id' && !readFields.has(f));
  check('every stored field is actually rendered', unread.length === 0,
    'never read: ' + unread.join(', '));
}

/* ── Atomicity: the money and its record commit together ────────── */
// This is the check that matters most. If a ledger write ever moves outside
// the transaction that moves the money, the statement stops being evidence.
function transactionBody(src, marker) {
  const start = src.indexOf(marker);
  if (start < 0) return null;
  const open = src.indexOf('runTransaction', start);
  if (open < 0) return null;
  // Crude but sufficient: from runTransaction to the end of that statement.
  const end = src.indexOf('\n    });', open);
  return end < 0 ? null : src.slice(open, end);
}
const checkoutTx = transactionBody(shopSrc, 'async function checkout(');
check('shop.js checkout runs a transaction', !!checkoutTx);
check('shop.js writes the ledger inside the purse transaction',
  !!checkoutTx && /tx\.set\(FS_LEDGER_DOC/.test(checkoutTx),
  'a ledger write outside the transaction can leave a purchase with no statement line');
check('shop.js reads the ledger before writing anything (Firestore rule)',
  !!checkoutTx && checkoutTx.indexOf('tx.get(FS_LEDGER_DOC') < checkoutTx.indexOf('tx.set('),
  'every read must precede every write in a Firestore transaction');
check('shop.js writes the inventory document, not the bundle',
  !!checkoutTx && /tx\.set\(invRef/.test(checkoutTx) && !/tx\.set\(FS_BUNDLE_DOC/.test(checkoutTx),
  'purses live in inventories/{characterFile} now, where the rules can protect them');

const grantFn = (adminSrc.match(/async function applyGrant\([\s\S]*?\n\}/) || [])[0] || '';
check('admin.js grants inside a transaction', /runTransaction/.test(grantFn));
check('admin.js grants per recipient', /for \(const file of files\)/.test(grantFn),
  'separate documents now — one failure must not take the rest of the grant with it');
check('admin.js reads both documents before writing either',
  grantFn.indexOf('tx.get(FS_LEDGER_DOC') < grantFn.indexOf('tx.set('));
check('admin.js writes the inventory and the ledger together',
  /tx\.set\(invRef/.test(grantFn) && /tx\.set\(FS_LEDGER_DOC/.test(grantFn));

// A grant with mode "set" moves the counter to a value, so the amount typed
// into the form is not the delta. The ledger must record what actually moved.
check('admin.js records the real delta, not the amount typed in',
  /const before = grantCounterValue\(/.test(adminSrc) && /const after = grantCounterValue\(/.test(adminSrc),
  'a "set" grant would otherwise log the target value as though it were the change');

/* ── Currency table agreement ───────────────────────────────────── */
function currencyTable(src) {
  const m = src.match(/const CURRENCY_TO_YEN = \{([^}]*)\}/);
  if (!m) return null;
  const out = {};
  for (const pair of m[1].split(',')) {
    const kv = pair.split(':').map(s => s.trim());
    if (kv.length === 2 && kv[0]) out[kv[0]] = Number(kv[1]);
  }
  return out;
}
const tables = {
  'shop.js': currencyTable(shopSrc),
  'admin.js': currencyTable(adminSrc),
  'heropad.js': currencyTable(padSrc),
};
for (const [name, t] of Object.entries(tables)) {
  check(`${name} declares CURRENCY_TO_YEN`, !!t && Object.keys(t).length > 0);
}
if (tables['shop.js']) {
  for (const name of ['admin.js', 'heropad.js']) {
    check(`${name} agrees with shop.js on every conversion rate`,
      JSON.stringify(tables[name]) === JSON.stringify(tables['shop.js']),
      JSON.stringify(tables[name]));
  }
}

/* ── The append helper actually caps ────────────────────────────── */
// Executed, not just matched: an off-by-one here grows a document until
// writes start failing, months after anyone touched this code.
const helperSrc = shopSrc.match(/const MAX_LEDGER_ENTRIES = \d+;[\s\S]*?function appendToLedger[\s\S]*?\n\}/);
check('shop.js exposes MAX_LEDGER_ENTRIES + appendToLedger', !!helperSrc);
if (helperSrc) {
  const scope = {};
  new Function('scope', helperSrc[0] + '\nscope.MAX = MAX_LEDGER_ENTRIES; scope.append = appendToLedger;')(scope);
  const cap = scope.MAX;

  check('the cap leaves room under the 1MiB document limit', cap > 0 && cap * 400 < 1048576,
    `${cap} entries × ~400 bytes`);

  const seed = { entries: Array.from({ length: cap }, (_, i) => ({ id: 'e' + i })) };
  const grown = scope.append({ exists: true, data: () => seed }, [{ id: 'new-1' }, { id: 'new-2' }]);
  check('appending past the cap keeps the length at the cap', grown.entries.length === cap,
    String(grown.entries.length));
  check('the newest entries survive', grown.entries[cap - 1].id === 'new-2');
  check('the oldest entries are the ones dropped',
    !grown.entries.some(e => e.id === 'e0' || e.id === 'e1'));

  const fresh = scope.append({ exists: false }, [{ id: 'first' }]);
  check('a missing ledger document starts a new one', fresh.entries.length === 1);

  const other = scope.append({ exists: true, data: () => ({ entries: [], somethingElse: 42 }) }, [{ id: 'a' }]);
  check('unrelated fields on the document survive an append', other.somethingElse === 42);
}

/* ── Where the pad is allowed to write ──────────────────────────── */
// The pad gained a writer when the Eats app shipped: ordering food spends
// from the purse and records it, exactly as the Shop does. So "the pad never
// writes" is no longer the invariant — this is:
//
//   the Bank *reads*, and the only pad code that writes does so inside a
//   transaction that moves the purse and the ledger together.
//
// A ledger write anywhere else in the pad, or one outside a transaction,
// would let a statement line exist without the money having moved.
for (const doc of ['FS_LEDGER_DOC', 'FS_BUNDLE_DOC']) {
  check(`heropad.js never writes ${doc} outside a transaction`,
    !new RegExp(`${doc}\\.set\\(`).test(padSrc),
    'a bare .set() bypasses the read-check-write the money depends on');
}
const padWrites = [...padSrc.matchAll(/tx\.set\(invRef|tx\.set\(FS_LEDGER_DOC/g)].length;
check('the pad has exactly one place that moves money', padWrites === 2,
  `${padWrites} transactional writes found; expected 2 (purse + ledger, in orderFood)`);
check('the pad never writes the character bundle',
  !/tx\.set\(FS_BUNDLE_DOC|FS_BUNDLE_DOC\.set\(/.test(padSrc));

// The Bank's own rendering path must stay a reader.
const bankSection = padSrc.slice(padSrc.indexOf('App: Bank'), padSrc.indexOf('App: Quirks'));
check('nothing in the Bank app writes', !/tx\.set|\.set\(/.test(bankSection),
  'a bank app that can edit your balance is not a bank app');

console.log(failed ? `>>> ${failed} check(s) failed` : '>>> ledger OK');
process.exit(failed ? 1 : 0);
