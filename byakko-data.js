// Byakko, as data. Loaded as a CLASSIC script (not a module) by heat.html, so
// BYAKKO_RANKS and the rest are plain globals like RULES_REFERENCE in
// rules-data.js.
//
// ── Everything here is transcribed, not invented ────────────────────
// The Heat track, the ranks, the Law, who shows up at which band and what
// happens at 8 and at 10 are all written in CAMPAIGN/campaigns.json, in
// "Byakko — the Stripe Law and the Heat track" and the two sections it
// points at. This file is that appendix in a shape the tracker can render.
//
// scripts/verify-heat.js holds every name and every number here against the
// campaign text, the same rule the loot tables are held to: if the appendix
// changes, this file fails until it is changed too.
//
// Where the campaign gives only a surname — two of the four Corners — this
// file gives only a surname. Inventing a given name to fill a column would
// be putting words in the campaign's mouth.

// 0 to 10, "on a strip of paper the players can see."
const HEAT_MIN = 0;
const HEAT_MAX = 10;

// The bands, and who is home in each. `extended` is the Chapter 7+ list from
// "who shows up, extended" — the middle of the gang, once it is named.
const HEAT_BANDS = [
  { from: 0, to: 1, who: 'A knot of Strays, or Hazama Ritsu ("Ricochet").',
    extended: '', mood: 'quiet' },
  { from: 2, to: 3, who: 'Claws; the Echo Twins.',
    extended: 'Nagira Sou, Ōkawachi Jin or Tobe Miyu.', mood: 'quiet' },
  { from: 4, to: 5, who: 'A Fang — Brick or Hairpin — with two Claws. From Heat 4, Hairpin has something standing behind her: an Astral Court trace.',
    extended: 'Murase Kotoha, Yanagi Daichi or Imai Tatsuhiko.', mood: 'warm' },
  { from: 6, to: 7, who: 'A Stripe — Three-Stripe Kō or Madame Tsuru — with an escort.',
    extended: 'Kōno Sae, Fukami Ryōta or Sawaguchi Hidemi.', mood: 'warm' },
  { from: 8, to: 9, who: 'A Corner.',
    extended: 'The Corners come down. Each one asks for somebody specific, by festival name.', mood: 'hot' },
  { from: 10, to: 10, who: 'A note on the Heights Alliance doormat, in white paint.',
    extended: 'Hakuro Mitsuki. The roof, at one in the morning.', mood: 'hot' },
];

// What moves the needle, straight out of the appendix. `sign` is for the UI;
// `delta` is what it does.
const HEAT_TRIGGERS = [
  { id: 'ranked', delta: +1, label: 'Beat a ranked member, witnessed',
    note: 'Strays do not count.' },
  { id: 'ring', delta: +2, label: 'A fight in the Ring',
    note: 'Friday night: the back cage at Swing Town, or the Cage itself.' },
  { id: 'holding', delta: +1, label: 'Window started with a PC holding a rank',
    note: 'Every window, while any PC holds a rank under the Law.' },
  { id: 'quiet', delta: -1, label: 'A window with no Byakko contact at all',
    note: 'Heat 0 does not mean Byakko have stopped existing. It means they are being polite.' },
  { id: 'lostcorner', delta: -1, label: 'Lost fairly to a Corner',
    note: 'Fairly. The Law notices the difference.' },
  { id: 'lostrank', delta: -2, label: 'Lost a held rank',
    note: 'You are what you have beaten, and you are not what you have lost.' },
];

// The caps by chapter. Chapter 6 onward has none, and Heat carries over from
// wherever Chapter 6 left it.
const HEAT_CAPS = { 2: 3, 3: 5, 4: 7, 5: 7, 6: null, 7: null, 8: null };

// The six rules on the wall by the Cage's ground-floor door, the sixth in a
// different hand. A seventh exists only if the class wrote one.
const BYAKKO_LAW = [
  'You are what you have beaten.',
  'Anybody may climb.',
  'Nobody runs on their own street.',
  'Nobody touches the noodle bar.',
  'The Tiger is whoever is left.',
  'Nobody fights a kid who has not got a stripe yet.',
];

// Madame Tsuru's suggested wording, if the table adds one in Chapter 7.
const BYAKKO_SEVENTH_SUGGESTION = 'Seven. You climb with what\'s yours.';

/* The named gang, by rank — about three hundred people across two wards, of
 * whom these are the ones the campaign names. Every one of them holds their
 * rank because of a specific fight that specific people watched, and most of
 * them can tell you the date, which is why "beaten" is worth tracking at all.
 *
 * `stripes` is what the forearm says. Strays have none and are not members,
 * so beating one does not move Heat — the tracker says so where it counts.
 */
const BYAKKO_RANKS = [
  {
    id: 'claw', name: 'Claws', stripes: 1,
    about: 'One stripe. They collect, they enforce, and they are the gang\'s teenagers. About sixty of them.',
    members: [
      { id: 'hazama', name: 'Hazama Ritsu', alias: 'Ricochet', note: 'Volunteers instantly, cheerfully, against anybody. No judgement at all.' },
      { id: 'nagira', name: 'Nagira Sou', alias: 'Pylon', note: 'Holds the laundrette corner. Collects protection money apologetically.' },
      { id: 'tobe', name: 'Tobe Miyu', alias: 'Tally', note: 'Cannot fight at all. One stripe for hitting a Stray with a chair in front of nine witnesses.' },
      { id: 'okawachi', name: 'Ōkawachi Jin', alias: 'Dropkick', note: 'Challenges upward constantly, loses constantly, completely undeterred.' },
      { id: 'echotwins', name: 'The Echo Twins', alias: '', note: 'Will fight as a pair if the class will, which is the only time anybody in Byakko fights two on two.' },
    ],
  },
  {
    id: 'fang', name: 'Fangs', stripes: 2,
    about: 'Two stripes. A Fang runs a block and wants a witness for everything. About twenty.',
    members: [
      { id: 'domeki', name: 'Dōmeki Daigo', alias: 'Brick', note: 'Runs Swing Town. The Fang most PCs meet first, and gentle with the kids who come in to bat.' },
      { id: 'saeki', name: 'Saeki Momo', alias: 'Hairpin', note: 'Wants to race Izuto and nobody else. From Heat 4 she has an Astral Court trace behind her.' },
      { id: 'murase', name: 'Murase Kotoha', alias: 'Nettle', note: 'Holds the noodle bar\'s street and personally enforces rule four. Most likely to help the class, and will deny it.' },
      { id: 'yanagi', name: 'Yanagi Daichi', alias: 'Half-Step', note: 'The best technician in the gang, and the one who teaches the Claws. Failed the U.A. entrance exam twice.' },
      { id: 'imai', name: 'Imai Tatsuhiko', alias: 'Sandbag', note: 'Runs the betting book on Ring nights out of Swing Town\'s back office.' },
    ],
  },
  {
    id: 'stripe', name: 'Stripes', stripes: 3,
    about: 'Three stripes, a street each, about a dozen of them. These are the ones worth naming.',
    members: [
      { id: 'ibuki', name: 'Ibuki Kōsuke', alias: 'Three-Stripe Kō', note: 'Down from the Cage with a notebook and a question.' },
      { id: 'tsuru', name: 'Madame Tsuru', alias: '', note: 'Her dice are on the loot table, and she suggested the wording for a seventh rule.' },
      { id: 'kono', name: 'Kōno Sae', alias: 'Hinge', note: 'Holds the chop shop. Opens any lock by touch. Sold a man with a scar a white van for cash in the spring.' },
      { id: 'fukami', name: 'Fukami Ryōta', alias: 'Ladder', note: 'Holds the Shinjuku west-exit alleys, and recruits. The most dangerous person in the gang; has never hurt anybody.' },
      { id: 'sawaguchi', name: 'Sawaguchi Hidemi', alias: 'Quiet', note: 'Holds the hospital street. Patches up every fighter in the backstreets and asks nothing. The Legion\'s loudest trace.' },
    ],
  },
  {
    id: 'four', name: 'Four stripes', stripes: 4,
    about: 'Which is not a rank, and now is. Byakko have no rule for him and several of them have asked for one.',
    members: [
      { id: 'amano', name: 'Amano Keita', alias: 'Footnote', note: 'Has beaten six people with a phone propped on a crate. From Chapter 7 he can appear at any Heat, because he does not wait to be invited.' },
    ],
  },
  {
    id: 'corner', name: 'The Four Corners', stripes: 4,
    about: 'Each holds a quarter of the turf, and each is named after one of the other guardian beasts as a boast: Byakko keeps the other gods as doormen.',
    members: [
      { id: 'kuze', name: 'Kuze', alias: '', note: 'Wants Masahata — water against water. Lightning in water is very bad news for him.' },
      { id: 'hojo', name: 'Hōjō', alias: '', note: 'Wants Tazato — fire against fire — and plays to her rooftop crowd.' },
      { id: 'genda', name: 'Genda Tetsuo', alias: 'the Black Corner', note: 'On the step at the Cage\'s front door with a paperback. Wants whoever hits hardest, and will stop mid-fight to talk about engineering.' },
      { id: 'koga', name: 'Kōga Rin', alias: '', note: 'The Tiger\'s second, and the Cage is her quarter. Wants Izuto and nobody else, and simply wants to know.' },
    ],
  },
  {
    id: 'tiger', name: 'The White Tiger', stripes: 5,
    about: 'A full pelt down the back — whoever nobody can beat.',
    members: [
      { id: 'hakuro', name: 'Hakuro Mitsuki', alias: 'Byakko', note: 'Undefeated for six years. Not a villain — a champion, and the gang\'s Law in a person. She wrote rule six herself.' },
    ],
  },
];

/* ── Helpers ──────────────────────────────────────────────────────── */

function heatBandFor(level) {
  const n = Math.max(HEAT_MIN, Math.min(HEAT_MAX, Number(level) || 0));
  return HEAT_BANDS.find(b => n >= b.from && n <= b.to) || HEAT_BANDS[0];
}

// The next band up, or null at the top. This is what the page teases with.
function heatNextBand(level) {
  const band = heatBandFor(level);
  const i = HEAT_BANDS.indexOf(band);
  return i >= 0 && i < HEAT_BANDS.length - 1 ? HEAT_BANDS[i + 1] : null;
}

function heatCapFor(chapter) {
  const c = Number(chapter);
  return Object.prototype.hasOwnProperty.call(HEAT_CAPS, c) ? HEAT_CAPS[c] : null;
}

// Clamped to the track and to the chapter's cap, which is the whole reason
// caps exist: Chapter 2 cannot reach a Corner however well the class fight.
function heatClamp(level, chapter) {
  const cap = heatCapFor(chapter);
  const top = cap == null ? HEAT_MAX : Math.min(HEAT_MAX, cap);
  return Math.max(HEAT_MIN, Math.min(top, Math.round(Number(level) || 0)));
}

function byakkoMember(id) {
  for (const rank of BYAKKO_RANKS) {
    const m = (rank.members || []).find(x => x.id === id);
    if (m) return { member: m, rank };
  }
  return null;
}

function byakkoAllMembers() {
  return BYAKKO_RANKS.flatMap(r => r.members.map(m => ({ ...m, rank: r })));
}
