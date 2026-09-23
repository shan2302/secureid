let regState = {
  userId: null,
  emailChallengeId: null,
  smsChallengeId: null,
  mfaChoice: null,
  email: null,
  phone: null,
  stopTimer: null
};

const stepMap = {
  'reg': 0, 'email-otp': 1, 'sms-otp': 2,
  'mfa-setup': 3, 'auth-setup': 4, 'auth-verify': 4, 'success': 4
};

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${id}`)?.classList.add('active');

  const step = stepMap[id] ?? 0;
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
  const form      = document.getElementById('register-form');
  const name      = document.getElementById('reg-name');
  const email     = document.getElementById('reg-email');
  const phone     = document.getElementById('reg-phone');
  const pass      = document.getElementById('reg-password');
  const eyeBtn    = document.getElementById('toggle-password');
  const rulesBox  = document.getElementById('password-rules');
  const terms     = document.getElementById('terms-check');
  const submitBtn = document.getElementById('reg-submit-btn');
  const alertBox  = document.getElementById('reg-alert');

  eyeBtn.addEventListener('click', () => {
    const show = pass.type === 'text';
    pass.type = show ? 'password' : 'text';
    eyeBtn.innerHTML = show ? eyeClose() : eyeOpen();
  });

  pass.addEventListener('input', () => {
    renderPasswordRules(rulesBox, pass.value);
    setFieldError(pass, document.getElementById('reg-password-error'), null);
  });

  [name, email, phone].forEach(el => {
    const err = document.getElementById(`reg-${el.id.split('-')[1]}-error`);
    el.addEventListener('focus', () => setFieldError(el, err, null));
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    hideAlert(alertBox);

    const n = name.value.trim();
    const em = email.value.trim();
    const ph = phone.value.trim();
    const pw = pass.value;
    let bad = false;

    if (n.length < 2) { setFieldError(name, document.getElementById('reg-name-error'), 'Name must be at least 2 characters.'); bad = true; }
    if (!isValidEmail(em)) { setFieldError(email, document.getElementById('reg-email-error'), 'Enter a valid email address.'); bad = true; }
    if (!isValidPhone(ph)) { setFieldError(phone, document.getElementById('reg-phone-error'), 'Enter a valid phone number.'); bad = true; }
    if (!isPasswordStrong(pw)) { setFieldError(pass, document.getElementById('reg-password-error'), 'Password does not meet all requirements.'); bad = true; }
    if (!terms.checked) { showAlert(alertBox, 'Please agree to the Terms & Conditions.'); bad = true; }
    if (bad) return;

    setButtonLoading(submitBtn, true);
    const { data, error } = await apiCall('POST', '/api/register', {
      fullName: n, email: em, phone: '+91' + ph.replace(/\D/g, ''), password: pw
    });
    setButtonLoading(submitBtn, false);

    if (error) { showAlert(alertBox, error); return; }

    regState.userId = data.userId;
    regState.emailChallengeId = data.challengeId;
    regState.email = em;
    regState.phone = ph;

    document.getElementById('email-otp-target').textContent = em;
    showScreen('email-otp');
    startEmailTimer(data.expiresAt);
    document.querySelector('#screen-email-otp .otp-input')?.focus();
  });
})();

(function() {
  const inputs    = document.querySelectorAll('#screen-email-otp .otp-input');
  const verifyBtn = document.getElementById('email-otp-verify-btn');
  const alertBox  = document.getElementById('email-otp-alert');
  const resendBtn = document.getElementById('email-resend-btn');
  const timerEl   = document.getElementById('email-otp-timer');
  const resendCnt = document.getElementById('email-resend-count');

  initOTPInputs(inputs, code => { if (code.length === 6) doEmailVerify(code); });

  verifyBtn.addEventListener('click', () => {
    const code = getOTPValue(inputs);
    if (code.length < 6) { showAlert(alertBox, 'Please enter all 6 digits.'); return; }
    doEmailVerify(code);
  });

  document.querySelectorAll('#screen-email-otp .key-btn').forEach(btn => {
    btn.addEventListener('click', () => keypadInput(inputs, btn.dataset.key));
  });

  resendBtn.addEventListener('click', async () => {
    resendBtn.disabled = true;
    clearOTPInputs(inputs);
    hideAlert(alertBox);
    const { data, error } = await apiCall('POST', '/api/resend-otp', { userId: regState.userId, channel: 'email' });
    if (error) { showAlert(alertBox, error); resendBtn.disabled = false; return; }
    regState.emailChallengeId = data.challengeId;
    startEmailTimer(data.expiresAt);
  });

  async function doEmailVerify(code) {
    hideAlert(alertBox);
    setButtonLoading(verifyBtn, true);
    const { data, error } = await apiCall('POST', '/api/verify-email-otp', { challengeId: regState.emailChallengeId, otp: code });
    setButtonLoading(verifyBtn, false);

    if (error) {
      markOTPError(inputs);
      showAlert(alertBox, error);
      return;
    }

    clearOTPInputs(inputs);
    if (regState.stopTimer) regState.stopTimer();

    const { data: smsData, error: smsErr } = await apiCall('POST', '/api/send-sms-otp', { userId: regState.userId });
    if (smsErr) { showAlert(alertBox, smsErr); return; }

    regState.smsChallengeId = smsData.challengeId;
    document.getElementById('sms-otp-target').textContent = '+91 ' + regState.phone;
    showScreen('sms-otp');
    startSMSTimer(smsData.expiresAt);
    document.querySelector('#screen-sms-otp .otp-input')?.focus();
  }

  window.startEmailTimer = function(expiresAt) {
    if (regState.stopTimer) regState.stopTimer();
    const total = Math.floor((new Date(expiresAt) - Date.now()) / 1000);
    let resend = 30;
    resendBtn.disabled = true;

    regState.stopTimer = startCountdown(total, rem => {
      timerEl.innerHTML = `Code expires in <span class="timer-value">${formatTimer(rem)}</span>`;
      resend--;
      resendCnt.textContent = resend > 0 ? ` (00:${String(resend).padStart(2, '0')})` : '';
      if (resend <= 0) resendBtn.disabled = false;
    }, () => { timerEl.classList.add('expired'); resendBtn.disabled = false; });
  };
})();

(function() {
  const inputs    = document.querySelectorAll('#screen-sms-otp .otp-input');
  const verifyBtn = document.getElementById('sms-otp-verify-btn');
  const alertBox  = document.getElementById('sms-otp-alert');
  const resendBtn = document.getElementById('sms-resend-btn');
  const timerEl   = document.getElementById('sms-otp-timer');
  const resendCnt = document.getElementById('sms-resend-count');

  initOTPInputs(inputs, code => { if (code.length === 6) doSMSVerify(code); });

  verifyBtn.addEventListener('click', () => {
    const code = getOTPValue(inputs);
    if (code.length < 6) { showAlert(alertBox, 'Please enter all 6 digits.'); return; }
    doSMSVerify(code);
  });

  document.querySelectorAll('#screen-sms-otp .key-btn').forEach(btn => {
    btn.addEventListener('click', () => keypadInput(inputs, btn.dataset.key));
  });

  resendBtn.addEventListener('click', async () => {
    resendBtn.disabled = true;
    clearOTPInputs(inputs);
    hideAlert(alertBox);
    const { data, error } = await apiCall('POST', '/api/resend-otp', { userId: regState.userId, channel: 'sms' });
    if (error) { showAlert(alertBox, error); resendBtn.disabled = false; return; }
    regState.smsChallengeId = data.challengeId;
    startSMSTimer(data.expiresAt);
  });

  async function doSMSVerify(code) {
    hideAlert(alertBox);
    setButtonLoading(verifyBtn, true);
    const { data, error } = await apiCall('POST', '/api/verify-sms-otp', { challengeId: regState.smsChallengeId, otp: code });
    setButtonLoading(verifyBtn, false);

    if (error) { markOTPError(inputs); showAlert(alertBox, error); return; }
    clearOTPInputs(inputs);
    if (regState.stopTimer) regState.stopTimer();
    showScreen('mfa-setup');
  }

  window.startSMSTimer = function(expiresAt) {
    if (regState.stopTimer) regState.stopTimer();
    const total = Math.floor((new Date(expiresAt) - Date.now()) / 1000);
    let resend = 30;
    resendBtn.disabled = true;

    regState.stopTimer = startCountdown(total, rem => {
      timerEl.innerHTML = `Code expires in <span class="timer-value">${formatTimer(rem)}</span>`;
      resend--;
      resendCnt.textContent = resend > 0 ? ` (00:${String(resend).padStart(2, '0')})` : '';
      if (resend <= 0) resendBtn.disabled = false;
    }, () => { timerEl.classList.add('expired'); resendBtn.disabled = false; });
  };
})();

(function() {
  const cards       = document.querySelectorAll('#screen-mfa-setup .mfa-method-card');
  const continueBtn = document.getElementById('mfa-setup-continue-btn');
  const alertBox    = document.getElementById('mfa-setup-alert');

  cards.forEach(card => {
    card.addEventListener('click', () => {
      cards.forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      regState.mfaChoice = card.dataset.method;
    });
  });

  if (cards.length) { cards[0].classList.add('selected'); regState.mfaChoice = cards[0].dataset.method; }

  continueBtn.addEventListener('click', async () => {
    if (!regState.mfaChoice) { showAlert(alertBox, 'Please select an MFA method.'); return; }

    setButtonLoading(continueBtn, true);
    const { data, error } = await apiCall('POST', '/api/setup-mfa', { userId: regState.userId, method: regState.mfaChoice });
    setButtonLoading(continueBtn, false);

    if (error) { showAlert(alertBox, error); return; }

    if (regState.mfaChoice === 'authenticator') {
      document.getElementById('qr-image').src = data.qrCode;
      document.getElementById('qr-setup-key').textContent = data.setupKey;
      showScreen('auth-setup');
    } else {
      showScreen('success');
    }
  });
})();

(function() {
  const continueBtn = document.getElementById('auth-setup-continue-btn');
  const alertBox    = document.getElementById('auth-setup-alert');

  continueBtn.addEventListener('click', () => {
    hideAlert(alertBox);
    showScreen('auth-verify');
    document.querySelector('#screen-auth-verify .otp-input')?.focus();
  });
})();

(function() {
  const inputs    = document.querySelectorAll('#screen-auth-verify .otp-input');
  const verifyBtn = document.getElementById('auth-verify-btn');
  const alertBox  = document.getElementById('auth-verify-alert');
  const timerEl   = document.getElementById('auth-verify-timer');

  initOTPInputs(inputs, code => { if (code.length === 6) doTOTPVerify(code); });

  let totpSec = 30;
  setInterval(() => {
    totpSec--;
    if (totpSec <= 0) totpSec = 30;
    timerEl.innerHTML = `Code expires in <span class="timer-value">${formatTimer(totpSec)}</span>`;
  }, 1000);

  verifyBtn.addEventListener('click', () => {
    const code = getOTPValue(inputs);
    if (code.length < 6) { showAlert(alertBox, 'Please enter the 6-digit code.'); return; }
    doTOTPVerify(code);
  });

  document.querySelectorAll('#screen-auth-verify .key-btn').forEach(btn => {
    btn.addEventListener('click', () => keypadInput(inputs, btn.dataset.key));
  });

  async function doTOTPVerify(code) {
    hideAlert(alertBox);
    setButtonLoading(verifyBtn, true);
    const { data, error } = await apiCall('POST', '/api/verify-mfa-setup', { userId: regState.userId, code });
    setButtonLoading(verifyBtn, false);
    if (error) { markOTPError(inputs); showAlert(alertBox, error); return; }
    clearOTPInputs(inputs);
    showScreen('success');
  }
})();

document.getElementById('go-to-login-btn')?.addEventListener('click', () => {
  window.location.href = '/login.html';
});

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

function eyeOpen() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
}
function eyeClose() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
}
