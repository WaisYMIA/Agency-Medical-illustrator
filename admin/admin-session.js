// ============================================================
// Medical Premium Illustrator — Admin sign-in, shared by every admin page
// ============================================================
//
// One module so branding.html, rate-import.html, agents.html and
// analytics.html all sign in the same way and share one session.
//
// Two ways in, matching the backend (see backend/README.md):
//   1. A personal account (username + password) -> a session token,
//      stored in this browser and sent as X-Admin-Session. Actions are
//      then attributed to YOU in the audit log.
//   2. The legacy shared ADMIN_SECRET -> sent as X-Admin-Secret. Kept for
//      backward compatibility; actions are logged as 'legacy-secret'.
//      The secret is held in memory only, never saved to the browser.
//
// The session token IS saved in this browser (localStorage) so you stay
// signed in between visits. On a shared computer, click Sign out.

const ADMIN_SESSION_KEY = 'mpi_admin_session';
let _legacySecret = '';

function getAdminSession() {
  try {
    const raw = localStorage.getItem(ADMIN_SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !s.token) return null;
    if (s.expiresAt && Date.now() > s.expiresAt) { clearAdminSession(); return null; }
    return s;
  } catch (e) { return null; }
}
function saveAdminSession(s) {
  try { localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(s)); } catch (e) { /* storage unavailable — signed in for this page load only */ }
}
function clearAdminSession() {
  try { localStorage.removeItem(ADMIN_SESSION_KEY); } catch (e) { /* nothing to clear */ }
}
function setLegacySecret(value) { _legacySecret = value || ''; }

// The headers every admin request should carry. A real session wins over
// the legacy secret if both are present.
function adminAuthHeaders() {
  const s = getAdminSession();
  if (s) return { 'X-Admin-Session': s.token };
  if (_legacySecret) return { 'X-Admin-Secret': _legacySecret };
  return {};
}

async function adminLogin(baseUrl, username, password) {
  try {
    const res = await fetch(baseUrl + '/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || 'Sign-in failed.' };
    saveAdminSession({ token: data.token, username: data.username, role: data.role, expiresAt: data.expiresAt });
    return { ok: true, username: data.username };
  } catch (e) {
    return { ok: false, error: 'Could not reach the backend. Check the Backend URL above.' };
  }
}

async function adminLogout(baseUrl) {
  const s = getAdminSession();
  if (s) {
    try { await fetch(baseUrl + '/api/admin/logout', { method: 'POST', headers: { 'X-Admin-Session': s.token } }); }
    catch (e) { /* even if the server can't be reached, forget the session locally */ }
  }
  clearAdminSession();
}

// Call with any admin response. If the server rejected our saved session
// (expired, or the database was reset), drop it so the page shows the
// sign-in form instead of failing mysteriously. Returns true if it did.
function handleAdminAuthFailure(res) {
  if (res && res.status === 401 && getAdminSession()) { clearAdminSession(); return true; }
  return false;
}

// ---------------- Shared sign-in panel (browser only) ----------------
function renderAdminAuthPanel(container, getBackendUrl, onChange) {
  const mk = (tag, style, text) => {
    const e = document.createElement(tag);
    if (style) e.setAttribute('style', style);
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const inputStyle = 'width:100%; padding:8px 10px; border:1px solid #ddd3c6; border-radius:4px; font-size:13.5px; font-family:inherit; box-sizing:border-box;';
  const labelStyle = 'display:block; font-size:12.5px; font-weight:600; margin-bottom:4px;';
  const btnStyle = 'background:#a6192e; color:#fff; border:none; padding:9px 16px; border-radius:4px; font-size:13px; font-weight:600; cursor:pointer;';
  const changed = () => { if (onChange) onChange(); };

  container.innerHTML = '';
  const session = getAdminSession();

  if (session) {
    const row = mk('div', 'display:flex; align-items:center; gap:12px; flex-wrap:wrap;');
    const who = mk('div', 'font-size:13.5px;');
    who.appendChild(document.createTextNode('Signed in as '));
    who.appendChild(mk('strong', '', session.username));
    const out = mk('button', btnStyle + 'background:transparent; color:#a6192e; border:1px solid #a6192e;', 'Sign out');
    out.type = 'button';
    out.addEventListener('click', async () => { await adminLogout(getBackendUrl()); renderAdminAuthPanel(container, getBackendUrl, onChange); changed(); });
    row.appendChild(who); row.appendChild(out);
    container.appendChild(row);
    return;
  }

  const grid = mk('div', 'display:flex; gap:12px; flex-wrap:wrap; align-items:flex-end;');
  const uField = mk('div', 'flex:1; min-width:160px;');
  uField.appendChild(mk('label', labelStyle, 'Username'));
  const u = mk('input', inputStyle); u.type = 'text'; u.autocomplete = 'username';
  uField.appendChild(u);
  const pField = mk('div', 'flex:1; min-width:160px;');
  pField.appendChild(mk('label', labelStyle, 'Password'));
  const p = mk('input', inputStyle); p.type = 'password'; p.autocomplete = 'current-password';
  pField.appendChild(p);
  const go = mk('button', btnStyle, 'Sign in'); go.type = 'button';
  grid.appendChild(uField); grid.appendChild(pField); grid.appendChild(go);
  container.appendChild(grid);

  const status = mk('div', 'margin-top:10px; font-size:12.5px; color:#8a5a1c; display:none;');
  container.appendChild(status);

  const submit = async () => {
    status.style.display = 'none';
    go.disabled = true;
    const result = await adminLogin(getBackendUrl(), u.value.trim(), p.value);
    go.disabled = false;
    if (result.ok) { renderAdminAuthPanel(container, getBackendUrl, onChange); changed(); }
    else { status.textContent = result.error; status.style.display = 'block'; }
  };
  go.addEventListener('click', submit);
  p.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

  const details = mk('details', 'margin-top:14px; font-size:12.5px;');
  details.appendChild(mk('summary', 'cursor:pointer; color:#77655e;', 'No personal account yet? Use the legacy admin secret instead'));
  const note = mk('div', 'margin:8px 0; color:#77655e; font-size:11.5px;', 'Actions taken this way are logged as "legacy-secret" rather than under your name. The secret is held in memory only — it is not saved in this browser.');
  const s = mk('input', inputStyle + 'max-width:360px;'); s.type = 'password'; s.placeholder = 'Value of ADMIN_SECRET on the backend';
  s.addEventListener('input', () => setLegacySecret(s.value));
  s.addEventListener('change', changed);
  details.appendChild(note); details.appendChild(s);
  container.appendChild(details);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ADMIN_SESSION_KEY, getAdminSession, saveAdminSession, clearAdminSession, setLegacySecret,
    adminAuthHeaders, adminLogin, adminLogout, handleAdminAuthFailure, renderAdminAuthPanel,
  };
}
