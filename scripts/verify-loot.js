#!/usr/bin/env node
// Regression check for the DM loot tables (CAMPAIGN/loot.json + loot.html/js).
//
// What it guards:
//   1. The shape: eight tables of rows that fill their own die, with no gaps,
//      no duplicate rolls, and nothing claiming a tier the file hasn't
//      declared. A d10 table with nine rows is a roll that lands on nothing.
//   2. Every item is grounded. The campaign is the source of truth, so the
//      names these tables lean on have to appear in it — an item hanging off
//      an NPC or faction that does not exist is the one failure mode that
//      matters in a file of invented objects.
//   3. The Underground tables carry the rule the campaign's own shop appendix
//      states: those items are handed out, never bought. Keeping them off the
//      shop page is what keeps the Underground hidden, and nothing here may
//      quietly contradict that — including by appearing in the shop.
//   4. The page escapes everything, rolls inside its die, and is reachable
//      from the DM block of the dashboard rather than the shared part.

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log('PASS — ' + label); return; }
  failures++;
  console.error('FAIL — ' + label + (detail ? '\n        ' + detail : ''));
}

const doc = JSON.parse(read('CAMPAIGN/loot.json'));
const tables = doc.tables || [];
const allItems = tables.flatMap(t => (t.items || []).map(i => ({ ...i, table: t })));

/* ── 1. the shape ── */
{
  check('there are loot tables to roll on', tables.length >= 5, tables.length + ' tables');
  check('and a good number of items in them', allItems.length >= 50, allItems.length + ' items');
  check('the file declares its tiers', Array.isArray(doc.tiers) && doc.tiers.length >= 3);

  const badTable = tables.filter(t => !t.id || !t.name || !t.die || !Array.isArray(t.items) || !t.items.length);
  check('every table has an id, a name, a die and items',
    badTable.length === 0, badTable.map(t => t.id || '(no id)').join(', '));

  const ids = tables.map(t => t.id);
  check('table ids are unique', new Set(ids).size === ids.length,
    ids.filter((v, i) => ids.indexOf(v) !== i).join(', '));

  const badItem = allItems.filter(i => !i.name || !i.effect || !i.hook || !i.tier || !Number.isInteger(i.roll));
  check('every item has a roll, a name, an effect, a hook and a tier',
    badItem.length === 0, badItem.map(i => i.name || '(unnamed)').join(', '));

  const strayTier = [...new Set(allItems.filter(i => !doc.tiers.includes(i.tier)).map(i => i.tier))];
  check('no item claims a tier the file has not declared', strayTier.length === 0, strayTier.join(', '));
  const unusedTier = doc.tiers.filter(t => !allItems.some(i => i.tier === t));
  check('and every declared tier is used', unusedTier.length === 0, unusedTier.join(', '));

  // A d10 table with nine rows is a roll that lands on nothing.
  const broken = [];
  for (const t of tables) {
    const size = Number(String(t.die).replace(/^d/i, ''));
    const rolls = (t.items || []).map(i => i.roll).sort((a, b) => a - b);
    if (!Number.isFinite(size) || size < 1) { broken.push(`${t.id}: die "${t.die}"`); continue; }
    if (rolls.length !== size) broken.push(`${t.id}: ${t.die} with ${rolls.length} rows`);
    if (new Set(rolls).size !== rolls.length) broken.push(`${t.id}: duplicate rolls`);
    for (let n = 1; n <= size; n++) if (!rolls.includes(n)) broken.push(`${t.id}: nothing on ${n}`);
  }
  check('every table is filled from 1 to its own die, once each',
    broken.length === 0, [...new Set(broken)].join('\n        '));

  const longEffect = allItems.filter(i => i.effect.length > 420);
  check('an effect is a ruling a DM can say out loud, not a stat block',
    longEffect.length === 0, longEffect.map(i => i.name).join(', '));
}

/* ── 2. grounded in the campaign ── */
{
  // Every proper name these tables lean on has to exist in the campaign text.
  // An item hanging off an NPC who does not exist is the only way a file of
  // invented objects can actually be wrong.
  const campaignText = JSON.parse(read('CAMPAIGN/campaigns.json')).campaigns
    .flatMap(c => [
      ...(c.background || []).map(b => b.body),
      ...(c.appendix || []).map(a => a.body),
      ...(c.chapters || []).flatMap(ch => [ch.intro, ch.dmNote, ch.milestone, ch.closing && ch.closing.body,
        ...(ch.sections || []).flatMap(s => [s.body, s.dmNote, s.developments, s.treasure, s.readAloud]),
        ...(ch.sidequests || []).flatMap(q => [q.body, q.reward])]),
    ]).filter(Boolean).join('\n');

  const names = ['Brick', 'Imai', 'Tobe Miyu', 'Kōno Sae', 'Madame Tsuru', 'Yanagi Daichi', 'Fukami',
    'Alucard', 'Hiruma Clinic', 'Crimson Room', 'Akabane', 'Legionary', 'Thrall',
    'Sunbreath', 'Envoy', 'arrowhead', 'Hōshō Kaito', 'Hinata', 'Joestar', 'Throne',
    'Sumi', 'Veil', 'Kegare', 'Kurama Rite School', 'Shirasagi Rei', 'Pact',
    'Writ', 'Arrear', 'First Desk', 'Yanaka', 'Mark',
    'Nobara Forge', 'Hiro', 'Bose', 'Rawagi Chiso', 'Clean Read', 'keepsake',
    'Aikawa Sakume', 'Toragi Kayo', 'Setaka Toko', 'Samitsu', 'Kinji Hamakida', 'Masahata Shikoji',
    'Otowa Suzume', 'Okabe Fumi', 'Nakata', 'Sugitsu', 'Chozen'];
  const missing = names.filter(n => !campaignText.includes(n));
  check('every name the tables lean on exists in the campaign',
    missing.length === 0, missing.join(', '));

  // And the hooks have to point somewhere: a hook that says nothing about
  // where the thing came from is decoration.
  const thinHook = allItems.filter(i => i.hook.length < 40);
  check('every hook actually says where the thing comes from',
    thinHook.length === 0, thinHook.map(i => i.name).join(', '));
}

/* ── 3. the Underground stays off the shop ── */
{
  const underground = ['legion', 'court', 'kuroshiki', 'ledger'];
  const found = underground.filter(id => tables.some(t => t.id === id));
  check('the four Underground societies each have a table', found.length === 4, found.join(', '));

  const noRule = underground.filter(id => {
    const t = tables.find(x => x.id === id);
    return t && !/never purchasable/i.test(t.rule || '');
  });
  check('and each one repeats that its items are handed out, never bought',
    noRule.length === 0, noRule.join(', '));

  // The campaign says so itself, and that sentence has to still be there.
  const city = JSON.parse(read('CAMPAIGN/campaigns.json')).campaigns.find(c => c.id === 'after-hours-the-city');
  const shopNote = (city.appendix || []).find(a => a.heading.startsWith('The shop'));
  check('the campaign still says the Underground is not in the shop',
    shopNote && /WHAT IS NOT IN THE SHOP/.test(shopNote.body),
    'if that rule ever changes, these tables are the second place to fix');

  // And none of them has quietly turned up for sale.
  const shop = JSON.parse(read('CAMPAIGN/shop-catalog.json'));
  const forSale = (shop.items || []).filter(s =>
    allItems.some(i => i.table && underground.includes(i.table.id) && i.name.toLowerCase() === String(s.name).toLowerCase()));
  check('and no Underground item is on sale in the shop',
    forSale.length === 0, forSale.map(s => s.name).join(', '));
}

/* ── 4. the page ── */
{
  const js = read('loot.js');
  const html = read('loot.html');
  check('the page reads the tables', /fetch\('CAMPAIGN\/loot\.json'/.test(js));
  check('it loads no Firebase — the tables are a static file',
    !/firebasejs/.test(html) && !/auth\.js/.test(html));
  check('a failed load says so rather than showing an empty page',
    /load-error-banner/.test(js) && /load-error-banner/.test(html));
  for (const field of ['i.name', 'i.effect', 'i.hook', 'i.tier', 'i.roll', 'table.name', 'table.note', 'table.rule']) {
    check(`the page escapes ${field}`, js.includes(`escHtml(${field})`));
  }
  check('a roll stays inside the table\'s own die',
    /1 \+ Math\.floor\(Math\.random\(\) \* size\)/.test(js) && /dieSize\(table\.die\)/.test(js));
  check('and a roll ignores the filters, because a die that only lands on what you filtered to is not a die',
    /ignores the search and the tier filter/.test(js));
  for (const id of [...js.matchAll(/getElementById\('([^'${]+)'\)/g)].map(m => m[1])) {
    check(`#${id} exists in the page`, html.includes(`id="${id}"`));
  }
  const css = read('css/pages/loot.css');
  for (const sel of ['.loot-row', '.loot-row.is-rolled', '.loot-rule', '.loot-hook', '.tier-unique']) {
    check(`${sel} is styled`, css.includes(sel));
  }
}

/* ── 5. DM side only ── */
{
  const index = read('index.html');
  const dmStart = index.indexOf('<div id="dm-only">');
  const link = index.indexOf('href="loot.html"');
  check('the dashboard links to the loot tables', link !== -1);
  check('and the link is inside the DM block, not the shared part',
    dmStart !== -1 && link > dmStart, `dm-only at ${dmStart}, link at ${link}`);
}

console.log(failures ? `\n>>> loot FAILED (${failures})` : '\n>>> loot OK');
process.exit(failures ? 1 : 0);
