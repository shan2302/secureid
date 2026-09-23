let loginState = {
  challengeId: null,
  mfaMethod: null,
  selectedMethod: null,
  stopTimer: null
};

const loginStepMap = { 'login': 0, 'choose-method': 1, 'otp': 2 };

function showLoginScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${id}`)?.classList.add('active');

  const step = loginStepMap[id] ?? 0;
  document.querySelectorAll('.step-item').forEach((item, i) => {
    item.classList.remove('active', 'completed');
    if (i < step) item.classList.add('completed');
    else if (i === step) item.classList.add('active');
    const circle = item.querySelector('.step-circle');
    if (!circle) return;
    circle.innerHTML = i < step
      ? `<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6L4.5 8.5L10 3.5" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      : i + 1;
  });
  document.querySelectorAll('.step-connector').forEach((c, i) => c.classList.toggle('done', i < step));
}

(function() {
  const form      = document.getElementById('login-form');
  const emailEl   = document.getElementById('login-email');
  const passEl    = document.getElementById('login-password');
  const eyeBtn    = document.getElementById('toggle-password');
  const submitBtn = document.getElementById('login-submit-btn');
  const alertBox  = document.getElementById('login-alert');
  const emailErrIcon = document.getElementById('login-email-err-icon');
  const passErrIcon  = document.getElementById('login-pass-err-icon');

  eyeBtn.addEventListener('click', () => {
    const show = passEl.type === 'text';
    passEl.type = show ? 'password' : 'text';
    eyeBtn.innerHTML = show
      ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`
      : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
  });

  [emailEl, passEl].forEach(el => {
    el.addEventListener('input', () => {
      el.classList.remove('error');
      emailErrIcon?.classList.remove('visible');
      passErrIcon?.classList.remove('visible');
      hideAlert(alertBox);
    });
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    hideAlert(alertBox);

    const email = emailEl.value.trim();
    const pass  = passEl.value;
    if (!email || !pass) { showAlert(alertBox, 'Please enter your email and password.'); return; }

    setButtonLoading(submitBtn, true);
    const { data, error } = await apiCall('POST', '/api/login', { email, password: pass });
    setButtonLoading(submitBtn, false);

    if (error) {
      emailEl.classList.add('error');
      passEl.classList.add('error');
      emailErrIcon?.classList.add('visible');
      passErrIcon?.classList.add('visible');
      showAlert(alertBox, error);
      return;
    }

    if (data.mfaRequired) {
      loginState.challengeId = data.challengeId;
      loginState.mfaMethod   = data.method;
      showLoginScreen('choose-method');
      pickMethod(data.method);
    } else {
      window.location.href = '/dashboard.html';
    }
  });
})();

(function() {
  const cards       = document.querySelectorAll('#screen-choose-method .mfa-method-card');
  const continueBtn = document.getElementById('choose-method-continue-btn');
  const alertBox    = document.getElementById('choose-method-alert');
  const backBtn     = document.getElementById('back-to-login-btn');

  cards.forEach(card => {
    card.addEventListener('click', () => {
      cards.forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      loginState.selectedMethod = card.dataset.method;
    });
  });

  backBtn?.addEventListener('click', () => showLoginScreen('login'));

  continueBtn.addEventListener('click', () => {
    if (!loginState.selectedMethod) { showAlert(alertBox, 'Please choose a verification method.'); return; }
    buildOTPScreen(loginState.selectedMethod, loginState.challengeId);
    showLoginScreen('otp');
  });

  window.pickMethod = function(method) {
    cards.forEach(c => {
      c.classList.remove('selected');
      if (c.dataset.method === method) { c.classList.add('selected'); loginState.selectedMethod = method; }
    });
    if (!document.querySelector('#screen-choose-method .mfa-method-card.selected')) {
      cards[0]?.classList.add('selected');
      loginState.selectedMethod = cards[0]?.dataset.method;
    }
  };
})();

(function() {
  const inputs    = document.querySelectorAll('#screen-otp .otp-input');
  const verifyBtn = document.getElementById('otp-verify-btn');
  const alertBox  = document.getElementById('otp-alert');
  const resendBtn = document.getElementById('otp-resend-btn');
  const timerEl   = document.getElementById('otp-timer');
  const resendCnt = document.getElementById('otp-resend-count');
  const backBtn   = document.getElementById('back-to-choose-btn');
  const titleEl   = document.getElementById('otp-screen-title');
  const subtitleEl= document.getElementById('otp-screen-subtitle');
  const iconWrap  = document.getElementById('otp-icon-wrap');
  const resendRow = document.getElementById('otp-resend-row');

  backBtn?.addEventListener('click', () => showLoginScreen('choose-method'));

  initOTPInputs(inputs, code => { if (code.length === 6) submitOTP(code); });

  verifyBtn.addEventListener('click', () => {
    const code = getOTPValue(inputs);
    if (code.length < 6) { showAlert(alertBox, 'Please enter all 6 digits.'); return; }
    submitOTP(code);
  });

  document.querySelectorAll('#screen-otp .key-btn').forEach(btn => {
    btn.addEventListener('click', () => keypadInput(inputs, btn.dataset.key));
  });

  resendBtn?.addEventListener('click', async () => {
    resendBtn.disabled = true;
    clearOTPInputs(inputs);
    hideAlert(alertBox);
    showAlert(alertBox, 'Please go back and log in again to get a new code.', 'info');
    resendBtn.disabled = false;
  });

  async function submitOTP(code) {
    hideAlert(alertBox);
    setButtonLoading(verifyBtn, true);
    const { data, error } = await apiCall('POST', '/api/verify-login-otp', { challengeId: loginState.challengeId, otp: code });
    setButtonLoading(verifyBtn, false);
    if (error) { markOTPError(inputs); showAlert(alertBox, error); return; }
    window.location.href = '/dashboard.html';
  }

  function runOTPCountdown(total) {
    if (loginState.stopTimer) loginState.stopTimer();
    let resend = 30;
    resendBtn.disabled = true;

    loginState.stopTimer = startCountdown(total, rem => {
      timerEl.innerHTML = `Code expires in <span class="timer-value">${formatTimer(rem)}</span>`;
      resend--;
      resendCnt.textContent = resend > 0 ? ` (00:${String(resend).padStart(2, '0')})` : '';
      if (resend <= 0) resendBtn.disabled = false;
    }, () => { timerEl.classList.add('expired'); resendBtn.disabled = false; });
  }

  window.buildOTPScreen = function(method, challengeId) {
    loginState.challengeId    = challengeId;
    loginState.selectedMethod = method;
    clearOTPInputs(inputs);
    hideAlert(alertBox);

    if (method === 'email') {
      iconWrap.className = 'icon-circle blue';
      iconWrap.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#3B5BDB" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>`;
      titleEl.textContent    = 'Email Verification';
      subtitleEl.textContent = 'Enter the 6-digit code sent to your email.';
      resendRow.style.display = '';
      runOTPCountdown(300);
    } else if (method === 'sms') {
      iconWrap.className = 'icon-circle green';
      iconWrap.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#16A34A" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.8a19.79 19.79 0 01-3.07-8.63A2 2 0 012 .18h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.09-1.09a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>`;
      titleEl.textContent    = 'Mobile Verification';
      subtitleEl.textContent = 'Enter the 6-digit code sent to your mobile.';
      resendRow.style.display = '';
      runOTPCountdown(300);
    } else {
      iconWrap.className = 'icon-circle blue';
      iconWrap.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#3B5BDB" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>`;
      titleEl.textContent    = 'Authenticator App';
      subtitleEl.textContent = 'Enter the 6-digit code from your authenticator app.';
      resendRow.style.display = 'none';
      let totpSec = 30;
      timerEl.innerHTML = `Code expires in <span class="timer-value">${formatTimer(totpSec)}</span>`;
      setInterval(() => {
        totpSec--;
        if (totpSec <= 0) totpSec = 30;
        timerEl.innerHTML = `Code expires in <span class="timer-value">${formatTimer(totpSec)}</span>`;
      }, 1000);
    }

    setTimeout(() => document.querySelector('#screen-otp .otp-input')?.focus(), 100);
  };
})();

function keypadInput(inputs, key) {
  inputs = Array.from(inputs);
  if (key === 'del') {
    for (let i = inputs.length - 1; i >= 0; i--) {
      if (inputs[i].value) {
        inputs[i].value = '';
        inputs[i].classList.remove('otp-filled', 'otp-error');
        inputs[i].focus();
        return;
      }
    }
  } else {
    for (let i = 0; i < inputs.length; i++) {
      if (!inputs[i].value) {
        inputs[i].value = key;
        inputs[i].classList.add('otp-filled');
        if (i < inputs.length - 1) inputs[i + 1].focus();
        inputs[i].dispatchEvent(new Event('input'));
        return;
      }
    }
  }
}
