// Every quirk the campaign knows about, assembled. Loaded as a CLASSIC
// script (not a module) by lab.html, so these are plain globals.
//
// ── Where a quirk can be hiding ─────────────────────────────────────
// There is no single file listing the campaign's quirks, because quirks
// belong to characters and the characters are in seven places:
//
//   REPO   CAMPAIGN/compendium.json       the Quirk Compendium, indexed —
//                                         every quirk in the book, built
//                                         from the PDF by
//                                         scripts/build-compendium.js
//   LIVE   mha-dnd/relationships-bundle   Class 1-A, hand-edited in the
//                                         browser, authoritative for them
//   LIVE   characters/{id}                the rest of the cast — the gang,
//                                         the Underground, the staff. This
//                                         is where the real roster lives;
//                                         the repo's teachers.json and
//                                         villains.json are older than it
//   REPO   CLASS-1A/*.json                the bundled copy of Class 1-A
//   REPO   CAMPAIGN/class1b.json          the rival class, with their
//                                         signature moves
//   REPO   CAMPAIGN/teachers.json         staff
//   REPO   CAMPAIGN/villains.json         the organisation and the solos
//   REPO   CAMPAIGN/npcs.json             the supporting cast
//
// quirkLoadAll reads all of them, live first, and merges on the QUIRK — so
// "Homing", held by two different people, is one entry, and a quirk somebody
// in the campaign has that is also in the book is one entry carrying both:
// the book's rarity and page, and whatever the character's own record adds. It reports which
// sources answered, and the page says so, because a database that quietly
// lost two of its seven sources looks exactly like a database that is
// complete.
//
// ── Nobody is named in it ───────────────────────────────────────────
// This is a reference for players, and the cast it is assembled from
// includes the gang, the Underground and the villains. "Alucard Chosoji —
// BLACK" on a page a player can open is a spoiler, so no character name
// reaches the records at all.
//
// Taking the names off the headers is the easy half. The hard half is that
// the prose is written ABOUT people — "Once Kakita has studied a target",
// "Domoto's legs carry more force than her frame suggests" — so every
// summary, weakness and ability description is run through quirkScrub, which
// swaps a known name for "the user". Dropping those fields instead would
// have been simpler and would have thrown away most of what the database is
// for. scripts/verify-lab.js then checks every rendered field against every
// name the campaign knows, so a name that gets past the scrub fails the
// suite rather than reaching a player.
//
// Read-only. Nothing in this file writes anything.

// Mutant and Mutation are the same thing spelled two ways in the data, and
// a filter that offers both is a filter that hides half the heteromorphs.
const QUIRK_TYPE_ALIASES = { Mutation: 'Mutant', Heteromorph: 'Mutant' };

function quirkNormaliseType(t) {
  const raw = String(t == null ? '' : t).trim();
  if (!raw || raw === 'N/A') return 'Unrecorded';
  return QUIRK_TYPE_ALIASES[raw] || raw;
}

/* Swaps every known character name for "the user".
 *
 * Word-bounded and at least four characters, so "Koto" never eats the "Koto"
 * inside "Kotoha" and a three-letter fragment of somebody's name cannot
 * rewrite an ordinary word. Capitalised when it lands at the start of a
 * sentence, because "Domoto's legs carry…" has to come out as "The user's
 * legs carry…" rather than "the user's".
 *
 * It is not clever, and it does not need to be: the verifier checks the
 * output against every name the campaign knows, so anything this misses is
 * a failed build rather than a name on a player's screen.
 */
function quirkScrub(text, names) {
  let out = String(text == null ? '' : text);
  if (!out || !names || !names.length) return out;
  for (const name of names) {
    if (name.length < 4) continue;
    const pattern = new RegExp('(^|[^A-Za-z\u00c0-\u024f])(' +
      name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(?![A-Za-z\u00c0-\u024f])', 'g');
    out = out.replace(pattern, (m, before) => {
      // Start of the string, or just after a full stop: capitalise.
      const sentenceStart = before === '' || /[.!?]\s$/.test(out.slice(0, out.indexOf(m)) + before);
      return before + (sentenceStart ? 'The user' : 'the user');
    });
  }
  // "the user's own the user" and similar doubling, which a name written
  // twice in one clause can produce.
  return out.replace(/\b([Tt]he user) the user\b/g, '$1').replace(/\s{2,}/g, ' ').trim();
}

// One record per quirk-bearing character — with no character in it. The name
// and the alias are not carried at all rather than carried and hidden: a
// field that does not exist cannot be printed by mistake.
function quirkRecord(c, source, names) {
  const mech = c.quirk_mechanics || {};
  const scrub = (t) => quirkScrub(t, names);
  const abilities = []
    .concat(Array.isArray(mech.abilities) ? mech.abilities : [])
    .concat(Array.isArray(c.signature_moves) ? c.signature_moves : [])
    .map(a => ({
      name: scrub(a.name || a.move || ''),
      type: a.type || a.action || '',
      text: scrub(a.description || a.effect || a.text || ''),
      damage: a.damage || '',
      attackBonus: a.attackBonus || '',
    }))
    .filter(a => a.name || a.text);

  return {
    quirk: c.quirk || '',
    type: quirkNormaliseType(c.quirk_type || c.type),
    rarity: c.quirk_rarity || '',
    summary: scrub(c.quirk_summary || mech.summary || ''),
    weakness: scrub(typeof mech === 'string' ? mech : mech.weakness || ''),
    source: mech.source || '',
    from: source,
    abilities,
  };
}

// A record needs a quirk to be about. Without one it is a half-finished row
// in somebody's editor, and a database full of blanks is worse than a
// smaller one that is all real.
function quirkUsable(r) {
  return !!(r && r.quirk);
}

async function quirkLoadAll(db, opts) {
  const options = opts || {};
  const base = options.base || '';
  const sources = [];     // what answered, for the page to report
  const failed = [];

  /* Two passes, and the first one exists only so the second can scrub.
   *
   * A name cannot be removed from "Once Kakita has studied a target" until
   * the loader knows "Kakita" is a name, and it only knows that after it has
   * read every source — including the one the sentence did not come from,
   * because the prose in one file names people in another. So: collect, then
   * build. Nothing between the two passes is rendered.
   */
  const raw = [];         // { character, from }
  const compendium = [];  // the book's entries, which have no character behind them
  const names = new Set();
  const collect = (c, from) => {
    if (!c) return;
    raw.push({ c, from });
    for (const field of [c.name, c.alias, c.hero_name]) {
      if (!field) continue;
      names.add(String(field).trim());
      // Given name and surname separately: the prose uses one or the other
      // ("Domoto's legs", "Once Kakita has studied") far more often than both.
      for (const part of String(field).trim().split(/\s+/)) {
        if (part.length >= 4) names.add(part);
      }
    }
  };
  const push = collect;    // the repo jobs below read better with this name

  const getJson = (path) => fetch(base + path).then(r => {
    if (!r.ok) throw new Error('bad status');
    return r.json();
  });

  /* ── Live, first ── */
  let liveBundleFiles = new Set();
  try {
    if (options.authReady) await options.authReady;
    const snap = await db.collection('mha-dnd').doc('relationships-bundle').get();
    const data = snap.exists ? snap.data() : null;
    if (data && data.characters) {
      for (const [file, c] of Object.entries(data.characters)) {
        liveBundleFiles.add(file);
        push(c, 'Class 1-A (live)');
      }
      sources.push('the live Class 1-A bundle');
    }
  } catch { failed.push('the live Class 1-A bundle'); }

  try {
    const snap = await db.collection('characters').get();
    let n = 0;
    snap.forEach(d => {
      const raw = d.data() || {};
      // Two shapes live in this collection: a custom character written flat,
      // and an override of a bundled one nested under `fields`.
      const c = raw.fields && typeof raw.fields === 'object' ? raw.fields : raw;
      if (raw.deleted || c.deleted) return;
      push(c, c._type === 'Custom' || raw._type === 'Custom' ? 'Created in the browser' : 'The live cast');
      n++;
    });
    if (n) sources.push('the live cast');
  } catch { failed.push('the live cast'); }

  /* ── The repo, as the floor under all of it ── */
  const repoJobs = [
    ['CAMPAIGN/class1b.json', 'Class 1-B', d => d.students || []],
    ['CAMPAIGN/teachers.json', 'U.A. staff', d => d.teachers || []],
    ['CAMPAIGN/npcs.json', 'Supporting cast', d => d.characters || []],
    ['CAMPAIGN/villains.json', 'Villains', d => [
      ...(d.solo || []),
      ...((d.organisation && d.organisation.members) || []),
      ...((d.factions || []).flatMap(f => f.members || [])),
    ]],
  ];
  for (const [path, label, pick] of repoJobs) {
    try {
      const data = await getJson(path);
      const list = pick(data) || [];
      for (const c of list) push(c, label);
      if (list.length) sources.push(label);
    } catch { failed.push(label); }
  }

  /* The Quirk Compendium, read LAST so that everything the campaign knows
   * about a quirk wins over the book's account of it — a character's own
   * record is the one being played. The book then fills in what nobody in
   * the campaign has: its rarity, its page, and the 130-odd quirks that
   * belong to nobody at all.
   *
   * Its entries are not characters, so they are shaped here rather than
   * going through quirkRecord — there is nobody to collect a name from, and
   * that is the one source where that is a feature.
   */
  try {
    const book = await getJson('CAMPAIGN/compendium.json');
    for (const e of (book.entries || [])) {
      if (!e.name) continue;
      compendium.push({
        quirk: e.name,
        type: quirkNormaliseType(e.type),
        rarity: e.rarity || '',
        summary: e.description || '',
        weakness: e.weakness || '',
        source: book.source || 'Quirk Compendium',
        page: e.page || null,
        from: 'The Quirk Compendium',
        abilities: (e.abilities || []).map(a => ({
          name: a.name,
          type: a.level ? 'Level ' + a.level : '',
          text: '',
          damage: '',
          attackBonus: '',
        })),
      });
    }
    if (compendium.length) sources.push('the Quirk Compendium');
  } catch { failed.push('the Quirk Compendium'); }

  // The bundled Class 1-A files, only for anybody the live bundle did not
  // already answer for — so a signed-out reader still gets the class.
  try {
    const roster = await getJson('CLASS-1A/roster.json');
    const students = ((roster && roster.students) || []).filter(s => s.file);
    const missing = students.filter(s => !liveBundleFiles.has(s.file));
    if (missing.length) {
      const loaded = await Promise.all(missing.map(s =>
        getJson('CLASS-1A/' + s.file).catch(() => null)));
      for (const c of loaded) if (c) push(c, 'Class 1-A');
      sources.push('the bundled Class 1-A files');
    }
  } catch { failed.push('the bundled Class 1-A files'); }

  // Longest first, so "Dōmeki Daigo" is replaced as a whole before the pass
  // that would otherwise leave "the user Daigo".
  const nameList = [...names].sort((a, b) => b.length - a.length);
  const out = [];
  for (const { c, from } of raw) {
    const r = quirkRecord(c, from, nameList);
    if (quirkUsable(r)) out.push(r);
  }

  return { quirks: quirkDedupe(out.concat(compendium)), sources, failed, names: nameList };
}

/* Merged on the QUIRK, which is what this database is about now that nobody
 * is named in it: "Homing" is held by two different people and is one entry.
 *
 * The first record wins on every field it has filled in and later ones fill
 * in the gaps, so the live copy (loaded first) is authoritative and a repo
 * file can still contribute a weakness or an ability list the live copy
 * never had. Abilities accumulate rather than being replaced — two people
 * with the same quirk have found different things to do with it, and both
 * are worth reading.
 */
function quirkDedupe(records) {
  const byQuirk = new Map();
  for (const r of records) {
    const key = r.quirk.trim().toLowerCase();
    const seen = byQuirk.get(key);
    if (!seen) {
      byQuirk.set(key, { ...r, alsoFrom: [], held: r.from === 'The Quirk Compendium' ? 0 : 1 });
      continue;
    }
    if (r.from !== 'The Quirk Compendium') seen.held++;
    for (const field of ['rarity', 'summary', 'weakness', 'source', 'page']) {
      if (!seen[field] && r[field]) seen[field] = r[field];
    }
    if (seen.type === 'Unrecorded' && r.type !== 'Unrecorded') seen.type = r.type;
    for (const a of r.abilities) {
      if (!seen.abilities.some(x => x.name === a.name)) seen.abilities.push(a);
    }
    if (r.from !== seen.from && !seen.alsoFrom.includes(r.from)) seen.alsoFrom.push(r.from);
  }
  return [...byQuirk.values()].sort((a, b) => a.quirk.localeCompare(b.quirk));
}

// Every word has to appear somewhere in the record, so "emitter fire skin"
// finds it without knowing which field holds which part. There is no name in
// the haystack because there is no name in the record — searching a
// character's name finds nothing, which is the point.
function quirkMatches(r, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const hay = [r.quirk, r.type, r.rarity, r.summary, r.weakness,
    ...r.abilities.map(a => a.name + ' ' + a.text)].join(' ').toLowerCase();
  return q.split(/\s+/).filter(Boolean).every(w => hay.includes(w));
}

function quirkFacets(records) {
  const count = (pick) => {
    const m = new Map();
    for (const r of records) {
      const v = pick(r);
      if (v) m.set(v, (m.get(v) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  return {
    types: count(r => r.type),
    rarities: count(r => r.rarity),
    froms: count(r => r.from),
  };
}
