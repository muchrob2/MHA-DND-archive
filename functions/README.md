# Cloud Functions — server-side money

Everything else in this project is a static site talking straight to
Firestore. That works because the stakes are low: a wrong relationship score
is a typo. Money is different — the client is a web page the player controls,
so it cannot be the thing that decides a purchase happened.

## What changed

Inventory used to live inside `mha-dnd/relationships-bundle`, which players
must be able to write in order to save their own character sheets. Firestore
rules could not separate the two: a purchase and a hand-edit are the same
shape of write to the same document, and the rules language has no loops to
walk twenty characters checking that only the caller's purse moved, and only
downwards.

So inventory moved to its own collection:

    inventories/{characterFile}      allow read: if true
                                     allow write: if false

`write: if false` is not a placeholder. The Admin SDK inside a Cloud Function
bypasses rules entirely, so these functions still write freely — everyone
else is refused by the database rather than by a check in a page they
control. The ledger is locked the same way, because a statement you can forge
is not evidence.

## The functions

| Function | Who may call it | What it does |
|---|---|---|
| `spend` | editor (own characters) or admin | Takes catalogue **ids and quantities, never prices**, looks the prices up server-side, checks the purse covers it, and writes the purse and the ledger entry in one transaction. |
| `grantInventory` | admin only | The DM's grant panel. Same transaction guarantee. |
| `migrateInventories` | admin only | One-time copy of each inventory out of the bundle. Never overwrites an inventory that already exists, so it is safe to run twice. |

## Deploying

This needs the **Blaze** plan — callable functions are not on Spark. At five
players buying lunch the cost rounds to nothing, but the plan does need a card
on file.

```sh
npm --prefix functions install
npm run sync-functions-data          # copies catalogue, menu and roster in
firebase deploy --only functions,firestore:rules
```

Then, signed in as an admin, call the migration once from the browser console
on any page of the site:

```js
await firebase.functions().httpsCallable('migrateInventories')({})
```

It reports which characters it moved and which already had an inventory.

## Order of operations

Deploy the functions **before** the rules. Between the rules landing and the
functions existing, nothing can write a purse at all — including the shop.
Deploying functions first means the only window is one where the old path
still works.

The bundle keeps its copy of every inventory after the migration. Nothing
reads it, and leaving it means a bad deploy can be rolled back without
anyone's money disappearing. Clear it by hand once you are happy.

## Data files

`functions/data/` holds copies of the shop catalogue, the Eats menu and the
roster, because a deploy only uploads this directory. `npm run
sync-functions-data` refreshes them and the predeploy hook in `firebase.json`
runs it automatically. `scripts/verify-functions.js` fails if the copies drift
from the canonical files — otherwise the price shown would not be the price
charged.
