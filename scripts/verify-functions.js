#!/usr/bin/env node
// Checks the Cloud Functions that own money, without deploying them.
//
//   node scripts/verify-functions.js
//
// These functions are the only thing standing between a player and their own
// purse, and they run somewhere this repo's other checks cannot see. Three
// things can go wrong quietly:
//
//   1. The rules stop locking the documents the functions exist to protect,
//      at which point the whole exercise is theatre.
//   2. The catalogue copy shipped to the server drifts from the one the site
//      renders, so the price shown is not the price charged.
//   3. The server's coin-spending rule drifts from the client's, so a purse
//      ends up holding different coins depending on which code path spent it.
//
// It parses and compares; it deploys nothing and calls nothing.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const repoRoot = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8');
const readJson = (p) => JSON.parse(read(p));

let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}${ok || !detail ? '' : ': ' + detail}`);
  if (!ok) failed++;
}

const fnSrc = read('functions/index.js');
const rules = read('firestore.rules');

/* ── It parses ──────────────────────────────────────────────────── */
try {
  new vm.Script(fnSrc, { filename: 'functions/index.js' });
  check('functions/index.js parses', true);
} catch (e) {
  check('functions/index.js parses', false, e.message);
}

/* ── The rules actually lock what the functions protect ─────────── */
// Without these two, everything else here is decoration.
const invBlock = (rules.match(/match \/inventories\/\{[^}]*\}\s*\{[\s\S]*?\n    \}/) || [])[0] || '';
check('inventories are readable', /allow read: if true/.test(invBlock));
check('inventories are writable by NO client', /allow write: if false/.test(invBlock),
  'the Admin SDK bypasses rules, so the functions still write; clients must not');
check('the ledger is writable by no client either',
  /doc != 'ledger'/.test(rules),
  'a client that can forge a statement line can hide a theft');
check('masaranking and encounter-state stay locked too',
  /doc != 'encounter-state'/.test(rules) && /doc != 'masaranking'/.test(rules));

/* ── Server data matches what the site shows ────────────────────── */
for (const [canonical, shipped] of [
  ['CAMPAIGN/shop-catalog.json', 'functions/data/shop-catalog.json'],
  ['CAMPAIGN/eats-menu.json', 'functions/data/eats-menu.json'],
  ['CLASS-1A/roster.json', 'functions/data/roster.json'],
]) {
  check(`${shipped} matches ${canonical}`,
    read(canonical) === read(shipped),
    'run `npm run sync-functions-data` — the price charged would not be the price shown');
}

/* ── The client's menu is the shared file, not a second copy ────── */
const padSrc = read('heropad.js');
check('heropad.js reads the shared Eats menu rather than hardcoding one',
  /eats-menu\.json/.test(padSrc) && !/const EATS_MENU = \[/.test(padSrc),
  'a menu in two places is a price in two places');

/* ── Prices come from the server, never the request ─────────────── */
const spendFn = (fnSrc.match(/exports\.spend = onCall\([\s\S]*?\n\}\);/) || [])[0] || '';
check('spend() exists', !!spendFn);
check('spend() takes ids and quantities, not prices',
  !/data\.price|l\.price|\.price\b\s*\|\|/.test(spendFn),
  'a client-supplied price means a ¥1 katana');
check('spend() resolves prices through the catalogue',
  /priceOf\(/.test(spendFn));
check('spend() rejects open-ended and ranged prices',
  /priceOpen \|\| item\.priceMax/.test(fnSrc),
  'those are DM judgement calls, not something a client resolves for itself');
check('spend() checks the caller is who they claim',
  /requireCaller\(request\)/.test(spendFn));
check('spend() checks the character belongs to the caller',
  /requireCharacterAccess\(/.test(spendFn));
check('the role is read from Firestore, not taken from the request',
  /collection\('users'\)\.doc\(uid\)\.get\(\)/.test(fnSrc),
  'a role in the request body is whatever the client says it is');
check('spend() writes the purse and the ledger in one transaction',
  /runTransaction/.test(spendFn) && /tx\.set\(inventoryDoc/.test(spendFn) && /tx\.set\(LEDGER_DOC/.test(spendFn));
check('grantInventory() is admin-only',
  /exports\.grantInventory[\s\S]*?role !== 'admin'/.test(fnSrc));
check('migrateInventories() is admin-only',
  /exports\.migrateInventories[\s\S]*?role !== 'admin'/.test(fnSrc));
check('the migration never overwrites an inventory that already exists',
  /if \(existing\.exists\) \{ skipped\.push/.test(fnSrc),
  'so it is safe to run twice');

/* ── The server spends coins exactly like the client ────────────── */
function liftSpend(src, label) {
  const rates = src.match(/const CURRENCY_TO_YEN = \{[^}]*\};/);
  const keys = src.match(/const CURRENCY_KEYS = \[[^\]]*\];/);
  const total = src.match(/function walletTotalYen\([\s\S]*?\n\}/);
  const fn = src.match(/function spendFromWallet\([\s\S]*?\n\}/);
  if (!rates || !keys || !total || !fn) { check(`${label} exposes its wallet maths`, false); return null; }
  const scope = {};
  new Function('scope', [keys[0], rates[0], total[0], fn[0],
    'scope.spend = spendFromWallet; scope.total = walletTotalYen;'].join('\n'))(scope);
  return scope;
}
const server = liftSpend(fnSrc, 'functions/index.js');
const client = liftSpend(read('shop.js'), 'shop.js');

if (server && client) {
  let seed = 20260816;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  let mismatch = null;
  for (let i = 0; i < 500; i++) {
    const purse = { yen: rnd(3000), pp: rnd(3), gp: rnd(6), ep: rnd(4), sp: rnd(12), cp: rnd(20) };
    const cost = rnd(9000);
    const a = JSON.parse(JSON.stringify(purse));
    const b = JSON.parse(JSON.stringify(purse));
    const okA = client.spend(a, cost);
    const okB = server.spend(b, cost);
    if (okA !== okB || JSON.stringify(a) !== JSON.stringify(b)) {
      mismatch = { purse, cost, client: { okA, a }, server: { okB, b } };
      break;
    }
  }
  check('the server and the client spend coins identically across 500 purses',
    !mismatch, JSON.stringify(mismatch));
}

/* ── Every catalogue id the server will sell is real ────────────── */
const menu = readJson('CAMPAIGN/eats-menu.json');
check('every Eats item has a positive integer price',
  (menu.items || []).length > 0 &&
  menu.items.every((i) => Number.isInteger(i.price) && i.price > 0),
  JSON.stringify((menu.items || []).filter((i) => !Number.isInteger(i.price) || i.price <= 0)));
check('every Eats id is unique',
  new Set((menu.items || []).map((i) => i.id)).size === (menu.items || []).length);

console.log(failed ? `>>> ${failed} check(s) failed` : '>>> functions OK');
process.exit(failed ? 1 : 0);
