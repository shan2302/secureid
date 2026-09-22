/**
 * auth.js — Dashboard authentication & /api/me + JWT demo
 */

// ============================================================
// /api/me — Fetch authenticated user info
// ============================================================
async function loadUserProfile() {
  const { data, error } = await apiCall('GET', '/api/me');

  if (error || !data) {
    // Not authenticated — redirect to login
    window.location.href = '/login.html';
    return;
  }

  // Populate dashboard UI
  const nameEl   = document.getElementById('user-name');
  const emailEl  = document.getElementById('user-email');
  const phoneEl  = document.getElementById('user-phone');
  const mfaEl    = document.getElementById('user-mfa');
  const avatarEl = document.getElementById('user-avatar');
  const meJSON   = document.getElementById('api-me-response');

  if (nameEl)   nameEl.textContent   = data.fullName;
  if (emailEl)  emailEl.textContent  = data.email;
  if (phoneEl)  phoneEl.textContent  = data.phone;
  if (mfaEl)    mfaEl.innerHTML      = data.mfaEnabled
    ? `<span class="badge badge-success">✓ Enabled (${data.mfaMethod})</span>`
    : `<span class="badge badge-gray">Disabled</span>`;

  if (avatarEl) {
    // Show first letter of name
    avatarEl.textContent = (data.fullName || 'U')[0].toUpperCase();
  }

  const dashGreet = document.getElementById('dash-greet');
  if (dashGreet) dashGreet.textContent = `Welcome, ${data.fullName.split(' ')[0]}!`;

  // Display the raw /api/me JSON response
  if (meJSON) {
    meJSON.textContent = JSON.stringify({
      userId:        data.userId,
      fullName:      data.fullName,
      email:         data.email,
      phone:         data.phone,
      emailVerified: data.emailVerified,
      phoneVerified: data.phoneVerified,
      mfaEnabled:    data.mfaEnabled,
      mfaMethod:     data.mfaMethod,
      createdAt:     data.createdAt
    }, null, 2);
  }
}

// ============================================================
// /api/token + /api/protected — JWT Bearer demo
// ============================================================
async function runJWTDemo() {
  const tokenResultEl     = document.getElementById('jwt-token-result');
  const protectedResultEl = document.getElementById('jwt-protected-result');
  const demoBtn           = document.getElementById('jwt-demo-btn');

  if (!demoBtn) return;

  demoBtn.addEventListener('click', async () => {
    setButtonLoading(demoBtn, true);
    if (tokenResultEl)     tokenResultEl.textContent = 'Requesting token...';
    if (protectedResultEl) protectedResultEl.textContent = '';

    // Step 1: POST /api/token (requires existing session cookie)
    const { data: tokenData, error: tokenErr } = await apiCall('POST', '/api/token');

    if (tokenErr) {
      tokenResultEl.textContent = `Error: ${tokenErr}`;
      setButtonLoading(demoBtn, false);
      return;
    }

    tokenResultEl.textContent = `Token received (15 min):\n${tokenData.token.slice(0,40)}...`;

    // Step 2: GET /api/protected with Bearer token
    try {
      const res = await fetch('/api/protected', {
        headers: { 'Authorization': `Bearer ${tokenData.token}` },
        credentials: 'include'
      });
      const pd = await res.json();
      if (protectedResultEl) {
        protectedResultEl.textContent = JSON.stringify(pd, null, 2);
      }
    } catch (err) {
      if (protectedResultEl) {
        protectedResultEl.textContent = `Network error: ${err.message}`;
      }
    }

    setButtonLoading(demoBtn, false);
  });
}

// ============================================================
// Logout
// ============================================================
async function setupLogout() {
  const logoutBtn = document.getElementById('logout-btn');
  if (!logoutBtn) return;

  logoutBtn.addEventListener('click', async () => {
    setButtonLoading(logoutBtn, true);

    await apiCall('POST', '/api/logout');

    // Redirect to login (session & JWT cookie cleared server-side)
    window.location.href = '/login.html';
  });
}

// ============================================================
// Initialise
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  loadUserProfile();
  runJWTDemo();
  setupLogout();
});
