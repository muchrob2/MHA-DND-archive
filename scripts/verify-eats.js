#!/usr/bin/env node
// The Eats app spends from the same purse the Shop spends from, using its own
// copy of spendFromWallet. Two copies of the rule that decides which coins
// leave a player's purse is exactly the kind of duplication that drifts
// silently: the shop would break a platinum coin where the food app melts it,
// and nobody would notice until someone lost 9,000 yen buying ramen.
//
//   node scripts/verify-eats.js
//
// So rather than eyeball the two, this pulls both functions out of their
// files and runs them against the same purses, asserting identical results
// every time. It also checks the food app writes the same ledger shape as
// the shop and spends inside the same kind of transaction.

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(repoRoot, p), 'utf8');
const shopSrc = read('shop.js');
const padSrc = read('heropad.js');

let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}${ok || !detail ? '' : ': ' + detail}`);
  if (!ok) failed++;
}

// Lift a self-contained function plus the currency table it closes over.
function extract(src, name) {
  const table = src.match(/const CURRENCY_KEYS = \[[^\]]*\];/);
  const rates = src.match(/const CURRENCY_TO_YEN = \{[^}]*\};/);
  const total = src.match(/function walletTotalYen\([\s\S]*?\n\}/);
  const fn = src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
  if (!table || !rates || !total || !fn) return null;
  const scope = {};
  new Function('scope',
    [table[0], rates[0], total[0], fn[0], `scope.fn = ${name}; scope.total = walletTotalYen;`].join('\n')
  )(scope);
  return scope;
}

const shop = extract(shopSrc, 'spendFromWallet');
const pad = extract(padSrc, 'spendFromWallet');
check('shop.js exposes spendFromWallet + wallet maths', !!shop);
check('heropad.js exposes spendFromWallet + wallet maths', !!pad);

if (shop && pad) {
  // Deterministic pseudo-random cases: same purses every run, so a failure is
  // reproducible rather than a once-a-week mystery.
  let seed = 20260816;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };

  const cases = [
    // The case the shop's comment is about: one platinum coin, small purchase.
    [{ yen: 0, pp: 1, gp: 0, ep: 0, sp: 0, cp: 0 }, 500],
    [{ yen: 300, pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 }, 300],   // exact loose yen
    [{ yen: 0, pp: 0, gp: 1, ep: 0, sp: 0, cp: 0 }, 1000],    // exact single coin
    [{ yen: 50, pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 }, 900],    // cannot afford
    [{ yen: 0, pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 }, 0],       // free, empty purse
    [{ yen: 100, pp: 2, gp: 3, ep: 1, sp: 5, cp: 9 }, 130],   // menu-priced coffee
    [{ yen: 0, pp: 0, gp: 0, ep: 0, sp: 1, cp: 0 }, 130],     // break the only coin
  ];
  for (let i = 0; i < 400; i++) {
    cases.push([
      { yen: rnd(3000), pp: rnd(3), gp: rnd(6), ep: rnd(4), sp: rnd(12), cp: rnd(20) },
      rnd(9000),
    ]);
  }

  let mismatch = null;
  let spent = 0, refused = 0;
  for (const [purse, cost] of cases) {
    const a = JSON.parse(JSON.stringify(purse));
    const b = JSON.parse(JSON.stringify(purse));
    const okA = shop.fn(a, cost);
    const okB = pad.fn(b, cost);
    if (okA !== okB || JSON.stringify(a) !== JSON.stringify(b)) {
      mismatch = { purse, cost, shop: { ok: okA, purse: a }, pad: { ok: okB, purse: b } };
      break;
    }
    if (okA) spent++; else refused++;
    // While we are here: a successful spend must remove exactly the cost in
    // value, and a refusal must leave the purse untouched.
    if (okA && shop.total(purse) - shop.total(a) !== cost) {
      mismatch = { purse, cost, note: 'value removed !== cost', after: a };
      break;
    }
    if (!okA && JSON.stringify(a) !== JSON.stringify(purse)) {
      mismatch = { purse, cost, note: 'refused spend still mutated the purse', after: a };
      break;
    }
  }

  check(`both copies of spendFromWallet agree across ${cases.length} purses`,
    !mismatch, JSON.stringify(mismatch));
  check('the cases exercise both outcomes', spent > 50 && refused > 5,
    `${spent} spent, ${refused} refused`);

  // The specific behaviour the duplication exists to preserve.
  const plat = { yen: 0, pp: 1, gp: 0, ep: 0, sp: 0, cp: 0 };
  pad.fn(plat, 500);
  check('a 500-yen order does not melt a platinum coin into small change',
    plat.pp === 0 && plat.yen === 9500, JSON.stringify(plat));
}

/* ── Ordering food is a request, not a write ────────────────────── */
// The Eats app used to spend from the purse itself. It cannot any more —
// inventories/{file} refuses every client write — so what this checks is
// that the client asks the server and sends no price of its own. The
// server-side half is covered in verify-functions.js.
const orderFn = padSrc.match(/async function orderFood\([\s\S]*?\n\}/);
check('heropad.js defines orderFood()', !!orderFn);
if (orderFn) {
  const body = orderFn[0];
  check('an order calls the spend function', /fbCall\('spend'/.test(body));
  check('it sends an id and a quantity, never a price',
    /lines: \[\{ id, qty: 1 \}\]/.test(body) && !/\bprice\s*:/.test(body),
    'a client-supplied price is a suggestion the server would be wrong to take');
  check('it names itself as the eats source', /source: 'eats'/.test(body));
  check('it never writes the purse directly',
    !/tx\.set|runTransaction/.test(body));
  check('a failed order is reported to the player', /eatsStatus =/.test(body));
}

/* ── Shared documents nothing else should be writing ────────────── */
check('the whiteboard merges strokes per id',
  /fsMergeSave\(FS_BOARD_DOC[\s\S]{0,120}idKey: 'id'/.test(padSrc),
  'without per-item merge, two people drawing at once lose one drawing');
check('messages merge per id',
  /fsMergeSave\(FS_MSG_DOC[\s\S]{0,120}idKey: 'id'/.test(padSrc),
  'without per-item merge, two people typing at once lose a line');
check('a live board update never lands mid-stroke',
  /_boardSaveInFlight \|\| _boardDrawing/.test(padSrc),
  'a remote snapshot applied while drawing pulls the line out from under the pen');

console.log(failed ? `>>> ${failed} check(s) failed` : '>>> Eats + shared surfaces OK');
process.exit(failed ? 1 : 0);
