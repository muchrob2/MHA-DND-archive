/* Shared Firebase auth widget for the MHA-DND archive pages.
   Include after the firebase-app/auth/firestore compat scripts and set
   window.AUTH_BASE = '' (or '../' from subfolders) before this script if needed. */
(function () {
  const BASE = window.AUTH_BASE || '';

  const firebaseConfig = {
    apiKey: "AIzaSyAX4qLRUWXFrA1sX-XC2KIYuGyc1aD8oX8",
    authDomain: "mha-dnd-archive.firebaseapp.com",
    projectId: "mha-dnd-archive",
    storageBucket: "mha-dnd-archive.firebasestorage.app",
    messagingSenderId: "1095293073071",
    appId: "1:1095293073071:web:bba6898534bd713cec865a"
  };
  if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
  const auth = firebase.auth();
  const db = firebase.firestore();

  // Firestore's default read transport is a streaming channel, which Safari's
  // tracking protection, content blockers and some proxies refuse — it fails
  // with "Fetch API cannot load ... due to access control checks" while the
  // *write* transport keeps working. That combination is nastier than being
  // fully offline: saves land on the server, but onSnapshot goes on serving
  // stale cached data, which pages then apply over the user's live edits.
  // Auto-detect falls back to long polling when the stream can't be
  // established. Must run before the first read/write; wrapped because
  // settings() throws if Firestore has already been used.
  try {
    db.settings({ experimentalAutoDetectLongPolling: true, merge: true });
  } catch (e) {
    console.warn('[auth] Firestore long-polling auto-detect not applied:', e.message);
  }

  window.fbDb = db;

  const EMPTY_STATE = { user: null, role: null, editableCharacterIds: [] };
  let resolveReady;
  window.fbAuthReady = new Promise((res) => { resolveReady = res; });

  let currentState = EMPTY_STATE;
  window.isAdmin = function () {
    return currentState.role === 'admin';
  };
  /* The key an editable-character assignment is stored under.
     admin.js writes these from its checkboxes, characters.js builds the
     same string as _staticId, and heropad.js matches roster students
     against it. Three files spelling out `type + '::' + name` separately
     is how heropad.js ended up asking for a numeric roster id instead and
     silently matching nothing for months. One definition, here. */
  window.fbCharacterKey = function (type, name) {
    return String(type) + '::' + String(name);
  };

  window.canEdit = function (characterId) {
    if (currentState.role === 'admin') return true;
    if (characterId != null && currentState.role === 'editor') {
      return currentState.editableCharacterIds.includes(characterId);
    }
    return false;
  };

  // Merge-save for shared documents edited by multiple people at once.
  //
  // A plain `docRef.set(localCopy)` overwrites the whole document, so if two
  // people edit different items concurrently, whoever saves last silently
  // erases the other's change. This instead reads the *current* server
  // document inside a transaction and, for each array field named in
  // `idArrays`, only substitutes in the items this client actually changed
  // since `lastSyncedDoc` (its own edits) — everything else (including
  // concurrent edits from other clients) is taken from the fresh server read.
  //
  // Everything outside idArrays gets a recursive object merge (matching what
  // Firestore's own `set(data, {merge: true})` does): nested plain objects
  // merge key-by-key instead of one wholesale replace, so a field this
  // client doesn't know about (added by someone else, or nested a level
  // deeper than it happens to be editing) survives. Only true leaf values —
  // arrays not named in idArrays, and primitives — are local-wins, since
  // those are typically single-actor state (e.g. "current turn index").
  // Array fields NOT named in idArrays are therefore still last-write-wins
  // wholesale, same as before — name every array a client might race on.
  //
  // idArrays: [{ path: 'combatants', idKey: 'id' }, { path: ['a', 'b', 'c'], idKey: 'id' }, ...]
  // `path` is a single key (string) or, to reach an array nested inside
  // plain objects/maps, an array of segments — e.g. per-character
  // sub-documents keyed by filename: ['characters', c._file, 'abilities'].
  // Segments must be an array, not a dotted string, because map keys here
  // (filenames) themselves contain literal dots ("ren_suzuki.json").
  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }
  function getAtPath(obj, path) {
    const keys = Array.isArray(path) ? path : [path];
    return keys.reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }
  function setAtPath(obj, path, value) {
    const keys = Array.isArray(path) ? path : [path];
    let cur = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!isPlainObject(cur[keys[i]])) cur[keys[i]] = {};
      cur = cur[keys[i]];
    }
    cur[keys[keys.length - 1]] = value;
  }
  function deepMergeLocalOverServer(server, local) {
    const result = Object.assign({}, server);
    for (const key of Object.keys(local)) {
      result[key] = (isPlainObject(local[key]) && isPlainObject(result[key]))
        ? deepMergeLocalOverServer(result[key], local[key])
        : local[key];
    }
    return result;
  }

  // `lastSyncedDoc` is the 3-way baseline: "what this client last knew the
  // server to hold". The merge tells an edit apart from an untouched item by
  // comparing the local item against its baseline copy — so the baseline must
  // be a *detached* snapshot. Storing the page's own live state as the
  // baseline (`_lastSynced = data`, or anything shallow-copied out of it)
  // aliases the two: editing an attack mutates the baseline in lockstep, the
  // comparison below always reads "unchanged", and the server's older copy is
  // written back over the edit. Adding an item is worse — it shows up in the
  // baseline too, so the "only truly new items" rule drops it and the new item
  // vanishes on save. Callers must clone with fsCloneDoc() whenever they set a
  // baseline from live state; the value fsMergeSave *returns* is already a
  // detached copy, safe to keep as the next baseline directly.
  //
  // These documents are plain JSON (no Dates, no Firestore Timestamps), so a
  // JSON round-trip is a sufficient clone — and it drops undefined-valued keys
  // exactly the way the JSON.stringify comparison below does.
  function cloneDoc(doc) {
    return doc == null ? doc : JSON.parse(JSON.stringify(doc));
  }
  window.fsCloneDoc = cloneDoc;

  window.fsMergeSave = async function (docRef, localDoc, lastSyncedDoc, idArrays) {
    idArrays = idArrays || [];
    await window.fbAuthReady;

    return db.runTransaction(async (tx) => {
      const snap = await tx.get(docRef);
      const server = snap.exists ? snap.data() : {};
      const result = deepMergeLocalOverServer(server, localDoc);

      for (const { path, idKey } of idArrays) {
        const serverArrRaw = getAtPath(server, path);
        const localArrRaw = getAtPath(localDoc, path);
        const lastArrRaw = getAtPath(lastSyncedDoc, path);
        const serverArr = Array.isArray(serverArrRaw) ? serverArrRaw : [];
        const localArr = Array.isArray(localArrRaw) ? localArrRaw : [];
        const lastArr = Array.isArray(lastArrRaw) ? lastArrRaw : [];

        const lastById = new Map(lastArr.map((item) => [item[idKey], item]));
        const localById = new Map(localArr.map((item) => [item[idKey], item]));

        const merged = [];
        const seen = new Set();

        for (const item of serverArr) {
          const id = item[idKey];
          seen.add(id);
          const hadLocally = localById.has(id);
          const wasSyncedBefore = lastById.has(id);
          if (!hadLocally) {
            if (wasSyncedBefore) continue; // this client deleted it locally
            merged.push(item); // added by someone else — keep it
            continue;
          }
          const localItem = localById.get(id);
          const lastItem = lastById.get(id);
          const changedLocally = JSON.stringify(localItem) !== JSON.stringify(lastItem);
          merged.push(changedLocally ? localItem : item);
        }

        for (const item of localArr) {
          const id = item[idKey];
          // Only truly new items (never synced before) get added here. An
          // item missing from the server but present in lastArr means
          // someone else deleted it remotely -- don't resurrect it just
          // because this client's local copy happens to be stale.
          if (!seen.has(id) && !lastById.has(id)) merged.push(item);
        }

        setAtPath(result, path, merged);
      }

      tx.set(docRef, result);
      // `result` still holds references to the caller's live objects (the
      // idArrays loop pushes local items straight in). Hand back a detached
      // copy so callers can store it as their next baseline without aliasing
      // their own state — see cloneDoc above.
      return cloneDoc(result);
    });
  };

  // The auth widget's CSS used to be injected from here at runtime as an
  // 11th stylesheet. It hardcoded dark-theme fallbacks — var(--surface,
  // #111923) and friends — which rendered wrong on the light parchment
  // pages, so campaigns.html and campaign-overview.html each carried an
  // identical copy-pasted !important block to correct it. All of it now
  // lives in css/components.css under the token system, and both override
  // blocks are gone. The widget still mounts into `.nav-right`.

  function buildWidget() {
    const widget = document.createElement('div');
    widget.id = 'auth-widget';
    widget.innerHTML = `
      <span id="auth-status"></span>
      <a id="auth-admin-link" href="${BASE}admin.html" style="display:none;">Admin</a>
      <button id="auth-signin-btn" type="button">Sign in</button>
      <button id="auth-signout-btn" type="button" style="display:none;">Sign out</button>
    `;

    const overlay = document.createElement('div');
    overlay.id = 'auth-overlay';
    overlay.innerHTML = `
      <div id="auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-modal-title">
        <div id="auth-modal-close" role="button" tabindex="0" aria-label="Close">✕</div>
        <h3 id="auth-modal-title">Sign in</h3>
        <input id="auth-email" type="email" placeholder="Email" autocomplete="username" aria-label="Email">
        <input id="auth-password" type="password" placeholder="Password" autocomplete="current-password" aria-label="Password">
        <div id="auth-modal-error" role="alert"></div>
        <div class="auth-row">
          <button id="auth-signin-submit" type="button" class="primary">Sign in</button>
          <button id="auth-signup-submit" type="button">Sign up</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
    document.getElementById('auth-modal-close').addEventListener('click', closeModal);
    document.getElementById('auth-modal-close').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); closeModal(); }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.getElementById('auth-overlay').classList.contains('open')) closeModal();
    });
    widget.querySelector('#auth-signin-btn').addEventListener('click', openModal);
    widget.querySelector('#auth-signout-btn').addEventListener('click', () => {
      auth.signOut();
    });

    document.getElementById('auth-signin-submit').addEventListener('click', () => submit('signin'));
    document.getElementById('auth-signup-submit').addEventListener('click', () => submit('signup'));
    const onEnterSubmit = (e) => { if (e.key === 'Enter') submit('signin'); };
    document.getElementById('auth-email').addEventListener('keydown', onEnterSubmit);
    document.getElementById('auth-password').addEventListener('keydown', onEnterSubmit);

    return widget;
  }

  let lastFocusedEl = null;
  function openModal() {
    lastFocusedEl = document.activeElement;
    document.getElementById('auth-modal-error').textContent = '';
    document.getElementById('auth-overlay').classList.add('open');
    document.getElementById('auth-email').focus();
  }
  function closeModal() {
    document.getElementById('auth-overlay').classList.remove('open');
    if (lastFocusedEl && typeof lastFocusedEl.focus === 'function') lastFocusedEl.focus();
  }

  async function submit(mode) {
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    const errEl = document.getElementById('auth-modal-error');
    errEl.textContent = '';
    if (!email || !password) { errEl.textContent = 'Email and password are required.'; return; }
    try {
      if (mode === 'signup') {
        const cred = await auth.createUserWithEmailAndPassword(email, password);
        await db.collection('users').doc(cred.user.uid).set({
          email,
          role: 'pending',
          editableCharacterIds: [],
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      } else {
        await auth.signInWithEmailAndPassword(email, password);
      }
      closeModal();
    } catch (e) {
      errEl.textContent = e.message;
    }
  }

  function renderState(state) {
    const statusEl = document.getElementById('auth-status');
    const signinBtn = document.getElementById('auth-signin-btn');
    const signoutBtn = document.getElementById('auth-signout-btn');
    const adminLink = document.getElementById('auth-admin-link');
    if (state.user) {
      statusEl.textContent = `${state.user.email} (${state.role || 'pending'})`;
      signinBtn.style.display = 'none';
      signoutBtn.style.display = '';
      adminLink.style.display = state.role === 'admin' ? '' : 'none';
    } else {
      statusEl.textContent = '';
      signinBtn.style.display = '';
      signoutBtn.style.display = 'none';
      adminLink.style.display = 'none';
    }
    document.dispatchEvent(new CustomEvent('auth-state-changed', { detail: state }));
  }

  function mountWidget() {
    const target = document.querySelector('.nav-right') || document.body;
    const widget = buildWidget();
    target.insertBefore(widget, target.firstChild);
  }

  document.addEventListener('DOMContentLoaded', mountWidget);

  auth.onAuthStateChanged(async (user) => {
    let state;
    if (user && user.isAnonymous) {
      auth.signOut();
      return;
    }
    if (!user) {
      state = EMPTY_STATE;
    } else {
      let role = null, editableCharacterIds = [];
      try {
        const snap = await db.collection('users').doc(user.uid).get();
        if (snap.exists) {
          role = snap.data().role || null;
          editableCharacterIds = snap.data().editableCharacterIds || [];
        }
      } catch {}
      state = { user, role, editableCharacterIds };
    }
    currentState = state;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => renderState(state));
    } else {
      renderState(state);
    }
    resolveReady(state);
    resolveReady = (v) => {};
    window.fbAuthReady = Promise.resolve(state);
  });
})();
