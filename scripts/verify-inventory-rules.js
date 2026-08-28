#!/usr/bin/env node
// Checks the rule that stops players giving themselves money.
//
//   node scripts/verify-inventory-rules.js
//
// firestore.rules is the only thing enforcing this — there is no server, and
// the pages that spend money are pages the players control. So the rule has
// to be right, and it has to keep matching what the clients actually do.
//
// Firestore rules can't be executed here, so this does two things instead:
//
//   1. Reads the arithmetic straight out of firestore.rules, rebuilds it in
//      JavaScript, and runs it against purses that should and should not be
//      allowed. If someone edits a conversion rate in the rule, the rebuilt
//      version changes with it and the expectations catch the error.
//   2. Checks the clients only ever write inventories in ways the rule will
//      accept, so a refused write never surprises a player mid-purchase.

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8');
const rules = read('firestore.rules');

let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}${ok || !detail ? '' : ': ' + detail}`);
  if (!ok) failed++;
}

/* ── The rule exists and is shaped as intended ──────────────────── */
const block = (rules.match(/match \/inventories\/\{[^}]*\}\s*\{[\s\S]*?\n    \}/) || [])[0] || '';
check('the inventories rule exists', !!block);
check('inventories are readable', /allow read: if true/.test(block));
check('only the DM may create an inventory', /allow create: if isAdmin\(\)/.test(block),
  'creation is the migration, and it sets the starting balance');
check('only the DM may delete one', /allow delete: if isAdmin\(\)/.test(block));
check('the DM may update freely', /allow update: if isAdmin\(\)/.test(block),
  'grants are supposed to add money');
check('a player update is gated on the purse not growing',
  /purseValue\(request\.resource\.data\) <= purseValue\(resource\.data\)/.test(block),
  'this single comparison is the entire protection');

/* ── The arithmetic, lifted from the rule itself ────────────────── */
// Rebuilt from the source so a changed rate in firestore.rules changes this
// too — the expectations below are what actually pin the behaviour.
const fnSrc = (rules.match(/function purseValue\(inv\) \{[\s\S]*?\n    \}/) || [])[0] || '';
check('purseValue() is defined in the rules', !!fnSrc);

const rates = {};
for (const m of fnSrc.matchAll(/get\('(\w+)', 0\)(?:\s*\*\s*(\d+))?/g)) {
  rates[m[1]] = m[2] ? Number(m[2]) : 1;
}
check('every denomination is valued',
  ['yen', 'cp', 'sp', 'ep', 'gp', 'pp'].every((k) => k in rates), JSON.stringify(rates));
check('the rates match the handbook',
  rates.yen === 1 && rates.cp === 10 && rates.sp === 100 &&
  rates.ep === 500 && rates.gp === 1000 && rates.pp === 10000,
  JSON.stringify(rates));

const purseValue = (inv) =>
  Object.entries(rates).reduce((sum, [k, rate]) => sum + ((inv.currency || {})[k] || 0) * rate, 0);

// `allowed` here means "the rule would permit an editor to write this".
const allowed = (before, after) => purseValue(after) <= purseValue(before);

const P = (o) => ({ currency: o });

/* ── What a player must not be able to do ───────────────────────── */
check('a player cannot hand themselves yen',
  !allowed(P({ yen: 100 }), P({ yen: 100000 })));
check('a player cannot hand themselves platinum',
  !allowed(P({ yen: 100 }), P({ yen: 100, pp: 1 })));
check('a player cannot launder small coin into a big one',
  !allowed(P({ yen: 0, sp: 1 }), P({ yen: 0, gp: 1 })),
  '1sp is ¥100, 1gp is ¥1,000');
check('a player cannot add a denomination that was absent',
  !allowed(P({ yen: 500 }), P({ yen: 500, cp: 1 })));

/* ── What must keep working ─────────────────────────────────────── */
check('spending is allowed', allowed(P({ yen: 1000 }), P({ yen: 130 })));
check('spending to nothing is allowed', allowed(P({ yen: 1000 }), P({ yen: 0 })));
check('an unchanged purse is allowed',
  allowed(P({ yen: 1000, gp: 2 }), P({ yen: 1000, gp: 2 })),
  'editing items or notes must not be blocked by the purse check');
check('breaking a coin into change is allowed',
  allowed(P({ pp: 1 }), P({ yen: 9500 })),
  'spending ¥500 from a single platinum coin leaves ¥9,500 — worth less, so permitted');
check('a purse with no currency map at all is handled',
  allowed({}, {}) && !allowed({}, P({ yen: 1 })));

/* ── The clients only ever write decreases ──────────────────────── */
// A client that tries to write an increase gets a permission error mid
// purchase, which reads to a player as "the shop is broken".
const shopSrc = read('shop.js');
const padSrc = read('heropad.js');
const adminSrc = read('admin.js');

const checkout = (shopSrc.match(/async function checkout\(\)[\s\S]*?\n\}/) || [])[0] || '';
check('the shop only ever deducts', /applyBasket\(/.test(checkout) && !/\+=/.test(checkout));
check('the shop writes the inventory document', /tx\.set\(invRef/.test(checkout));

const order = (padSrc.match(/async function orderFood\([\s\S]*?\n\}/) || [])[0] || '';
check('an Eats order only ever deducts', /spendFromWallet\(/.test(order));
check('an Eats order writes the inventory document', /tx\.set\(invRef/.test(order));

/* The toolkit writes items, and only items. Players keep their own kit on the
   Inventory tab, so this page is a fourth writer of the inventories
   collection — but a deliberately narrow one. The rule above values only the
   purse, so an update that never names `currency` is one it cannot refuse,
   and a purse that is never written is a purse that cannot be lost. Both
   halves are checked: what the write carries, and what still gates the
   money inputs. */
const toolkitSrc = read('CLASS-1A/relationships.js');
const toolkitWrite = (toolkitSrc.match(/async function saveInventoryItems\([\s\S]*?\n\}/) || [])[0] || '';
check('the toolkit has exactly one inventory write path', !!toolkitWrite,
  'items are editable there; nothing else about an inventory is');
check('it writes the items array and nothing else',
  /tx\.update\(ref, \{ items \}\)/.test(toolkitWrite),
  'a write carrying currency would be judged by the rule above, and could lose a purchase');
// Comments stripped: the code is what runs, and the comment right above the
// update is explaining which fields it deliberately leaves out.
check('it never touches currency, parts or points',
  !/currency|\bparts\b|\bpoints\b/.test(toolkitWrite.replace(/\/\/.*$/gm, '')));

// One assignment, and it is to false. Written as "collect them and look"
// rather than a negative lookahead, which quietly passes the declaration
// itself by backtracking over the space before the value.
const gateWrites = (toolkitSrc.match(/canEditInventory\s*=\s*[^;]+/g) || [])
  .map((m) => m.replace(/\s+/g, ' ').trim());
check('the money fields are still gated on canEditInventory',
  gateWrites.length === 1, JSON.stringify(gateWrites));
check('and nothing anywhere sets that gate true',
  gateWrites[0] === 'canEditInventory = false',
  'grants are the admin page\'s job, and they write a ledger line with the money');
check('the toolkit strips inventory from every save',
  /const \{ inventory, \.\.\.rest \} = c;/.test(toolkitSrc),
  'a sheet save carrying a stale purse would undo a purchase');

/* ── The bundle is not allowed to speak for inventory ────────────
   Symmetry with the check above: stripped on the way out, stripped on the
   way in. The bundle's inventory keys are migration-era fossils that no
   longer move, so applying one over the live copy makes a grant or a
   purchase appear to fail. And the tab needs its own listener, because the
   collection it now reads is not the document it was listening to. */
check('the toolkit strips inventory from every snapshot it applies',
  /Object\.assign\(c, stripInventory\(/.test(toolkitSrc),
  'the bundle still carries a stale inventory for every character');
check('the toolkit watches the inventories collection live',
  /FS_INVENTORIES\.onSnapshot\(/.test(toolkitSrc),
  'without it a grant or purchase never shows up until a reload');
check('the toolkit ignores a cached inventory replay',
  /function startInventoryLiveSync[\s\S]*?fromCache/.test(toolkitSrc),
  'a replayed cache is this tab\'s own stale copy, not news');

/* ── The migration ──────────────────────────────────────────────── */
check('the admin page can move inventories across',
  /async function migrateInventories\(\)/.test(adminSrc));
check('the migration never overwrites an existing inventory',
  /if \(existing\.exists\) \{ skipped\.push/.test(adminSrc),
  'so running it twice is harmless');
check('the migration leaves the bundle copies alone',
  !/characters\[file\]\.inventory = |delete character\.inventory/.test(adminSrc),
  'a bad day should be undoable without anyone losing money');

console.log(failed ? `>>> ${failed} check(s) failed` : '>>> inventory rules OK');
process.exit(failed ? 1 : 0);
