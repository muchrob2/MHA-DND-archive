// The rules reference, as data. Loaded as a CLASSIC script (not a module) by
// every page that needs it, so RULES_REFERENCE and the helpers below are
// plain globals exactly like BOARD_PREFABS in board-prefabs.js.
//
// ── Why this is a .js file and not a .json one ──────────────────────
// Three pages read it, and one of them — the Encounter Manager — needs it
// SYNCHRONOUSLY: the condition chips on every combatant carry the rule as
// their tooltip, and they are rendered the moment the page paints. A fetch
// would mean bare tooltips until it lands, and no tooltips at all if it
// fails. A script tag has neither failure mode.
//
// ── It is also the single source of truth ───────────────────────────
// The conditions and cover lines used to live inline in encounter.js. They
// now live here only, and that page derives its two tables from this file
// (see rulesConditionMap / rulesCoverRows). scripts/verify-rules.js holds the
// three of them to the same list, so the reference page, the encounter
// panel's tooltips and the pips the board draws on a token can't drift apart.
//
// ── What belongs in here ────────────────────────────────────────────
// Mechanics, restated in one line each, for things that come up at the table
// often enough to be worth looking up mid-turn. Everything is a summary in
// our own words, never a quoted block — the two rulebook PDFs on the
// dashboard are the actual text, and `RULES_REFERENCE.source` says so on the
// page. Nothing campaign-specific goes in here: no NPCs, no locations, no
// story. That material has its own pages.
//
// Shape:
//   { id, name, icon, blurb, entries: [{ name, text, tags? }] }
//
//   id      stable string; the anchor in the page URL (#conditions)
//   icon    a single emoji — no image assets ship with this page
//   tags    optional words that should match in search but aren't printed

const RULES_REFERENCE = {
  source: 'Summaries, in our own words, of the mechanics that come up mid-turn. The two rulebook PDFs on the dashboard are the real text.',
  sections: [

  /* ── The d20 ── */
  {
    id: 'the-d20',
    name: 'Rolling the d20',
    icon: '🎲',
    blurb: 'Every check, attack and save is one d20 plus the modifiers, against a number.',
    entries: [
      { name: 'Ability check', text: 'Roll d20 + the ability modifier (+ proficiency if the skill applies) against a DC the DM sets. Meeting the DC succeeds; under it fails.', tags: 'skill test dc' },
      { name: 'The DC scale', text: 'Very easy 5, easy 10, medium 15, hard 20, very hard 25, nearly impossible 30. Most things at the table sit between 10 and 20.', tags: 'difficulty class' },
      { name: 'Attack roll', text: 'd20 + ability modifier + proficiency against the target\'s AC. Equal to the AC hits.', tags: 'to hit ac' },
      { name: 'Saving throw', text: 'd20 + the ability modifier (+ proficiency if you are proficient in that save) against the DC of whatever is happening to you.', tags: 'save resist' },
      { name: 'Advantage', text: 'Roll two d20 and keep the higher. Sources never stack — two reasons for advantage is still one advantage.', tags: 'adv two dice' },
      { name: 'Disadvantage', text: 'Roll two d20 and keep the lower. One of each cancels out completely, however many of either you have.', tags: 'disadv penalty cancel' },
      { name: 'Critical hit', text: 'A natural 20 on an attack always hits and you roll the damage dice twice — the flat modifiers are added once, not doubled.', tags: 'crit 20 nat' },
      { name: 'Critical miss', text: 'A natural 1 on an attack always misses, whatever your bonuses add up to. It is not an automatic disaster unless the DM says so.', tags: 'nat 1 fumble' },
      { name: 'Natural 20 on a save', text: 'A 20 on a saving throw is just a 20 plus your modifier — no automatic success. Only attack rolls crit.', tags: 'crit save' },
      { name: 'Passive score', text: '10 + the modifier, no roll. Passive Perception is what you notice without looking, and the DM uses it against anything hidden.', tags: 'perception insight 10' },
      { name: 'Contest', text: 'Both sides roll the relevant check and compare; a tie means nothing moves — the situation stays as it was.', tags: 'opposed grapple shove tie' },
      { name: 'Group check', text: 'Everyone rolls. If at least half the group succeeds, the group succeeds — good for sneaking a whole class past something.', tags: 'party half' },
      { name: 'Working together', text: 'One character can lend a hand instead of rolling, giving the one who does roll advantage — only if they could actually have done the task alone.', tags: 'help assist advantage' },
      { name: 'Proficiency bonus', text: '+2 at levels 1-4, +3 at 5-8, +4 at 9-12, +5 at 13-16, +6 at 17-20. Added once; never twice on the same roll.', tags: 'prof level' },
    ],
  },

  /* ── Your turn ── */
  {
    id: 'your-turn',
    name: 'Your turn',
    icon: '⏱',
    blurb: 'One action, one bonus action if you have one, your movement, and one free interaction — plus a reaction between turns.',
    entries: [
      { name: 'Action', text: 'One per turn. Attack, use a quirk, Dash, Disengage, Dodge, Help, Hide, Ready, Search, use an object, or anything the DM allows.', tags: 'main standard' },
      { name: 'Bonus action', text: 'One per turn, and only when something specifically grants one. You cannot turn an action into a bonus action because you did not use it.', tags: 'extra swift' },
      { name: 'Movement', text: 'Up to your speed, split however you like around the rest of your turn — move, attack, finish moving.', tags: 'speed walk split' },
      { name: 'Free interaction', text: 'One object interaction a turn comes free: draw a weapon, open a door, pull a lever, pick something up. The second one costs your action.', tags: 'object draw door' },
      { name: 'Reaction', text: 'One between the end of your turn and the start of your next, triggered by something specific. An opportunity attack is the usual one.', tags: 'opportunity trigger' },
      { name: 'Attack action', text: 'One attack, unless a feature gives you more. Each attack is rolled and resolved before the next one.', tags: 'strike hit' },
      { name: 'Dash', text: 'Spend your action to move your speed again. Difficult terrain still halves it.', tags: 'dash run double move' },
      { name: 'Disengage', text: 'Your action; your movement for the rest of the turn provokes no opportunity attacks.', tags: 'withdraw retreat safely' },
      { name: 'Dodge', text: 'Your action; until your next turn attacks against you have disadvantage and you have advantage on DEX saves. Lost if you are incapacitated or your speed is 0.', tags: 'defend evade' },
      { name: 'Hide', text: 'Your action; make a Stealth check against the passive Perception of anyone who might spot you. You need something to hide behind or in.', tags: 'stealth sneak hidden' },
      { name: 'Attacking while hidden', text: 'An attack from hiding has advantage, and reveals you whether it hits or misses.', tags: 'unseen advantage reveal' },
      { name: 'Search', text: 'Your action; a Perception or Investigation check to look for something you suspect is there.', tags: 'look investigate perception' },
      { name: 'Ready', text: 'Your action; name a trigger and one action or a move. If the trigger happens before your next turn, you spend your reaction to do it.', tags: 'readied hold trigger' },
      { name: 'Grapple', text: 'Replace one attack with an Athletics check against the target\'s Athletics or Acrobatics. On a win they are Grappled — speed 0 — and you have a hand full.', tags: 'grab hold restrain wrestle' },
      { name: 'Escaping a grapple', text: 'The grappled creature spends its action on an Athletics or Acrobatics check against the grappler\'s Athletics.', tags: 'break free wriggle' },
      { name: 'Shove', text: 'Replace one attack with an Athletics check against the target\'s Athletics or Acrobatics. On a win, knock it Prone or push it 5 ft.', tags: 'push knock down prone' },
      { name: 'Two-handed and versatile', text: 'A two-handed weapon needs both hands to attack with, not to hold. A versatile one uses the bigger die only when both hands are on it.', tags: 'weapon grip hands' },
      { name: 'Ranged into melee', text: 'A ranged attack has disadvantage while a hostile creature that can see you is within 5 ft of you and not incapacitated.', tags: 'point blank disadvantage shoot' },
      { name: 'Long range', text: 'Beyond a weapon\'s normal range and up to its long range, the attack has disadvantage. Past long range it simply cannot be made.', tags: 'distance far disadvantage' },
      { name: 'Improvising', text: 'Anything not on the list is still an action if the DM agrees — the DM picks the check, the DC, and whether it costs your action or your movement.', tags: 'creative stunt improvise' },
    ],
  },

  /* ── Moving ── */
  {
    id: 'moving',
    name: 'Moving around',
    icon: '👟',
    blurb: 'Distance on the board is counted in squares, and every square is 5 ft.',
    entries: [
      { name: 'Counting distance', text: 'Each square is 5 ft, and a diagonal counts as one square like any other — the grid is counted, not measured with a ruler.', tags: 'squares diagonal 5ft grid range' },
      { name: 'Difficult terrain', text: 'Every foot costs two, so you cover half the ground. Rubble, deep water, dense crowds, thick undergrowth — the board marks it.', tags: 'rough half speed rubble' },
      { name: 'Standing up', text: 'Getting up from Prone costs half your speed, and you cannot do it at all if your speed is 0.', tags: 'prone get up half' },
      { name: 'Climbing and swimming', text: 'Each foot costs an extra foot — difficult terrain, in effect — unless you have a climb or swim speed.', tags: 'climb swim half speed' },
      { name: 'Jumping', text: 'A running long jump clears your STR score in feet; a high jump clears 3 + your STR modifier. Halve both without a 10 ft run-up.', tags: 'leap long high standing' },
      { name: 'Crawling', text: 'Moving while Prone costs an extra foot per foot, so you crawl at half speed.', tags: 'prone crawl half' },
      { name: 'Moving through a creature', text: 'You can move through a friendly creature\'s space freely, and through a hostile one only if it is at least two sizes different from you. Either way the space is difficult terrain.', tags: 'squeeze past ally enemy' },
      { name: 'Squeezing', text: 'Into a space one size too small: half speed, disadvantage on attacks and DEX saves, and attacks against you have advantage.', tags: 'tight gap narrow' },
      { name: 'Opportunity attack', text: 'When a creature you can see leaves your reach using its movement, you may spend your reaction on one melee attack. Teleporting, being pushed, and Disengaging do not provoke it.', tags: 'reaction leaves reach provoke' },
      { name: 'Falling', text: '1d6 bludgeoning per 10 ft, to a maximum of 20d6, and you land Prone unless you took no damage at all.', tags: 'drop height d6 prone' },
      { name: 'Flying and falling', text: 'A flier whose speed drops to 0 falls, unless it can hover or is held up by something else.', tags: 'fly hover drop' },
      { name: 'Holding your breath', text: '1 + your CON modifier minutes, minimum 30 seconds. After that you survive CON-modifier rounds and then drop to 0 HP.', tags: 'suffocate drown air' },
    ],
  },

  /* ── Cover and sight ── */
  {
    id: 'cover-and-sight',
    name: 'Cover and sight',
    icon: '🛡',
    blurb: 'What is between you and the target, and whether you can see it at all. The board\'s props each say which of these they give.',
    entries: [
      { name: 'Half cover', text: '+2 AC and +2 on DEX saves. A low wall, a crate, a railing, a window frame — or another creature in the way.', tags: 'cover crate wall plus two' },
      { name: 'Three-quarters cover', text: '+5 AC and +5 on DEX saves. A portcullis, an arrow slit, a thick tree trunk, a car to shoot over.', tags: 'cover plus five slit' },
      { name: 'Total cover', text: 'Cannot be targeted by an attack or a spell at all — though an area effect that reaches round the corner may still catch it.', tags: 'cover full blocked untargetable' },
      { name: 'Only the best applies', text: 'Cover does not stack. Two crates and a railing is still half cover; take the single best degree between you and the target.', tags: 'stacking best degree' },
      { name: 'Lightly obscured', text: 'Dim light, patchy fog, light foliage: disadvantage on Perception checks that rely on sight. Attacks are unaffected.', tags: 'dim fog smoke obscured' },
      { name: 'Heavily obscured', text: 'Darkness, thick smoke, dense foliage: you are effectively Blinded looking into it — attacks out of it have disadvantage, attacks into it are made blind.', tags: 'darkness smoke blind obscured' },
      { name: 'Unseen attacker', text: 'Attacking someone who cannot see you gives advantage. Attacking someone you cannot see gives disadvantage, and you have to guess the square.', tags: 'invisible hidden advantage guess' },
      { name: 'Line of sight', text: 'Drawn corner to corner: if any line from any corner of your square reaches any corner of the target\'s without crossing a solid obstacle, you can see it.', tags: 'sight corner blocked los' },
    ],
  },

  /* ── Areas of effect ── */
  {
    id: 'areas',
    name: 'Areas of effect',
    icon: '💥',
    blurb: 'The three shapes a quirk or an explosion comes in. The battle board can draw all three on the grid.',
    entries: [
      { name: 'Burst', text: 'A radius from a point: every square whose centre is within the radius is in it. A 20 ft burst is four squares out in each direction.', tags: 'sphere radius circle blast' },
      { name: 'Cone', text: 'Starts at a point of your choosing and widens by one square either side for every square of length, out to its stated range.', tags: 'breath spray triangle widens' },
      { name: 'Line', text: 'Straight out from you to its length, usually 5 ft wide — one square across — catching everything the line crosses.', tags: 'beam bolt straight ray' },
      { name: 'Picking the origin', text: 'A point of origin must be somewhere you can see, and the effect spreads round corners from it — total cover genuinely blocks it.', tags: 'origin corners spread see' },
      { name: 'Saving against an area', text: 'Everyone caught in it rolls the stated save. Half damage on a success is the usual result, unless the effect says otherwise.', tags: 'half damage dex save' },
      { name: 'Friendly fire', text: 'An area effect hits allies in it exactly as hard as enemies, unless it says it does not. Check the squares before you throw it.', tags: 'allies teammates hit' },
    ],
  },

  /* ── Damage and healing ── */
  {
    id: 'damage',
    name: 'Damage and healing',
    icon: '❤️',
    blurb: 'Hit points, what shrugs damage off, and what gets it back.',
    entries: [
      { name: 'Hit points', text: 'Damage comes off your current HP and never takes it below 0. Healing never takes you above your maximum.', tags: 'hp health current max' },
      { name: 'Temporary hit points', text: 'A buffer that takes damage first and does not stack — a new lot replaces the old, it never adds. Lost on a long rest.', tags: 'temp hp buffer shield replace' },
      { name: 'Resistance', text: 'Halve the damage of that type, after everything else has been applied. Resistance never stacks with itself.', tags: 'half resist type' },
      { name: 'Vulnerability', text: 'Double the damage of that type, applied last, after any halving.', tags: 'double weak vulnerable' },
      { name: 'Immunity', text: 'No damage of that type at all, and no effect that rides along with it.', tags: 'none immune ignore' },
      { name: 'Order of operations', text: 'Add everything up, then apply resistance or vulnerability, then halve for a successful save. Halving twice rounds down each time.', tags: 'order rounding half sequence' },
      { name: 'Damage types', text: 'Bludgeoning, piercing and slashing are physical; acid, cold, fire, force, lightning, necrotic, poison, psychic, radiant and thunder are not.', tags: 'types physical elemental list' },
      { name: 'Healing someone at 0', text: 'Any healing at all brings them back to that many HP and conscious — death saves reset, and they are no longer Unconscious but they are still Prone.', tags: 'revive stabilise zero wake' },
      { name: 'Hit dice', text: 'On a short rest, spend any number of them: roll each and add your CON modifier. You get half your total back on a long rest.', tags: 'short rest spend roll recover' },
      { name: 'Knocking out instead', text: 'When you reduce a creature to 0 with a melee hit you may choose to knock it unconscious instead of dropping it — decide as the damage lands.', tags: 'nonlethal unconscious subdue capture' },
    ],
  },

  /* ── Dropping to 0 ── */
  {
    id: 'dying',
    name: 'Dropping to 0',
    icon: '💀',
    blurb: 'What happens between unconscious and dead. It comes up, and it is worth knowing exactly.',
    entries: [
      { name: 'Falling unconscious', text: 'At 0 HP you drop, Unconscious and Prone, and start making death saves on your turns.', tags: 'zero down out drop' },
      { name: 'Death saving throw', text: 'At the start of each of your turns, roll a plain d20 — no modifiers, no proficiency. 10 or more succeeds; under 10 fails.', tags: 'death save d20 ten' },
      { name: 'Three and three', text: 'Three successes and you are stable. Three failures and you die. They need not be consecutive, and both counts reset when you are healed or stabilised.', tags: 'three stable die reset' },
      { name: 'A 20 on a death save', text: 'You come round at 1 HP immediately. A 1 counts as two failures.', tags: 'nat 20 one failure two' },
      { name: 'Stabilising someone', text: 'Your action and a DC 10 Medicine check. They stay at 0 and Unconscious, but they stop rolling death saves.', tags: 'medicine dc10 first aid stop' },
      { name: 'Taking damage at 0', text: 'Any hit while you are down is one automatic death save failure, and a critical is two.', tags: 'hit while down failure crit' },
      { name: 'Instant death', text: 'If a single hit\'s leftover damage past 0 equals your HP maximum, you are dead outright, no saves.', tags: 'massive damage overkill dead' },
      { name: 'Monsters and NPCs', text: 'They usually just die at 0 rather than rolling — unless the DM has decided this one matters, which is the DM\'s call to make out loud.', tags: 'npc enemy dies dm' },
    ],
  },

  /* ── Conditions ── */
  {
    id: 'conditions',
    name: 'Conditions',
    icon: '🌀',
    blurb: 'The fourteen the Encounter Manager can apply, and the pip each one draws on a token.',
    entries: [
      { name: 'Blinded', text: 'Can\'t see: attacks against you have advantage, yours have disadvantage, and you fail any check needing sight.' },
      { name: 'Charmed', text: 'Can\'t attack the charmer or target them with harmful effects; the charmer has advantage on social checks against you.' },
      { name: 'Deafened', text: 'Can\'t hear, and you fail any check needing hearing.' },
      { name: 'Exhausted', text: 'Stacks in six levels, each worse than the last: disadvantage on checks, then half speed, then disadvantage on attacks and saves, then half HP, then speed 0, then dead.' },
      { name: 'Frightened', text: 'Disadvantage on attacks and checks while you can see the source, and you can\'t willingly move closer to it.' },
      { name: 'Grappled', text: 'Speed 0, no bonus to speed. Ends if the grappler is incapacitated or you are moved out of reach.' },
      { name: 'Incapacitated', text: 'No actions and no reactions. Most of the heavier conditions include this one.' },
      { name: 'Invisible', text: 'Can\'t be seen without special sense: attacks against you have disadvantage, yours have advantage. You can still be heard.' },
      { name: 'Paralyzed', text: 'Incapacitated, can\'t move or speak, auto-fail STR and DEX saves. Attacks against you have advantage, and any hit from within 5 ft is a critical.' },
      { name: 'Poisoned', text: 'Disadvantage on attack rolls and ability checks.' },
      { name: 'Prone', text: 'Can only crawl until you stand (half your movement). Your attacks have disadvantage; attacks against you have advantage within 5 ft, disadvantage further out.' },
      { name: 'Restrained', text: 'Speed 0. Attacks against you have advantage, yours have disadvantage, and you have disadvantage on DEX saves.' },
      { name: 'Stunned', text: 'Incapacitated, can\'t move, can barely speak, auto-fail STR and DEX saves, and attacks against you have advantage.' },
      { name: 'Unconscious', text: 'Incapacitated, prone, drops what it holds, unaware of everything, auto-fails STR and DEX saves, and any hit from within 5 ft is a critical.' },
    ],
  },

  /* ── Rests ── */
  {
    id: 'rests',
    name: 'Resting',
    icon: '🌙',
    blurb: 'The two lengths of rest, and what each one actually gives back.',
    entries: [
      { name: 'Short rest', text: 'At least an hour of doing nothing more taxing than eating, reading or standing watch. Spend hit dice to heal; some features come back.', tags: 'hour breather catch breath' },
      { name: 'Long rest', text: 'At least eight hours, of which six are sleep and two can be light activity. Interrupted by an hour of walking or fighting, and you start it again.', tags: 'eight hours sleep night overnight' },
      { name: 'What a long rest restores', text: 'All your hit points, half your hit dice (rounded down, minimum one), and one level of exhaustion.', tags: 'full heal recover restore hp' },
      { name: 'One a day', text: 'You only benefit from one long rest in any 24 hours, and you need at least 1 HP at the start of it to get anything from it.', tags: 'once daily twenty four' },
      { name: 'Losing temporary HP', text: 'Temporary hit points go at the end of a long rest, whether you used them or not.', tags: 'temp hp expire gone' },
    ],
  },

  /* ── At this table ── */
  {
    id: 'at-this-table',
    name: 'At this table',
    icon: '⚡',
    blurb: 'How the toolkit handles the fiddly bits — what the buttons on the board actually mean.',
    entries: [
      { name: 'Measuring on the board', text: 'The measure tool counts squares at 5 ft each, diagonals included, so the number it prints is the number the rules want.', tags: 'board measure range tool squares' },
      { name: 'Terrain the DM has marked', text: 'Shaded squares are the terrain in the rules above — difficult ground, water, hazards. They look the same on your board as on the DM\'s.', tags: 'board terrain shading difficult' },
      { name: 'Props and cover', text: 'Every piece of scenery on the board states the cover it gives in its own description. A crate is half, a bus is total; the three degrees above are the scale they are written against.', tags: 'board props scenery cover crate' },
      { name: 'Elevation numbers', text: 'A small number on a square is its height in squares. Higher ground sees over cover, and anything that falls off it uses the falling rule.', tags: 'board height level raised roof' },
      { name: 'Token size', text: 'A token covers the squares its size says: medium one, large four, huge nine. Reach and cover are worked out from the squares it actually fills.', tags: 'board large huge medium space' },
      { name: 'Doors', text: 'A door on the board is open or shut, and a shut one blocks sight and movement like a wall. Opening one is your free object interaction.', tags: 'board door shut open blocks' },
      { name: 'The dark on your board', text: 'Squares your character cannot see are hidden on the player board — not greyed out but genuinely absent, tokens and all. If you cannot see it, you cannot click it.', tags: 'board fog dark hidden vision' },
      { name: 'Yen', text: 'Money is tracked per character and spent in the Shop and on the Heropad. The DM hands it out through the session log, so the number on your pad is the real one.', tags: 'money cash shop bank spend' },
      { name: 'Asking instead of looking', text: 'If a rule is not in here and the answer would change what you do this turn, the DM rules on it now and looks it up afterwards. Momentum beats precision.', tags: 'ruling dm fiat house rule' },
    ],
  },

  ],
};

/* ── Helpers ────────────────────────────────────────────────────────
   The other pages reach for the data through these rather than walking
   the structure themselves, so the shape above stays free to change.
   ─────────────────────────────────────────────────────────────────── */

function rulesSection(id) {
  return RULES_REFERENCE.sections.find(s => s.id === id) || null;
}

// { Blinded: 'Can\'t see…', … } — what encounter.js used to hold inline.
function rulesConditionMap() {
  const out = {};
  for (const e of (rulesSection('conditions') || { entries: [] }).entries) out[e.name] = e.text;
  return out;
}

// [['Half cover', '+2 AC…'], …] — likewise, and in the page's own order.
function rulesCoverRows() {
  return (rulesSection('cover-and-sight') || { entries: [] }).entries
    .filter(e => /cover$/.test(e.name))
    .map(e => [e.name, e.text]);
}

function rulesEntryCount() {
  return RULES_REFERENCE.sections.reduce((n, s) => n + s.entries.length, 0);
}

// Every word of the query has to appear somewhere in the entry — its name,
// its text, its hidden tags or its section's name — so "half cover crate"
// finds the line without knowing how it is worded.
function rulesEntryMatches(entry, section, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const hay = [entry.name, entry.text, entry.tags || '', section.name].join(' ').toLowerCase();
  return q.split(/\s+/).filter(Boolean).every(w => hay.includes(w));
}
