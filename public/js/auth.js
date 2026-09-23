async function loadProfile() {
  const { data, error } = await apiCall('GET', '/api/me');

  if (error || !data) {
    window.location.href = '/login.html';
    return;
  }

  const nameEl   = document.getElementById('user-name');
  const emailEl  = document.getElementById('user-email');
  const phoneEl  = document.getElementById('user-phone');
  const mfaEl    = document.getElementById('user-mfa');
  const avatarEl = document.getElementById('user-avatar');
  const meJSON   = document.getElementById('api-me-response');

  if (nameEl)  nameEl.textContent  = data.fullName;
  if (emailEl) emailEl.textContent = data.email;
  if (phoneEl) phoneEl.textContent = data.phone;
  if (mfaEl) {
    mfaEl.innerHTML = data.mfaEnabled
      ? `<span class="badge badge-success">✓ Enabled (${data.mfaMethod})</span>`
      : `<span class="badge badge-gray">Disabled</span>`;
  }
  if (avatarEl) avatarEl.textContent = (data.fullName || 'U')[0].toUpperCase();

  const greet = document.getElementById('dash-greet');
  if (greet) greet.textContent = `Welcome, ${data.fullName.split(' ')[0]}!`;

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

async function runJWTDemo() {
  const tokenResultEl     = document.getElementById('jwt-token-result');
  const protectedResultEl = document.getElementById('jwt-protected-result');
  const demoBtn           = document.getElementById('jwt-demo-btn');
  if (!demoBtn) return;

  demoBtn.addEventListener('click', async () => {
    setButtonLoading(demoBtn, true);
    if (tokenResultEl) tokenResultEl.textContent = 'Requesting token...';
    if (protectedResultEl) protectedResultEl.textContent = '';

    const { data: tokenData, error: tokenErr } = await apiCall('POST', '/api/token');
    if (tokenErr) {
      tokenResultEl.textContent = `Error: ${tokenErr}`;
      setButtonLoading(demoBtn, false);
      return;
    }

    tokenResultEl.textContent = `Token received (15 min):\n${tokenData.token.slice(0, 40)}...`;

    try {
      const res = await fetch('/api/protected', {
        headers: { 'Authorization': `Bearer ${tokenData.token}` },
        credentials: 'include'
      });
      const pd = await res.json();
      if (protectedResultEl) protectedResultEl.textContent = JSON.stringify(pd, null, 2);
    } catch (err) {
      if (protectedResultEl) protectedResultEl.textContent = `Network error: ${err.message}`;
    }

    setButtonLoading(demoBtn, false);
  });
}

async function setupLogout() {
  const btn = document.getElementById('logout-btn');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    setButtonLoading(btn, true);
    await apiCall('POST', '/api/logout');
    window.location.href = '/login.html';
  });
}

document.addEventListener('DOMContentLoaded', () => {
  loadProfile();
  runJWTDemo();
  setupLogout();
});
