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

  window.fbDb = db;

  const EMPTY_STATE = { user: null, role: null, editableCharacterIds: [] };
  let resolveReady;
  window.fbAuthReady = new Promise((res) => { resolveReady = res; });

  let currentState = EMPTY_STATE;
  window.canEdit = function (characterId) {
    if (currentState.role === 'admin') return true;
    if (characterId != null && currentState.role === 'editor') {
      return currentState.editableCharacterIds.includes(characterId);
    }
    return false;
  };

  function injectStyles() {
    const css = `
      #auth-widget { display: flex; align-items: center; gap: 8px; }
      #auth-status { font-size: 12px; color: var(--text-muted, #8A9BB0); }
      #auth-signin-btn, #auth-signout-btn, #auth-admin-link {
        padding: 6px 12px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer;
        border: 1px solid var(--border-strong, rgba(255,255,255,0.14));
        background: var(--surface2, #18222E); color: var(--text-muted, #8A9BB0);
        text-decoration: none; white-space: nowrap;
      }
      #auth-overlay {
        position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 1000;
        display: none; align-items: center; justify-content: center;
      }
      #auth-overlay.open { display: flex; }
      #auth-modal {
        background: var(--surface, #111923); border: 1px solid var(--border-strong, rgba(255,255,255,0.14));
        border-radius: 12px; padding: 24px; width: 320px; display: flex; flex-direction: column; gap: 10px;
      }
      #auth-modal h3 { font-size: 15px; margin-bottom: 4px; }
      #auth-modal input {
        background: var(--surface2, #18222E); border: 1px solid var(--border-strong, rgba(255,255,255,0.14));
        border-radius: 8px; color: var(--text, #E8EDF3); font-size: 13px; padding: 8px 10px; outline: none;
      }
      #auth-modal .auth-row { display: flex; gap: 8px; }
      #auth-modal button {
        padding: 8px 12px; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer;
        border: 1px solid var(--border-strong, rgba(255,255,255,0.14)); background: var(--surface2, #18222E);
        color: var(--text, #E8EDF3); flex: 1;
      }
      #auth-modal button.primary { background: rgba(14,165,114,0.18); border-color: rgba(14,165,114,0.4); color: var(--teal-text, #5FDBAA); }
      #auth-modal-error { font-size: 12px; color: var(--red-text, #FCA5A5); min-height: 14px; }
      #auth-modal-close { align-self: flex-end; cursor: pointer; color: var(--text-muted, #8A9BB0); font-size: 12px; }
      #auth-signin-btn:focus-visible, #auth-signout-btn:focus-visible, #auth-admin-link:focus-visible,
      #auth-modal-close:focus-visible, #auth-modal input:focus-visible, #auth-modal button:focus-visible {
        outline: 2px solid var(--gold, #E8A020); outline-offset: 2px;
      }
    `;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

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
    injectStyles();
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
