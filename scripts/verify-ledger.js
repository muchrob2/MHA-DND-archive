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
// The ledger has exactly one writer now: the Cloud Functions. Clients ask
// for a spend or a grant and read the result back.
const fnSrc = read('functions/index.js');

let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}${ok || !detail ? '' : ': ' + detail}`);
  if (!ok) failed++;
}

/* ── One document, one name ─────────────────────────────────────── */
check('functions/index.js addresses mha-dnd/ledger', /doc\('ledger'\)/.test(fnSrc));
check('heropad.js reads mha-dnd/ledger', /doc\('ledger'\)/.test(padSrc));

/* ── The entry shape ────────────────────────────────────────────── */
// One writer builds every entry, so the shape is pinned in one place and
// read back in another.
const FIELDS = ['id', 'ts', 'file', 'kind', 'label', 'unit', 'amount', 'yen'];
const entryFn = fnSrc.match(/function ledgerEntry\([^)]*\)\s*\{[\s\S]*?\n\}/);
check('functions/index.js defines ledgerEntry()', !!entryFn);
if (entryFn) {
  for (const field of FIELDS) {
    check(`ledgerEntry sets "${field}"`, new RegExp(`\\b${field}\\b`).test(entryFn[0]));
  }
}
for (const [name, src] of [['shop.js', shopSrc], ['admin.js', adminSrc], ['heropad.js', padSrc]]) {
  check(`${name} no longer builds ledger entries itself`,
    !/function ledgerEntry\(|function appendToLedger\(/.test(src),
    'a second implementation is a second truth about what a transaction was');
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
// Unchanged as a requirement, moved as an implementation. If a ledger write
// ever leaves the transaction that moves the purse, the statement stops
// being evidence.
const spendFn = (fnSrc.match(/exports\.spend = onCall\([\s\S]*?\n\}\);/) || [])[0] || '';
check('spend() runs a transaction', /runTransaction/.test(spendFn));
check('spend() writes the purse and the ledger together',
  /tx\.set\(inventoryDoc/.test(spendFn) && /tx\.set\(LEDGER_DOC/.test(spendFn));
check('grantInventory() does the same',
  /exports\.grantInventory[\s\S]*?tx\.set\(inventoryDoc[\s\S]*?tx\.set\(LEDGER_DOC/.test(fnSrc));
check('the clients ask rather than write',
  /fbCall\('spend'/.test(shopSrc) && /fbCall\('spend'/.test(padSrc)
  && /fbCall\('grantInventory'/.test(adminSrc));

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
  'heropad.js': currencyTable(padSrc),
  'functions/index.js': currencyTable(fnSrc),
};
for (const [name, t] of Object.entries(tables)) {
  check(`${name} declares CURRENCY_TO_YEN`, !!t && Object.keys(t).length > 0);
}
if (tables['shop.js']) {
  for (const name of ['heropad.js', 'functions/index.js']) {
    check(`${name} agrees with shop.js on every conversion rate`,
      JSON.stringify(tables[name]) === JSON.stringify(tables['shop.js']),
      JSON.stringify(tables[name]));
  }
}

/* ── The append helper actually caps ────────────────────────────── */
// Executed, not just matched: an off-by-one here grows a document until
// writes start failing, months after anyone touched this code.
const helperSrc = fnSrc.match(/const MAX_LEDGER_ENTRIES = \d+;[\s\S]*?function appendToLedger[\s\S]*?\n\}/);
check('functions/index.js exposes MAX_LEDGER_ENTRIES + appendToLedger', !!helperSrc);
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

/* ── No client writes money any more ────────────────────────────── */
// This is what the Cloud Functions bought. Before, the invariant was "the
// pad writes money only inside a transaction"; now the pad cannot write it
// at all, and neither can the shop or the admin page. firestore.rules
// refuses them, and verify-functions.js checks the rules still say so.
for (const [name, src] of [['shop.js', shopSrc], ['admin.js', adminSrc], ['heropad.js', padSrc]]) {
  check(`${name} never writes the ledger`,
    !/FS_LEDGER_DOC\.set|tx\.set\(FS_LEDGER_DOC/.test(src));
  check(`${name} never writes an inventory`,
    !/collection\('inventories'\)[\s\S]{0,80}\.set\(/.test(src));
}
check('the Bank app is still a reader',
  !/tx\.set|\.set\(/.test(padSrc.slice(padSrc.indexOf('App: Bank'), padSrc.indexOf('App: Quirks'))));

console.log(failed ? `>>> ${failed} check(s) failed` : '>>> ledger OK');
process.exit(failed ? 1 : 0);
