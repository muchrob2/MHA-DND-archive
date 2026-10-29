#!/usr/bin/env node
// Regression check for tonight.html — the run sheet.
//
// This page is the one that is open while a session is actually running, and
// it is assembled from five sources it does not own. That is its value and
// its risk: every field it reads is a field somebody else writes, and
// reading the wrong one prints "undefined" in front of a table.
//
// What it guards:
//   1. It reads the right field names. A side quest is recorded under `name`,
//      not `title` — the first draft of this page read `title` and printed
//      "undefined" for every quest on the sheet.
//   2. It prefers the LIVE campaign and says when it fell back, because
//      editing the repo file does not publish anything.
//   3. The "next time" note — the one field that must never reach a player —
//      appears here, which is the DM's page, and the dashboard link is
//      inside the DM block.
//   4. It survives the shapes the data actually takes: a campaign with no
//      chapters, a chapter with no sections, a chapter id from a different
//      campaign, and no session log at all.
//   5. The notes save, and do not when there is nobody to save them for.
//   6. Everything printed is escaped.

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

const pageJs = read('tonight.js');
const pageHtml = read('tonight.html');
const pageCss = read('css/pages/tonight.css');

const els = {};
const mk = () => ({ innerHTML: '', textContent: '', value: '' });
for (const id of ['rs-pickers', 'rs-last', 'rs-order', 'rs-quests', 'rs-heat', 'rs-encounters',
  'rs-notes-wrap', 'rs-notes', 'rs-save-state', 'rs-source']) els[id] = mk();

const store = {};
const written = [];
const STATE = { admin: true, docs: {} };

function build() {
  for (const k of Object.keys(els)) { els[k].innerHTML = ''; els[k].textContent = ''; }
  written.length = 0;
  for (const k of Object.keys(store)) delete store[k];
  return new Function('sandbox', `
    const { document, localStorage, console } = sandbox;
    ${read('byakko-data.js')}
    ${read('CLASS-1A/board-prefabs.js')}
    const firebase = { firestore: () => ({ collection: () => ({ doc: (n) => ({
      get: () => Promise.resolve(sandbox.docs()[n] || { exists: false }),
      set: (d, o) => { sandbox.written.push([n, JSON.parse(JSON.stringify(d)), o]); return Promise.resolve(); },
    }) }) }) };
    const fbAuthReady = Promise.resolve();
    const window = { isAdmin: () => sandbox.admin() };
    const fetch = (p) => sandbox.fetch(p);
    ${pageJs.slice(0, pageJs.lastIndexOf('(async () => {'))}
    return { render, loadAll, pickCampaign, pickChapter, setNotes,
             currentCampaign, currentChapter,
             set campaigns(v) { campaigns = v; }, set sessions(v) { sessions = v; },
             set heat(v) { heat = v; }, set groups(v) { groups = v; },
             set canWrite(v) { canWrite = v; }, set loaded(v) { loaded = v; }, mapLabel,
             get runDoc() { return runDoc; }, set runDoc(v) { runDoc = v; },
             get sources() { return sources; } };
  `)({
    document: { getElementById: (i) => els[i] || null, get activeElement() { return null; } },
    localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } },
    console: { error() {}, log() {} },
    admin: () => STATE.admin,
    docs: () => STATE.docs,
    written,
    fetch: (p) => Promise.resolve({ json: () => Promise.resolve(JSON.parse(read(p))) }),
  });
}

const P = (id) => els[id].innerHTML.replace(/\s+/g, ' ');
const repoCampaigns = JSON.parse(read('CAMPAIGN/campaigns.json')).campaigns;
const shortlist = repoCampaigns.find(c => c.id === 'the-shortlist-after-hours');

/* ── 1. the right field names, against the real campaign ── */
(async () => {
  let env = build();
  STATE.admin = true;
  STATE.docs = {
    campaigns: { exists: false },  // force the bundled fallback
    'session-log': { exists: true, data: () => ({ sessions: [{
      number: 4, date: '2026-10-21', title: 'The Cage, floor three',
      present: ['First PC', 'Second PC'], recap: 'They climbed and stopped.',
      npcs: ['A Stripe'], places: ['The Cage'], xp: 900,
      next: 'Somebody turns up with a phone on a crate.' }] }) },
    heat: { exists: true, data: () => ({ heat: 7, chapter: 6, beaten: { genda: { at: 1 }, nagira: { at: 2 } } }) },
    'run-sheet': { exists: false },
  };
  await env.loadAll();
  env.canWrite = true;
  env.render();

  // The chapter with the most in it, so the badges and the quests are
  // actually exercised rather than passing on an empty chapter.
  const rich = shortlist.chapters.find(ch => (ch.sidequests || []).length >= 3
    && (ch.sections || []).some(s => s.type === 'encounter'));
  env.pickCampaign(shortlist.id);
  env.pickChapter(rich.id);

  check('every section of the chapter is on the running order',
    (P('rs-order').match(/class="rs-step type-/g) || []).length === rich.sections.length,
    `${(P('rs-order').match(/class="rs-step type-/g) || []).length} of ${rich.sections.length}`);
  check('and each one carries the tag that says how long it takes',
    rich.sections.filter(s => s.tag).every(s => P('rs-order').includes(s.tag.slice(0, 30))));
  check('an encounter is badged as a fight',
    /rs-step type-encounter/.test(P('rs-order')) && P('rs-order').includes('Fight'));
  check('the chapter\'s note to the DM is at the top, before the order',
    P('rs-order').indexOf('rs-dmnote') >= 0
    && P('rs-order').indexOf('rs-dmnote') < P('rs-order').indexOf('rs-step'));
  check('and the milestone is at the bottom',
    /rs-milestone/.test(P('rs-order'))
    && P('rs-order').indexOf('rs-milestone') > P('rs-order').indexOf('rs-step'));

  // The field-name bug this check exists for.
  const questNames = (rich.sidequests || []).map(q => q.name).filter(Boolean);
  const missingQuests = questNames.filter(n => !P('rs-quests').includes(n));
  check('every side quest is named — its own name, out of the right field',
    (P('rs-quests').match(/class="rs-quest"/g) || []).length === rich.sidequests.length
    && questNames.length === rich.sidequests.length
    && missingQuests.length === 0,
    missingQuests.length ? 'not shown: ' + missingQuests.join(' | ')
      : 'a side quest is recorded under `name`; the first draft read `title`, '
        + 'and checking for the word "undefined" could not catch that because '
        + 'the fallback prints "Untitled" instead');
  check('with its giver, what it costs in slots, and what it pays',
    rich.sidequests.filter(q => q.giver).every(q => P('rs-quests').includes(q.giver))
    && P('rs-quests').includes('Pays'));

  /* ── 2. live first, and say when it is not ── */
  check('the live campaign document is read before the bundled file',
    pageJs.indexOf("FS_CAMPAIGNS.get()") < pageJs.indexOf("fetch('CAMPAIGN/campaigns.json')"),
    'editing the repo file does not publish anything');
  check('and the page says which one it got',
    env.sources.campaigns === 'bundled'
    && /could not be reached/.test(els['rs-source'].textContent),
    els['rs-source'].textContent);

  STATE.docs.campaigns = { exists: true, data: () => ({ campaigns: repoCampaigns }) };
  const live = build();
  await live.loadAll();
  live.render();
  check('with the live copy available it uses that and says so',
    live.sources.campaigns === 'live' && /live copy/.test(els['rs-source'].textContent),
    els['rs-source'].textContent);

  /* ── 3. the note that must not reach a player ── */
  check('the "next time" note from the session log is on this page',
    /rs-next/.test(P('rs-last')) && P('rs-last').includes('phone on a crate'),
    'this is the DM\'s page, which is the only place it belongs');
  const pad = read('heropad.js');
  check('and still nowhere near the Heropad',
    !/\.next\b/.test(pad.slice(pad.indexOf('function renderRecapsApp'), pad.indexOf('function recapReadKey'))),
    'verify-heropad.js guards this too — two pages now have to keep it true');
  const index = read('index.html');
  const dmStart = index.indexOf('<div id="dm-only">');
  const dmEnd = index.indexOf('<p class="section-label">Rulebooks');
  const link = index.indexOf('href="tonight.html"');
  check('the dashboard link is inside the DM block',
    link > dmStart && link < dmEnd, `link ${link}, block ${dmStart}–${dmEnd}`);

  /* ── 4. the shapes the data actually takes ── */
  const odd = build();
  odd.campaigns = [
    { id: 'empty', title: 'No chapters at all', chapters: [] },
    { id: 'bare', title: 'A chapter with nothing in it', chapters: [{ id: 'c1', title: 'Bare' }] },
  ];
  odd.sessions = [];
  odd.heat = null;
  odd.groups = [];
  odd.loaded = true;
  odd.runDoc = { campaignId: 'empty', chapterId: '', notes: '' };
  odd.render();
  check('a campaign with no chapters renders without throwing',
    els['rs-pickers'].innerHTML.length > 0 && !/undefined/.test(P('rs-order')));
  odd.pickCampaign('bare');
  check('a chapter with no sections says so rather than showing an empty list',
    /no sections written/i.test(P('rs-order')) && /No side quests/.test(P('rs-quests')));
  check('no session log yet points at where to write one',
    /session-log\.html/.test(P('rs-last')));
  check('no Heat yet points at the Heat page',
    /heat\.html/.test(P('rs-heat')));
  check('and no encounter presets says that too',
    /No encounter presets/.test(P('rs-encounters')));

  // A chapter id left over from another campaign must not blank the page.
  odd.runDoc = { campaignId: 'bare', chapterId: 'a-chapter-from-somewhere-else', notes: '' };
  check('a chapter id from a different campaign falls back to the first chapter',
    odd.currentChapter() && odd.currentChapter().id === 'c1');
  odd.pickCampaign('empty');
  check('and switching to a campaign with no chapters leaves no stale chapter',
    odd.currentChapter() === null && odd.runDoc.chapterId === '');

  /* the Heat block reads the track's own helpers rather than a second copy */
  const heated = build();
  heated.campaigns = repoCampaigns;
  heated.heat = { heat: 9, chapter: 6, beaten: { a: 1 } };
  heated.groups = JSON.parse(read('CAMPAIGN/enemies.json')).groups;
  heated.loaded = true;
  heated.render();
  check('the Heat block shows the level, who is home, and what is next',
    /rs-heat-num">9/.test(P('rs-heat')) && /A Corner/.test(P('rs-heat'))
    && /At 10/.test(P('rs-heat')), P('rs-heat').slice(0, 120));
  check('and it comes from byakko-data.js rather than a second copy of the bands',
    /heatBandFor\(/.test(pageJs) && /heatNextBand\(/.test(pageJs) && /heatClamp\(/.test(pageJs));
  check('a chapter cap is applied to the number it shows',
    (() => {
      heated.heat = { heat: 9, chapter: 2 };
      heated.render();
      return /rs-heat-num">3/.test(P('rs-heat'));
    })(), 'Chapter 2 caps Heat at 3, and this page must not print 9');

  check('the arc\'s encounters are listed in step order with their preset map',
    (() => {
      heated.heat = null;
      heated.render();
      const steps = [...P('rs-encounters').matchAll(/rs-enc-step">(\d+)/g)].map(m => Number(m[1]));
      const sorted = steps.slice().sort((a, b) => a - b);
      return steps.length >= 8 && steps.join() === sorted.join()
        && /Rooftop Chase/.test(P('rs-encounters'));
    })(), 'the map keys the groups name all resolve to preset labels');
  check('and a key with no preset behind it shows the key rather than a blank',
    env.mapLabel('no-such-map') === 'no-such-map' && env.mapLabel('rooftops') === 'Rooftop Chase'
    && env.mapLabel('') === '' && env.mapLabel(null) === '',
    JSON.stringify([env.mapLabel('no-such-map'), env.mapLabel('rooftops')]));

  /* ── 5. the notes ── */
  const noted = build();
  noted.campaigns = repoCampaigns;
  noted.loaded = true;
  noted.canWrite = true;
  noted.render();
  noted.setNotes('Start on the roof.');
  check('typing a note records it and says it is saved',
    noted.runDoc.notes === 'Start on the roof.'
    && /Saved/.test(els['rs-save-state'].textContent));
  await new Promise(r => setTimeout(r, 900));
  check('and it reaches the server',
    written.some(w => w[0] === 'run-sheet' && w[1].notes === 'Start on the roof.'),
    JSON.stringify(written.map(w => w[0])));
  check('merged rather than replacing the document',
    written.filter(w => w[0] === 'run-sheet').every(w => w[2] && w[2].merge === true));
  check('and kept in this browser as well, so a reload remembers it',
    !!store['mha-run-sheet-v1'] && JSON.parse(store['mha-run-sheet-v1']).notes === 'Start on the roof.');

  const readonly = build();
  readonly.campaigns = repoCampaigns;
  readonly.loaded = true;
  readonly.canWrite = false;
  readonly.render();
  readonly.setNotes('a note with nobody to save it for');
  await new Promise(r => setTimeout(r, 900));
  check('with no write access nothing is sent, and the page says why',
    !written.some(w => w[0] === 'run-sheet')
    && /this browser/.test(els['rs-notes-wrap'].innerHTML),
    JSON.stringify(written.map(w => w[0])));
  check('a failed save is said out loud rather than swallowed',
    /console\.error/.test(pageJs) && /could not save/.test(pageJs));
  check('and the notes box is not re-rendered while it is being typed in',
    /document\.activeElement !== box/.test(pageJs),
    'replacing innerHTML destroys the caret and anything half-typed');

  /* ── 6. escaping ── */
  const nasty = build();
  nasty.campaigns = [{
    id: 'x', title: '<img src=x onerror=alert(1)>',
    chapters: [{ id: 'c', number: 1, title: '<script>t</script>', dmNote: '<b>d</b>',
      milestone: '<u>m</u>', estimate: '<i>e</i>',
      sections: [{ heading: '<iframe>', type: 'encounter', tag: '<svg/>', readAloud: '<b>r</b>' }],
      sidequests: [{ id: 'q', name: '<script>q</script>', giver: '<b>g</b>', slots: '<i>s</i>',
        hook: '<u>h</u>', body: '<b>b</b>', reward: '<svg/>' }] }],
  }];
  nasty.sessions = [{ number: '<b>1</b>', title: '<script>s</script>', recap: '<iframe>',
    present: ['<svg/>'], npcs: ['<b>n</b>'], places: ['<i>p</i>'], next: '<script>x</script>' }];
  nasty.heat = { heat: 5, chapter: 6 };
  nasty.groups = [{ id: 'g', name: '<script>g</script>', arc: '<b>a</b>', step: 1, map: '<iframe>', members: [] }];
  nasty.loaded = true;
  nasty.runDoc = { campaignId: 'x', chapterId: 'c', notes: '<script>n</script>' };
  nasty.render();
  const page = Object.values(els).map(e => e.innerHTML).join('');
  // An attribute cannot exist outside a tag, so a surviving tag is what
  // decides it. <b> and <i> are included because this page's own markup uses
  // neither — any here would be injected.
  const tags = page.match(/<(script|img|iframe|svg|b|i|u)[ >/]/g) || [];
  check('nothing in the campaign, the log or the presets can become a tag',
    tags.length === 0, [...new Set(tags)].join(' '));
  check('and it all comes back as entities',
    page.includes('&lt;iframe&gt;') && page.includes('&lt;script&gt;'));

  /* the page */
  check('the page loads the Heat bands and the map labels before its own script',
    pageHtml.indexOf('src="byakko-data.js"') < pageHtml.indexOf('src="tonight.js"')
    && pageHtml.indexOf('src="CLASS-1A/board-prefabs.js"') < pageHtml.indexOf('src="tonight.js"'));
  const reachedFor = [...new Set([...pageJs.matchAll(/getElementById\('([^'${]+)'\)/g)].map(m => m[1]))];
  const nowhere = reachedFor.filter(id =>
    !pageHtml.includes(`id="${id}"`) && !pageJs.includes(`id="${id}"`));
  check('every element it reaches for exists somewhere it renders',
    nowhere.length === 0, nowhere.join(', '));
  for (const sel of ['.rs-next', '.rs-step.type-encounter', '.rs-heat.mood-hot', '.rs-quest-name', '.rs-milestone']) {
    check(`${sel} is styled`, pageCss.includes(sel));
  }
  // Last, deliberately: build() resets the stub elements, so running this in
  // the middle of the file wiped the HTML every later check was reading.
  check('a first visit opens the campaign with the most written in it',
    (() => {
      const fresh = build();
      fresh.campaigns = repoCampaigns;
      fresh.runDoc = { campaignId: '', chapterId: '', notes: '' };
      return fresh.currentCampaign().id === 'the-shortlist-after-hours';
    })(),
    'not the one with the most chapters — the full campaign and its short '
    + 'summary have eight each, and on that measure the summary won the tie');

  check('the page says that nothing on it is a second copy of anything',
    /Change any of them in its own/.test(pageHtml),
    'the running order, the recap, the Heat and the presets each live elsewhere');

  console.log(failures ? `\n>>> run sheet FAILED (${failures})` : '\n>>> run sheet OK');
  process.exit(failures ? 1 : 0);
})().catch(err => {
  console.error('FAIL — the run sheet checks threw rather than reporting\n        '
    + (err && err.stack || err));
  console.error('\n>>> run sheet FAILED (threw)');
  process.exit(1);
});
