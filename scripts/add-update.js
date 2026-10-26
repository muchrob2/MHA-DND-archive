#!/usr/bin/env node
/* Add an entry to updates.json without hand-computing anything.
 *
 * Why this exists: the version, build, date and commit in an entry are read
 * out of git rather than typed, because the deploy stamps version.json as
 * 1.0.<commit count> and verify-updates.js checks every entry back against
 * the history. Doing that by hand is four git commands and an opportunity to
 * get one of them wrong. This does it.
 *
 * The title and the lines are yours — that is the part a script cannot write,
 * because the whole point of the notes is that they say what changed in
 * words, not what the diff was.
 *
 * Usage:
 *   node scripts/add-update.js --title "Short title" \
 *       --tag board --tag fix \
 *       --item "One thing that changed." \
 *       --item "Another thing." \
 *       [--commit HEAD] [--pr 147] [--write]
 *
 * Without --write it prints the entry it would add and changes nothing.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');
const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();

function parseArgs(argv) {
  const out = { tags: [], items: [], commit: 'HEAD', write: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--title') out.title = next();
    else if (a === '--tag') out.tags.push(next());
    else if (a === '--item') out.items.push(next());
    else if (a === '--commit') out.commit = next();
    else if (a === '--pr') out.pr = Number(next());
    else if (a === '--write') out.write = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error('ERROR: ' + e.message);
  process.exit(2);
}

const docPath = path.join(repoRoot, 'updates.json');
const doc = JSON.parse(fs.readFileSync(docPath, 'utf8'));

if (!args.title || !args.items.length || !args.tags.length) {
  console.error('usage: node scripts/add-update.js --title "..." --tag <tag> --item "..." [--item "..."] [--commit SHA] [--pr N] [--write]');
  console.error('known tags: ' + (doc.tags || []).join(', '));
  process.exit(2);
}

const unknown = args.tags.filter(t => !(doc.tags || []).includes(t));
if (unknown.length) {
  // Refused rather than added, because the filter row is built from this list
  // and a one-off tag would be a filter with one thing behind it forever.
  console.error(`ERROR: unknown tag(s): ${unknown.join(', ')}`);
  console.error('known tags: ' + (doc.tags || []).join(', '));
  console.error('add it to the "tags" array in updates.json first if it is a real category.');
  process.exit(2);
}

let build, date, commit;
try {
  build = Number(git('rev-list', '--count', args.commit));
  date = git('log', '-1', '--format=%ad', '--date=short', args.commit);
  commit = git('rev-parse', '--short', args.commit);
} catch {
  console.error(`ERROR: "${args.commit}" is not a commit in this repository`);
  process.exit(2);
}

const entry = {
  version: `1.0.${build}`,
  build,
  date,
  commit,
  ...(args.pr ? { pr: args.pr } : {}),
  title: args.title,
  tags: args.tags,
  items: args.items,
};

const clash = (doc.updates || []).find(u => u.build === build);
if (clash) {
  console.error(`ERROR: 1.0.${build} already has an entry — "${clash.title}"`);
  console.error('Pick a different --commit, or edit that entry instead of adding a second one for the same release.');
  process.exit(2);
}

console.log(JSON.stringify(entry, null, 2));

if (!args.write) {
  console.log('\nDRY RUN — nothing written. Re-run with --write to add it.');
  process.exit(0);
}

doc.updates = [entry, ...(doc.updates || [])].sort((a, b) => b.build - a.build);
fs.writeFileSync(docPath, JSON.stringify(doc, null, 2) + '\n');
console.log(`\nAdded to updates.json as ${entry.version}. ${doc.updates.length} entries now.`);
console.log('Run `node scripts/verify-updates.js` to check it against the history.');
