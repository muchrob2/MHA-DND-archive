// Every quirk the campaign knows about, assembled. Loaded as a CLASSIC
// script (not a module) by lab.html, so these are plain globals.
//
// ── Where a quirk can be hiding ─────────────────────────────────────
// There is no single file listing the campaign's quirks, because quirks
// belong to characters and the characters are in seven places:
//
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
// quirkLoadAll reads all of them, live first, and merges on the character's
// name — so a character who exists both live and in the repo is counted
// once, with the live copy winning. It reports which sources answered, and
// the page says so, because a database that quietly lost two of its seven
// sources looks exactly like a database that is complete.
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

// One record per character who has a quirk. `abilities` is whatever the
// source recorded — the shape differs between files, so it is normalised
// here rather than in the page.
function quirkRecord(c, source) {
  const mech = c.quirk_mechanics || {};
  const abilities = []
    .concat(Array.isArray(mech.abilities) ? mech.abilities : [])
    .concat(Array.isArray(c.signature_moves) ? c.signature_moves : [])
    .map(a => ({
      name: a.name || a.move || '',
      type: a.type || a.action || '',
      text: a.description || a.effect || a.text || '',
      damage: a.damage || '',
      attackBonus: a.attackBonus || '',
    }))
    .filter(a => a.name || a.text);

  return {
    name: c.name || '',
    alias: c.alias || c.hero_name || '',
    quirk: c.quirk || '',
    type: quirkNormaliseType(c.quirk_type || c.type),
    rarity: c.quirk_rarity || '',
    summary: c.quirk_summary || mech.summary || '',
    weakness: mech.weakness || '',
    source: mech.source || '',
    from: source,
    role: c.role || c.category || '',
    abilities,
  };
}

// Named characters only. A record with no name is a half-finished row in
// somebody's editor, and a database full of blanks is worse than a smaller
// one that is all real.
function quirkUsable(r) {
  return !!(r.name && r.quirk);
}

async function quirkLoadAll(db, opts) {
  const options = opts || {};
  const base = options.base || '';
  const sources = [];     // what answered, for the page to report
  const failed = [];
  const out = [];

  const push = (c, from) => {
    const r = quirkRecord(c, from);
    if (quirkUsable(r)) out.push(r);
  };

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

  return { quirks: quirkDedupe(out), sources, failed };
}

/* Merged on the character's name, because the same person appears in up to
 * three sources and the only key they share is what they are called. The
 * first record wins on every field it has filled in, and later ones fill in
 * the gaps — so the live copy (loaded first) is authoritative, and a repo
 * file can still contribute a weakness or an ability list the live copy
 * never had.
 */
function quirkDedupe(records) {
  const byName = new Map();
  for (const r of records) {
    const key = r.name.trim().toLowerCase();
    const seen = byName.get(key);
    if (!seen) { byName.set(key, { ...r, alsoFrom: [] }); continue; }
    for (const field of ['alias', 'quirk', 'rarity', 'summary', 'weakness', 'source', 'role']) {
      if (!seen[field] && r[field]) seen[field] = r[field];
    }
    if (seen.type === 'Unrecorded' && r.type !== 'Unrecorded') seen.type = r.type;
    if (!seen.abilities.length && r.abilities.length) seen.abilities = r.abilities;
    if (r.from !== seen.from && !seen.alsoFrom.includes(r.from)) seen.alsoFrom.push(r.from);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Every word has to appear somewhere in the record, so "emitter fire skin"
// finds it without knowing which field holds which part.
function quirkMatches(r, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const hay = [r.name, r.alias, r.quirk, r.type, r.rarity, r.summary, r.weakness, r.role,
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
