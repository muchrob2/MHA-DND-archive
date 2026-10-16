#!/usr/bin/env node
/* Turn the Byakko and Underground encounter presets into characters on the
 * Characters tab.
 *
 * Why this exists: PR #126 added 30 presets to CAMPAIGN/enemies.json, but
 * characters.js never fetches that file — it reads roster.json, class1b.json,
 * teachers.json, villains.json and npcs.json. So the whole Byakko gang and the
 * three Underground societies exist as stat blocks the encounter builder can
 * use and as prose in the campaign, and as nothing at all on the Characters
 * tab. This copies them across into villains.json, whose `factions` array is
 * already the shape this cast has.
 *
 * The two files describe the same people for different purposes, so the
 * mapping is not field-for-field:
 *   - showDetail() in characters.js renders quirk_mechanics, not stat_block,
 *     so each preset's attacks and traits become quirk_mechanics.abilities
 *     (the shape npcs.json already uses). stat_block is still written, for
 *     the data's own sake.
 *   - a trait beginning "WEAKNESS" becomes quirk_mechanics.weakness and
 *     dm_notes.weakness_to_exploit rather than another ability row.
 *   - `tactics` becomes dm_notes.combat_role.
 *   - the preset `description` is a character sketch, so it becomes
 *     `personality`.
 * Nothing is invented: every string written here comes from enemies.json or,
 * for the four faction blurbs, from the campaign text itself.
 *
 * Names are split into name/alias/role by hand in CAST below rather than by a
 * parser — the 30 source names have at least six different shapes ("Kuze
 * Asagi, the Azure Corner", "Kegare, Grade One — \"the Roll Call\"",
 * "Hōshō Kaito & PAPER PLANES (Envoy-bearer)"), and a parser that got one
 * wrong would put a mangled name on the live site.
 *
 * Usage:
 *   node scripts/import-underground-cast.js            # dry run
 *   node scripts/import-underground-cast.js --write    # rewrite villains.json
 */

const fs = require('fs');
const path = require('path');

const doWrite = process.argv.includes('--write');
const CAMPAIGN = path.join(__dirname, '..', 'CAMPAIGN');

// Faction blurbs are quoted from the-shortlist-after-hours in campaigns.json.
const FACTIONS = [
  {
    id: 'byakko',
    name: 'Byakko',
    description: 'A street gang that runs the backstreets of west Tokyo and ranks its members by who beat whom. The more the class tangle with them, the stronger the people who come next.',
    structure: 'Ranked by who beat whom: Stray (unranked), Claw (one stripe), Fang (two stripes), Stripe (three stripes). Above them the Four Corners hold the compass points, and above all of them the White Tiger.',
    public_awareness: 'Known locally as a street gang. The Heat track measures how much attention the class have drawn to themselves.',
    tier_introduced: 1,
    colour: '#E8E8E8',
    members: ['byakko_stray', 'byakko_claw', 'byakko_fang', 'byakko_stripe', 'byakko_hazama', 'byakko_okita', 'byakko_domeki', 'byakko_saeki', 'byakko_ibuki', 'byakko_tsuru', 'byakko_kuze', 'byakko_hojo', 'byakko_genda', 'byakko_koga', 'byakko_hakuro'],
  },
  {
    id: 'scarlet-legion',
    name: 'Scarlet Legion',
    description: 'Vampires, in the Hellsing tradition: old, aristocratic, military, and appalling. They came to Japan with the foreign legations in 1868, and they run a members’ club in Ginza, a private clinic in Minato and the night shipping at Kurogane Wharf. They feed on people nobody misses, which lately has meant Byakko.',
    structure: 'Thralls and legionaries under Centurions, with the Legate above them all.',
    public_awareness: 'None. On paper they are old-money foreigners with no quirks.',
    tier_introduced: 3,
    colour: '#B3202C',
    members: ['legion_thrall', 'legion_legionary', 'legion_mina', 'legion_grau', 'legion_akabane'],
  },
  {
    id: 'astral-court',
    name: 'Astral Court',
    description: 'A court of sun-priests older than the shogunate, who practise Sunbreath: a breathing art that carries sunlight through the blood. Its masters wake a second self called an Envoy, a figure that stands beside them and does one impossible thing. They are the Legion’s oldest enemy.',
    structure: 'Initiates beneath Envoy-bearers, with Elders above them.',
    public_awareness: 'None. They are registered Quirkless and proud of it, and one of them teaches English at U.A.',
    tier_introduced: 3,
    colour: '#E8A020',
    members: ['court_initiate', 'court_kaito', 'court_hinata', 'court_saotome'],
  },
  {
    id: 'kuroshiki',
    name: 'Kuroshiki',
    description: 'The black rite. Old families who pass down inherited techniques fuelled by Sumi, the ink of dread turned against itself, and use them to exorcise Kegare — things born out of human fear, invisible to everybody else. A city that has spent a year afraid of Case 9 is full of Kegare, and the Kuroshiki are badly overstretched.',
    structure: 'Sorcerers ranked by grade, trained at the Kurama Rite School above Hachiōji. Filed here alongside the Kegare they exist to exorcise.',
    public_awareness: 'None. They hide their work behind Veils that cameras cannot see through, and on the registry sorcerers are Quirkless or claim small, dull quirks.',
    tier_introduced: 3,
    colour: '#2E2A33',
    members: ['kuro_tsubaki', 'kuro_ichiro', 'kuro_shirasagi', 'kegare_grade4', 'kegare_grade2', 'kegare_rollcall'],
  },
];

// preset id -> how the name splits, and what the character is.
const CAST = {
  byakko_stray:    { name: 'Byakko Stray',          role: 'Byakko — unranked' },
  byakko_claw:     { name: 'Byakko Claw',           role: 'Byakko — one stripe' },
  byakko_fang:     { name: 'Byakko Fang',           role: 'Byakko — two stripes' },
  byakko_stripe:   { name: 'Byakko Stripe',         role: 'Byakko — three stripes' },
  byakko_hazama:   { name: 'Hazama Ritsu',          alias: 'Ricochet',             role: 'Byakko — Claw (one stripe)' },
  byakko_okita:    { name: 'Kei & Rei Okita',       alias: 'the Echo Twins',       role: 'Byakko — Claws (one stripe)' },
  byakko_domeki:   { name: 'Dōmeki Daigo',     alias: 'Brick',                role: 'Byakko — Fang (two stripes)' },
  byakko_saeki:    { name: 'Saeki Momo',            alias: 'Hairpin',              role: 'Byakko — Fang (two stripes)' },
  byakko_ibuki:    { name: 'Ibuki Kōsuke',     alias: 'Three-Stripe Kō', role: 'Byakko — Stripe (three stripes)' },
  byakko_tsuru:    { name: 'Tsuruoka Fusae',        alias: 'Madame Tsuru',         role: 'Byakko — Stripe (three stripes)' },
  byakko_kuze:     { name: 'Kuze Asagi',            alias: 'the Azure Corner',     role: 'Byakko — one of the Four Corners' },
  byakko_hojo:     { name: 'Hōjō Akane',  alias: 'the Vermilion Corner', role: 'Byakko — one of the Four Corners' },
  byakko_genda:    { name: 'Genda Tetsuo',          alias: 'the Black Corner',     role: 'Byakko — one of the Four Corners' },
  byakko_koga:     { name: 'Kōga Rin',         alias: 'the Yellow Corner',    role: 'Byakko — one of the Four Corners' },
  byakko_hakuro:   { name: 'Hakuro Mitsuki',        alias: 'the White Tiger',      role: 'Byakko — the gang’s apex' },

  legion_thrall:    { name: 'Legion Thrall',                role: 'Scarlet Legion — thrall' },
  legion_legionary: { name: 'Legionary',                    role: 'Scarlet Legion — rank and file' },
  legion_mina:      { name: 'Mina Toda',                    role: 'Scarlet Legion — Centurion' },
  legion_grau:      { name: 'Captain Grau',                 role: 'Scarlet Legion — Centurion' },
  legion_akabane:   { name: 'Lady Akabane Seraphine',       role: 'Scarlet Legion — Legate' },

  court_initiate:  { name: 'Daybreak Initiate',             role: 'Astral Court — initiate' },
  court_kaito:     { name: 'Hōshō Kaito & PAPER PLANES', role: 'Astral Court — Envoy-bearer' },
  court_hinata:    { name: 'Grandmother Hinata Sae',        role: 'Astral Court — Elder' },
  court_saotome:   { name: 'Saotome Shin & BAD MOON',       alias: 'the Arrowhead Thief', role: 'Astral Court' },

  kuro_tsubaki:    { name: 'Mibu Tsubaki',    role: 'Kuroshiki sorcerer — Grade Two' },
  kuro_ichiro:     { name: 'Kagura Ichirō', role: 'Kuroshiki sorcerer — Grade Two' },
  kuro_shirasagi:  { name: 'Shirasagi Rei',   role: 'Kuroshiki sorcerer — unranked' },
  kegare_grade4:   { name: 'Kegare, Grade Four', role: 'Kegare — a thing born out of human fear' },
  kegare_grade2:   { name: 'Kegare, Grade Two',  role: 'Kegare — a thing born out of human fear' },
  kegare_rollcall: { name: 'Kegare, Grade One',  alias: 'the Roll Call', role: 'Kegare — a thing born out of human fear' },
};

const TAG = 'After Hours';

// "POUNCE — if she moves 20 ft straight…" -> { name, description }
function splitTrait(t) {
  const i = t.indexOf(' — ');
  if (i === -1) return { name: t.replace(/\.$/, ''), description: '' };
  return { name: t.slice(0, i).trim(), description: t.slice(i + 3).trim() };
}

function toCharacter(preset, spec) {
  const traits = preset.traits || [];
  // Both "WEAKNESS —" and "WEAKNESSES —" appear in the presets.
  const weaknessTrait = traits.find(t => /^WEAKNESS(ES)?\b/i.test(t));
  const weakness = weaknessTrait ? splitTrait(weaknessTrait).description : '';

  const abilities = [
    ...(preset.attacks || []).map(a => ({
      name: a.name,
      type: 'Action',
      ...(a.to_hit ? { attackBonus: a.to_hit } : {}),
      ...(a.damage ? { damage: a.damage } : {}),
      ...(a.range ? { range: a.range } : {}),
      description: a.notes || '',
    })),
    ...traits.filter(t => t !== weaknessTrait).map(t => {
      const { name, description } = splitTrait(t);
      return { name, type: 'Trait', description };
    }),
  ];

  const out = {
    name: spec.name,
    ...(spec.alias ? { alias: spec.alias } : {}),
    role: spec.role,
    quirk_mechanics: {
      source: `Encounter preset — ${preset.id}`,
      ...(weakness ? { weakness } : {}),
      abilities,
    },
    stat_block: {
      CR: preset.cr,
      tier: preset.tier,
      HP: preset.hp,
      AC: preset.ac,
      speed: preset.speed,
      ...(preset.ability_scores || {}),
      quirk_save_DC: preset.quirk_save_dc,
    },
    campaign_appearances: ['The Shortlist: After Hours'],
    tags: [TAG],
  };
  if (preset.description) out.personality = preset.description;

  const dm = {};
  if (preset.tactics) dm.combat_role = preset.tactics;
  if (weakness) dm.weakness_to_exploit = weakness;
  if (Object.keys(dm).length) out.dm_notes = dm;

  return out;
}

(async () => {
  const enemiesPath = path.join(CAMPAIGN, 'enemies.json');
  const villainsPath = path.join(CAMPAIGN, 'villains.json');
  const enemies = JSON.parse(fs.readFileSync(enemiesPath, 'utf8')).enemies || [];
  const villains = JSON.parse(fs.readFileSync(villainsPath, 'utf8'));

  const byId = new Map(enemies.map(e => [e.id, e]));

  // Every id named above must still exist, and every Byakko/Underground preset
  // must be accounted for — a preset added later would otherwise be missed in
  // silence.
  const claimed = new Set(FACTIONS.flatMap(f => f.members));
  for (const id of claimed) {
    if (!byId.has(id)) throw new Error(`no preset with id "${id}" in enemies.json`);
    if (!CAST[id]) throw new Error(`id "${id}" is in a faction but missing from CAST`);
  }
  const inScope = enemies.filter(e => e.category === 'Byakko' || e.category === 'Underground');
  for (const e of inScope) {
    if (!claimed.has(e.id)) throw new Error(`preset "${e.id}" (${e.category}) is not assigned to any faction`);
  }
  if (claimed.size !== inScope.length) throw new Error(`faction membership covers ${claimed.size} presets but ${inScope.length} are in scope`);

  // characters.js dedupes villains by name, so a collision would silently drop
  // whichever entry came second.
  const existingNames = new Set();
  for (const f of villains.factions || []) for (const v of f.villains || []) existingNames.add(v.name);
  const seen = new Set();
  for (const id of claimed) {
    const n = CAST[id].name;
    if (existingNames.has(n)) throw new Error(`refusing to write: "${n}" already exists in villains.json`);
    if (seen.has(n)) throw new Error(`refusing to write: "${n}" is used twice in CAST`);
    seen.add(n);
  }
  for (const f of FACTIONS) {
    if ((villains.factions || []).some(x => x.name === f.name)) throw new Error(`refusing to write: faction "${f.name}" already exists`);
  }

  const newFactions = FACTIONS.map(f => ({
    id: f.id,
    name: f.name,
    description: f.description,
    structure: f.structure,
    public_awareness: f.public_awareness,
    tier_introduced: f.tier_introduced,
    colour: f.colour,
    villains: f.members.map(id => toCharacter(byId.get(id), CAST[id])),
  }));

  console.log(`presets in scope : ${inScope.length} (Byakko + Underground)`);
  console.log(`factions before  : ${(villains.factions || []).map(f => f.name).join(', ')}`);
  console.log(`factions after   : ${[...(villains.factions || []).map(f => f.name), ...newFactions.map(f => f.name)].join(', ')}`);
  console.log('');
  for (const f of newFactions) {
    console.log(`${f.name} (${f.villains.length})`);
    for (const v of f.villains) {
      const ab = v.quirk_mechanics.abilities.length;
      console.log(`  ${v.name}${v.alias ? ` “${v.alias}”` : ''}`.padEnd(42)
        + `${v.role}`.padEnd(42)
        + `abilities=${ab}${v.quirk_mechanics.weakness ? ' weakness' : ''}`);
    }
    console.log('');
  }

  if (!doWrite) {
    console.log('DRY RUN — villains.json untouched. Re-run with --write to commit.');
    return;
  }

  villains.factions = [...(villains.factions || []), ...newFactions];
  fs.writeFileSync(villainsPath, JSON.stringify(villains, null, 2) + '\n');

  const check = JSON.parse(fs.readFileSync(villainsPath, 'utf8'));
  const total = check.factions.reduce((n, f) => n + f.villains.length, 0);
  console.log(`WRITTEN. villains.json now has ${check.factions.length} factions and ${total} entries.`);
})().catch(e => { console.error('\nERROR:', e.message); process.exit(1); });
