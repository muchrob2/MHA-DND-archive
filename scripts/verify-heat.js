#!/usr/bin/env node
// Regression check for heat.html — the Byakko Heat track.
//
// Why this needs a verifier of its own: every number and every name on that
// page is transcribed from the campaign, and a transcription is exactly the
// kind of thing that drifts silently. If the appendix says a Corner comes
// down at 8 and the page says 9, nothing looks broken — the table just plays
// a different campaign from the one that was written.
//
// What it guards:
//   1. The track: 0 to 10, six bands, the caps per chapter, and the triggers
//      with the deltas the appendix gives them.
//   2. Every name in byakko-data.js exists in the campaign text, and the Law
//      is the six rules the campaign puts on the wall — the same grounding
//      rule the loot tables are held to.
//   3. The arithmetic: a cap can only ever lower Heat, a trigger logs why,
//      undo puts it back, and nothing leaves 0..10.
//   4. The tease. The page's whole reason to exist beyond a strip of paper is
//      naming what is coming, so it has to do that at every level.
//   5. A reader cannot move it, and firestore.rules — not the page — is what
//      stops them.
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

const dataJs = read('byakko-data.js');
const pageJs = read('heat.js');
const pageHtml = read('heat.html');
const pageCss = read('css/pages/heat.css');

const D = new Function(dataJs + `
  return { HEAT_MIN, HEAT_MAX, HEAT_BANDS, HEAT_TRIGGERS, HEAT_CAPS, BYAKKO_LAW,
           BYAKKO_SEVENTH_SUGGESTION, BYAKKO_RANKS, heatBandFor, heatNextBand,
           heatCapFor, heatClamp, byakkoMember, byakkoAllMembers };`)();

/* ── 1. the track ── */
{
  check('the track is 0 to 10, as the appendix says',
    D.HEAT_MIN === 0 && D.HEAT_MAX === 10);
  check('every level on the track falls in exactly one band',
    (() => {
      for (let n = 0; n <= 10; n++) {
        const hits = D.HEAT_BANDS.filter(b => n >= b.from && n <= b.to);
        if (hits.length !== 1) return false;
      }
      return true;
    })(), 'a level in two bands or none is a level the page cannot describe');
  check('the bands run 0-1, 2-3, 4-5, 6-7, 8-9, 10',
    JSON.stringify(D.HEAT_BANDS.map(b => [b.from, b.to]))
      === JSON.stringify([[0, 1], [2, 3], [4, 5], [6, 7], [8, 9], [10]].map(x => x.length === 1 ? [x[0], x[0]] : x)));
  check('every band says who shows up, and carries a mood the CSS can colour',
    D.HEAT_BANDS.every(b => b.who && b.who.trim() && ['quiet', 'warm', 'hot'].includes(b.mood)),
    // No minimum length: the 8-9 band's whole entry is "A Corner.", which is
    // the campaign's own wording and does not need padding out.
    JSON.stringify(D.HEAT_BANDS.filter(b => !b.who || !['quiet', 'warm', 'hot'].includes(b.mood))));

  const deltas = Object.fromEntries(D.HEAT_TRIGGERS.map(t => [t.id, t.delta]));
  check('the triggers carry the deltas the appendix gives them',
    deltas.ranked === 1 && deltas.ring === 2 && deltas.holding === 1
    && deltas.quiet === -1 && deltas.lostcorner === -1 && deltas.lostrank === -2,
    JSON.stringify(deltas));
  check('and each one says what it is for',
    D.HEAT_TRIGGERS.every(t => t.id && t.label && t.note));

  check('the caps are 3 in Chapter 2, 5 in 3, 7 in 4 and 5, and none from 6',
    D.heatCapFor(2) === 3 && D.heatCapFor(3) === 5 && D.heatCapFor(4) === 7
    && D.heatCapFor(5) === 7 && D.heatCapFor(6) === null && D.heatCapFor(7) === null,
    JSON.stringify(D.HEAT_CAPS));

  check('the Law is six rules, the sixth about kids without a stripe',
    D.BYAKKO_LAW.length === 6 && /stripe yet/.test(D.BYAKKO_LAW[5]));
  check('and a seventh is only ever a suggestion until the class write one',
    /You climb with what/.test(D.BYAKKO_SEVENTH_SUGGESTION));
}

/* ── 2. grounded in the campaign ── */
{
  const campaignText = JSON.parse(read('CAMPAIGN/campaigns.json')).campaigns
    .flatMap(c => [
      ...(c.background || []).map(b => b.body),
      ...(c.appendix || []).map(a => a.body),
      ...(c.chapters || []).flatMap(ch => [ch.intro, ch.dmNote, ch.milestone,
        ch.closing && ch.closing.body,
        ...(ch.sections || []).flatMap(s => [s.body, s.dmNote, s.developments, s.treasure, s.readAloud]),
        ...(ch.sidequests || []).flatMap(q => [q.body, q.reward])]),
    ]).filter(Boolean).join('\n');

  const members = D.byakkoAllMembers();
  check('there are enough named Byakko to be worth a roster',
    members.length >= 18, members.length + ' named');

  const missingName = members.filter(m => !campaignText.includes(m.name));
  check('every Byakko named on the page exists in the campaign',
    missingName.length === 0, missingName.map(m => m.name).join(', '));
  // Case-insensitively: the middle-ranks appendix shouts the street names
  // (MURASE KOTOHA, "NETTLE") and this file title-cases them.
  const haystack = campaignText.toLowerCase();
  const missingAlias = members.filter(m => m.alias && !haystack.includes(m.alias.toLowerCase()));
  check('and so does every street name they are given',
    missingAlias.length === 0, missingAlias.map(m => m.alias).join(', '));

  const ids = members.map(m => m.id);
  check('member ids are unique — they key the "beaten" record',
    new Set(ids).size === ids.length, ids.filter((v, i) => ids.indexOf(v) !== i).join(', '));
  check('every member has a line saying who they are',
    members.every(m => m.note && m.note.length > 25));

  /* The band text, against the appendix's own WHO SHOWS UP list.
   *
   * Without this the band strings were transcribed and never checked, and
   * changing the 8-9 band from "A Corner." to "A Fang." failed nothing — the
   * page would have told the table a Fang was coming when the campaign says
   * a Corner is. That is the single worst thing this file could get wrong.
   */
  {
    const appendix = JSON.parse(read('CAMPAIGN/campaigns.json')).campaigns
      .find(c => c.id === 'after-hours-the-city').appendix
      .find(a => /Stripe Law and the Heat/.test(a.heading));
    const lines = appendix.body.split('\n')
      .filter(l => /HEAT \d/.test(l))
      .map(l => ({
        // "· HEAT 4–5 — a Fang (Brick…" → { from: 4, text: 'a Fang (Brick…' }
        from: Number((l.match(/HEAT (\d+)/) || [])[1]),
        text: l.replace(/^[^—]*—\s*/, '').toLowerCase(),
      }));
    check('the appendix still has a WHO SHOWS UP list to check against',
      lines.length === D.HEAT_BANDS.length, lines.length + ' lines for ' + D.HEAT_BANDS.length + ' bands');

    const drifted = [];
    for (const band of D.HEAT_BANDS) {
      const line = lines.find(l => l.from === band.from);
      if (!line) { drifted.push(`no appendix line for Heat ${band.from}`); continue; }
      // Every substantial word of the band text has to appear on its own
      // line in the appendix. Short words are skipped because "a", "or" and
      // "with" are on every line and prove nothing.
      const words = band.who.toLowerCase().match(/[a-z\u00c0-\u024f]{4,}/g) || [];
      const absent = words.filter(w => !line.text.includes(w));
      if (absent.length) drifted.push(`Heat ${band.from}: "${absent.join(', ')}" is not on the appendix's line`);
    }
    check('every band says what the appendix says for that band',
      drifted.length === 0, drifted.join('\n        '));
  }

  check('the ranks are the six the Law lists',
    D.BYAKKO_RANKS.map(r => r.id).join() === 'claw,fang,stripe,four,corner,tiger',
    D.BYAKKO_RANKS.map(r => r.id).join());
  check('and the stripe counts climb with them',
    D.BYAKKO_RANKS.every((r, i, all) => i === 0 || r.stripes >= all[i - 1].stripes));
  check('there are four Corners, and one Tiger',
    D.BYAKKO_RANKS.find(r => r.id === 'corner').members.length === 4
    && D.BYAKKO_RANKS.find(r => r.id === 'tiger').members.length === 1);

  for (const rule of D.BYAKKO_LAW) {
    // The Law is quoted, so it has to be quoted right. The apostrophe is the
    // trap that has caught this repo before.
    // Case-insensitively, for the same reason: the campaign introduces the
    // sixth as "And, newest: nobody fights a kid who has not got a stripe yet."
    const core = rule.replace(/\.$/, '').toLowerCase();
    check(`the Law's "${rule.slice(0, 34)}…" is in the campaign`,
      haystack.includes(core), rule);
  }
}

/* ── 3. the arithmetic ── */
{
  check('nothing leaves the track',
    D.heatClamp(-9, 6) === 0 && D.heatClamp(99, 6) === 10 && D.heatClamp(4.6, 6) === 5);
  check('a chapter cap lowers Heat and never raises it',
    D.heatClamp(9, 2) === 3 && D.heatClamp(1, 2) === 1 && D.heatClamp(9, 4) === 7);
  check('and from Chapter 6 there is no cap at all',
    D.heatClamp(10, 6) === 10 && D.heatClamp(10, 8) === 10);

  // The page's own state machine, driven.
  const els = {};
  const mk = () => ({ innerHTML: '', textContent: '', className: '', value: '', disabled: false });
  for (const id of ['heat-track', 'heat-who', 'heat-coming', 'heat-controls', 'heat-d6',
    'heat-record', 'heat-fight-form', 'heat-gang', 'heat-log', 'heat-law', 'heat-level-badge',
    'heat-fight-pc', 'heat-fight-opp', 'heat-fight-where', 'heat-fight-feedback', 'heat-seventh']) {
    els[id] = mk();
  }
  const store = {};
  const env = new Function('sandbox', `
    const { document, localStorage, console } = sandbox;
    ${dataJs}
    ${read('dice.js')}
    const firebase = { firestore: () => ({ collection: () => ({ doc: () => ({
      get: () => Promise.resolve({ exists: false }), onSnapshot() {} }) }) }) };
    const fbAuthReady = Promise.resolve();
    function fsCloneDoc(d) { return JSON.parse(JSON.stringify(d)); }
    function fsMergeSave() { return Promise.resolve(null); }
    const window = { isAdmin: () => sandbox.admin };
    ${pageJs.slice(0, pageJs.lastIndexOf('(async () => {'))}
    return { render, trigger, nudge, undoLast, setChapter, toggleBeaten, logFight,
             deleteFight, rollFind, saveSeventh, fightRecord, pcNames, beatenCount,
             heatLevel, set admin(v) { heatCanEdit = v; },
             get doc() { return heatDoc; }, set doc(d) { heatDoc = d; } };
  `)({
    document: { getElementById: (i) => els[i] || null },
    localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } },
    console: { error() {}, log() {} },
    admin: true,
  });
  env.admin = true;
  env.render();

  env.trigger('ranked');
  env.trigger('ring');
  check('a trigger moves Heat by its own delta', env.heatLevel() === 3, String(env.heatLevel()));
  check('and logs what caused it',
    env.doc.log.length === 2 && env.doc.log[0].reason === 'A fight in the Ring'
    && env.doc.log[0].from === 1 && env.doc.log[0].to === 3,
    JSON.stringify(env.doc.log[0]));
  env.undoLast();
  check('undo puts it back to where that entry started',
    env.heatLevel() === 1 && env.doc.log.length === 1);

  env.doc.heat = 9;
  env.setChapter(2);
  check('dropping into a capped chapter lowers Heat and says so in the log',
    env.heatLevel() === 3 && /caps Heat at 3/.test(env.doc.log[0].reason),
    env.heatLevel() + ' / ' + env.doc.log[0].reason);
  env.setChapter(6);

  // The two-way link between a fight and the record.
  els['heat-fight-pc'].value = 'Ren Suzuki';
  els['heat-fight-opp'].value = 'okawachi';
  env.logFight('win');
  check('beating a named member logs the fight and marks them beaten',
    env.doc.fights.length === 1 && env.doc.fights[0].ranked === true
    && !!env.doc.beaten.okawachi, JSON.stringify(env.doc.fights[0]));
  els['heat-fight-opp'].value = '';
  env.logFight('loss');
  check('and an unranked opponent is logged without marking anybody',
    env.doc.fights[0].ranked === false && env.beatenCount() === 1);
  els['heat-fight-pc'].value = '';
  const before = env.doc.fights.length;
  env.logFight('win');
  check('a fight with nobody in it is refused',
    env.doc.fights.length === before && /Who fought/.test(els['heat-fight-feedback'].textContent));

  const r = env.fightRecord('Ren Suzuki');
  check('the record is wins, losses and a ratio that excludes draws',
    r.wins === 1 && r.losses === 1 && r.ratio === 0.5, JSON.stringify(r));
  els['heat-fight-pc'].value = 'Ren Suzuki';
  env.logFight('draw');
  const r2 = env.fightRecord('Ren Suzuki');
  check('a draw is counted and kept out of the ratio',
    r2.draws === 1 && r2.decided === 2 && r2.ratio === 0.5, JSON.stringify(r2));

  /* ── 4. the tease ── */
  for (let n = 0; n <= 10; n++) {
    env.doc.heat = n;
    env.render();
    const coming = els['heat-coming'].innerHTML;
    const band = D.heatBandFor(n);
    const next = D.heatNextBand(n);
    check(`at Heat ${n} the page names what is coming`,
      next ? coming.includes(next.who.slice(0, 20)) : /doormat/.test(coming),
      coming.replace(/\s+/g, ' ').slice(0, 90));
    check(`and says who is here at Heat ${n}`,
      els['heat-who'].innerHTML.includes(band.who.slice(0, 20)));
  }
  env.doc.heat = 7;
  env.render();
  check('from Heat 6 it warns about the Corners by name',
    /Corners come down at 8/.test(els['heat-coming'].innerHTML));
  env.doc.heat = 9;
  env.render();
  check('and at 9 it says what lands on the doormat',
    /doormat/.test(els['heat-coming'].innerHTML));

  /* the d6 */
  env.doc.heat = 0;
  env.render();
  let found = 0;
  for (let i = 0; i < 2000; i++) {
    env.rollFind('turf');
    if (/Byakko find you/.test(els['heat-d6'].innerHTML)) found++;
  }
  check('in the turf, roughly half the rolls find you — 1 to 3 on a d6',
    Math.abs(found / 2000 - 0.5) < 0.05, (found / 20).toFixed(1) + '%');
  env.rollFind('out');
  check('outside the turf below Heat 4 there is no roll to make',
    /No roll outside/.test(els['heat-d6'].innerHTML));
  env.doc.heat = 5;
  env.render();
  let f2 = 0;
  for (let i = 0; i < 3000; i++) {
    env.rollFind('out');
    if (/Byakko find you/.test(els['heat-d6'].innerHTML)) f2++;
  }
  check('and from Heat 4 outside it, only a 1 does',
    Math.abs(f2 / 3000 - 1 / 6) < 0.04, (f2 / 30).toFixed(1) + '%');

  /* ── 5. a reader cannot move it ── */
  env.admin = false;
  env.render();
  const level = env.heatLevel();
  const fights = env.doc.fights.length;
  const beaten = env.beatenCount();
  env.trigger('ring'); env.nudge(5); env.undoLast(); env.setChapter(2);
  env.toggleBeaten('hakuro'); env.logFight('win'); env.saveSeventh();
  check('a reader cannot move Heat, log a fight or mark anybody beaten',
    env.heatLevel() === level && env.doc.fights.length === fights && env.beatenCount() === beaten,
    `heat ${level}→${env.heatLevel()}, fights ${fights}→${env.doc.fights.length}`);
  check('the controls are not even rendered for them',
    !/ht-trigger/.test(els['heat-controls'].innerHTML)
    && /DM/.test(els['heat-controls'].innerHTML));
  env.rollFind('turf');
  check('but a die is a die, and anybody may roll it',
    /\d/.test(els['heat-d6'].innerHTML));

  /* ── 6. escaping ── */
  env.admin = true;
  env.doc.seventhRule = '<script>bad</script>';
  env.doc.fights = [{ id: 'x', at: Date.now(), pc: '<img src=x onerror=alert(1)>',
    opponent: '<b>y</b>', rank: '', result: 'win', where: '<i>z</i>' }];
  env.doc.log = [{ id: 'y', at: Date.now(), delta: 1, from: 0, to: 1, reason: '<u>why</u>' }];
  env.render();
  const page = Object.values(els).map(e => e.innerHTML).join('');
  // An attribute only exists inside a tag, and a regex cannot tell an
  // attribute from the same characters sitting in text — "onerror=alert(1)"
  // comes back as inert TEXT. So the test is the one that decides it: did a
  // tag survive?
  const tags = page.match(/<(script|img|b|i|u)[ >/]/g) || [];
  check('nothing a field contains can become a tag',
    tags.length === 0, [...new Set(tags)].join(' '));
  check('and its angle brackets come out as entities',
    page.includes('&lt;img src=x') && page.includes('&lt;u&gt;why'));
}

/* ── the page, and the rule that protects it ── */
{
  check('the page loads the data and the dice engine before its own script',
    pageHtml.indexOf('src="byakko-data.js"') < pageHtml.indexOf('src="heat.js"')
    && pageHtml.indexOf('src="dice.js"') < pageHtml.indexOf('src="heat.js"')
    && pageHtml.includes('src="byakko-data.js"'));

  // The page hides the buttons; the database is what actually refuses.
  const rules = read('firestore.rules');
  check('firestore.rules makes the Heat document admin-only to write',
    /doc != 'heat'/.test(rules),
    'a player who can set Heat to 10 can summon the White Tiger');
  check('and still world-readable, which is the point of the page',
    /match \/mha-dnd\/\{doc\}[\s\S]{0,400}allow read: if true;/.test(rules));
  check('the page fails closed until the admin check resolves',
    /let heatCanEdit = false;/.test(pageJs));
  check('and says out loud when a save fails, rather than swallowing it',
    /save failed/.test(pageJs) && /console\.error/.test(pageJs));

  // In the markup OR in the markup the page renders: the fight form and the
  // seventh-rule box are only built when the viewer can edit, so their ids
  // live in heat.js rather than heat.html. The first version of this check
  // looked only at the HTML and called all four of them missing.
  const reachedFor = [...new Set([...pageJs.matchAll(/getElementById\('([^'${]+)'\)/g)].map(m => m[1]))];
  const nowhere = reachedFor.filter(id =>
    !pageHtml.includes(`id="${id}"`) && !pageJs.includes(`id="${id}"`));
  check('every element the page script reaches for exists somewhere it renders',
    nowhere.length === 0, nowhere.join(', '));
  check('and the ones it renders itself are the edit-only controls',
    reachedFor.filter(id => !pageHtml.includes(`id="${id}"`)).every(id => /fight|seventh/.test(id)),
    reachedFor.filter(id => !pageHtml.includes(`id="${id}"`)).join(', '));

  for (const sel of ['.ht-track', '.ht-cell.is-now', '.ht-coming', '.ht-member.is-beaten',
    '.ht-trigger', '.ht-law-sixth', '.mood-hot']) {
    check(`${sel} is styled`, pageCss.includes(sel));
  }

  const index = read('index.html');
  const dmStart = index.indexOf('<div id="dm-only">');
  const link = index.indexOf('href="heat.html"');
  check('the dashboard links to it, outside the DM block — it is a player page',
    link !== -1 && dmStart !== -1 && link < dmStart,
    `link at ${link}, DM block at ${dmStart}`);
}

console.log(failures ? `\n>>> heat FAILED (${failures})`
  : `\n>>> heat OK (${D.byakkoAllMembers().length} named Byakko, ${D.HEAT_BANDS.length} bands)`);
process.exit(failures ? 1 : 0);
