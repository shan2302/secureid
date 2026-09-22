/**
 * register.js — Registration Journey Controller
 *
 * Flow:
 *   Screen 1: Registration form
 *   Screen 2: Email OTP
 *   Screen 3: SMS OTP
 *   Screen 4: Set Up MFA (choose method)
 *   Screen 5: Authenticator QR code
 *   Screen 6: Enter authenticator code
 *   Screen 7: Success
 */

// ============================================================
// STATE — tracks data across screens
// ============================================================
const state = {
  userId:          null,
  emailChallenge:  null,
  smsChallenge:    null,
  mfaMethod:       null,   // 'authenticator' | 'sms' | 'email'
  email:           null,
  phone:           null,
  cancelTimer:     null    // reference to the current countdown canceller
};

// ============================================================
// SCREEN MANAGEMENT
// ============================================================
const STEPS = ['reg', 'email-otp', 'sms-otp', 'mfa-setup', 'auth-setup', 'auth-verify', 'success'];

function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(`screen-${screenId}`);
  if (el) el.classList.add('active');
  updateStepBar(screenId);
}

// Step bar: maps screen to step index (0-based)
const screenToStep = {
  'reg':         0,
  'email-otp':   1,
  'sms-otp':     2,
  'mfa-setup':   3,
  'auth-setup':  4,
  'auth-verify': 4,
  'success':     4
};

function updateStepBar(screenId) {
  const currentStep = screenToStep[screenId] ?? 0;
  document.querySelectorAll('.step-item').forEach((item, idx) => {
    item.classList.remove('active', 'completed');
    if      (idx < currentStep)  item.classList.add('completed');
    else if (idx === currentStep) item.classList.add('active');

    // Update checkmark on completed steps
    const circle = item.querySelector('.step-circle');
    if (circle) {
      if (idx < currentStep) {
        circle.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M2 6L4.5 8.5L10 3.5" stroke="white" stroke-width="1.8"
            stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;
      } else {
        circle.textContent = idx + 1;
      }
    }
  });

  // Update connectors
  document.querySelectorAll('.step-connector').forEach((c, idx) => {
    c.classList.toggle('done', idx < currentStep);
  });
}

// ============================================================
// SCREEN 1 — Registration Form
// ============================================================
(function initRegistrationForm() {
  const form        = document.getElementById('register-form');
  const nameInput   = document.getElementById('reg-name');
  const emailInput  = document.getElementById('reg-email');
  const phoneInput  = document.getElementById('reg-phone');
  const passInput   = document.getElementById('reg-password');
  const togglePass  = document.getElementById('toggle-password');
  const rulesBox    = document.getElementById('password-rules');
  const termsCheck  = document.getElementById('terms-check');
  const submitBtn   = document.getElementById('reg-submit-btn');
  const alertEl     = document.getElementById('reg-alert');

  // Field error elements
  const nameErr   = document.getElementById('reg-name-error');
  const emailErr  = document.getElementById('reg-email-error');
  const phoneErr  = document.getElementById('reg-phone-error');
  const passErr   = document.getElementById('reg-password-error');

  // Password visibility toggle
  togglePass.addEventListener('click', () => {
    const isText = passInput.type === 'text';
    passInput.type = isText ? 'password' : 'text';
    togglePass.innerHTML = isText ? eyeClosedSVG() : eyeOpenSVG();
  });

  // Live password strength feedback
  passInput.addEventListener('input', () => {
    renderPasswordRules(rulesBox, passInput.value);
    setFieldError(passInput, passErr, null); // clear error while typing
  });

  // Clear field errors on focus
  [nameInput, emailInput, phoneInput].forEach(el => {
    el.addEventListener('focus', () => {
      setFieldError(el, el === nameInput ? nameErr :
                       el === emailInput ? emailErr : phoneErr, null);
    });
  });

  // Form submit
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert(alertEl);

    const name  = nameInput.value.trim();
    const email = emailInput.value.trim();
    const phone = phoneInput.value.trim();
    const pass  = passInput.value;

    // Client-side validation
    let hasError = false;

    if (name.length < 2) {
      setFieldError(nameInput, nameErr, 'Full name must be at least 2 characters.');
      hasError = true;
    }
    if (!isValidEmail(email)) {
      setFieldError(emailInput, emailErr, 'Please enter a valid email address.');
      hasError = true;
    }
    if (!isValidPhone(phone)) {
      setFieldError(phoneInput, phoneErr, 'Please enter a valid phone number.');
      hasError = true;
    }
    if (!isPasswordStrong(pass)) {
      setFieldError(passInput, passErr, 'Password does not meet all requirements.');
      hasError = true;
    }
    if (!termsCheck.checked) {
      showAlert(alertEl, 'Please agree to the Terms & Conditions and Privacy Policy.');
      hasError = true;
    }

    if (hasError) return;

    // Submit to backend
    setButtonLoading(submitBtn, true);

    const { data, error } = await apiCall('POST', '/api/register', {
      fullName: name,
      email,
      phone: '+91' + phone.replace(/\D/g, ''),
      password: pass
    });

    setButtonLoading(submitBtn, false);

    if (error) {
      showAlert(alertEl, error);
      return;
    }

    // Save state for next screens
    state.userId         = data.userId;
    state.emailChallenge = data.challengeId;
    state.email          = email;
    state.phone          = phone;

    // Move to email OTP screen
    document.getElementById('email-otp-target').textContent = email;
    showScreen('email-otp');
    startEmailOTPTimer(data.expiresAt);
    document.querySelector('#screen-email-otp .otp-input').focus();
  });
})();

// ============================================================
// SCREEN 2 — Email OTP
// ============================================================
(function initEmailOTP() {
  const inputs    = document.querySelectorAll('#screen-email-otp .otp-input');
  const verifyBtn = document.getElementById('email-otp-verify-btn');
  const alertEl   = document.getElementById('email-otp-alert');
  const resendBtn = document.getElementById('email-resend-btn');
  const timerEl   = document.getElementById('email-otp-timer');
  const resendCountEl = document.getElementById('email-resend-count');

  initOTPInputs(inputs, (code) => {
    // Auto-submit when all 6 digits entered
    if (code.length === 6) verifyEmailOTP(code);
  });

  verifyBtn.addEventListener('click', () => {
    const code = getOTPValue(inputs);
    if (code.length < 6) {
      showAlert(alertEl, 'Please enter all 6 digits.');
      return;
    }
    verifyEmailOTP(code);
  });

  // Numeric keypad
  document.querySelectorAll('#screen-email-otp .key-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.key;
      handleKeypadInput(inputs, val);
    });
  });

  // Resend
  resendBtn.addEventListener('click', async () => {
    resendBtn.disabled = true;
    clearOTPInputs(inputs);
    hideAlert(alertEl);

    const { data, error } = await apiCall('POST', '/api/resend-otp', {
      userId: state.userId, channel: 'email'
    });

    if (error) { showAlert(alertEl, error); resendBtn.disabled = false; return; }

    state.emailChallenge = data.challengeId;
    startEmailOTPTimer(data.expiresAt);
  });

  async function verifyEmailOTP(code) {
    hideAlert(alertEl);
    setButtonLoading(verifyBtn, true);

    const { data, error } = await apiCall('POST', '/api/verify-email-otp', {
      challengeId: state.emailChallenge,
      otp: code
    });

    setButtonLoading(verifyBtn, false);

    if (error) {
      markOTPError(inputs);
      showAlert(alertEl, error);
      if (data && data.expired) {
        timerEl.classList.add('expired');
        resendBtn.disabled = false;
      }
      return;
    }

    // Success — send SMS OTP and go to SMS screen
    clearOTPInputs(inputs);
    if (state.cancelTimer) state.cancelTimer();

    const { data: smsData, error: smsErr } = await apiCall('POST', '/api/send-sms-otp', {
      userId: state.userId
    });

    if (smsErr) { showAlert(alertEl, smsErr); return; }

    state.smsChallenge = smsData.challengeId;
    document.getElementById('sms-otp-target').textContent = '+91 ' + state.phone;
    showScreen('sms-otp');
    startSMSOTPTimer(smsData.expiresAt);
    document.querySelector('#screen-sms-otp .otp-input').focus();
  }

  window.startEmailOTPTimer = function(expiresAt) {
    if (state.cancelTimer) state.cancelTimer();
    const totalSec = Math.floor((new Date(expiresAt) - Date.now()) / 1000);

    // Resend countdown: allow resend after 30s
    let resendSec = 30;
    resendBtn.disabled = true;

    state.cancelTimer = startCountdown(totalSec,
      (rem) => {
        timerEl.textContent = `Code expires in `;
        const span = timerEl.querySelector('.timer-value') || (() => {
          const s = document.createElement('span');
          s.className = 'timer-value';
          timerEl.appendChild(s);
          return s;
        })();
        span.textContent = formatTimer(rem);

        resendSec--;
        if (resendSec <= 0) {
          resendBtn.disabled = false;
          resendCountEl.textContent = '';
        } else {
          resendCountEl.textContent = ` (${String(resendSec).padStart(2,'0')}:00)`.replace(':00','');
          resendCountEl.textContent = ` (00:${String(resendSec).padStart(2,'0')})`;
        }
      },
      () => { timerEl.classList.add('expired'); resendBtn.disabled = false; }
    );
  };
})();

// ============================================================
// SCREEN 3 — SMS OTP
// ============================================================
(function initSMSOTP() {
  const inputs    = document.querySelectorAll('#screen-sms-otp .otp-input');
  const verifyBtn = document.getElementById('sms-otp-verify-btn');
  const alertEl   = document.getElementById('sms-otp-alert');
  const resendBtn = document.getElementById('sms-resend-btn');
  const timerEl   = document.getElementById('sms-otp-timer');
  const resendCountEl = document.getElementById('sms-resend-count');

  initOTPInputs(inputs, (code) => {
    if (code.length === 6) verifySMSOTP(code);
  });

  verifyBtn.addEventListener('click', () => {
    const code = getOTPValue(inputs);
    if (code.length < 6) { showAlert(alertEl, 'Please enter all 6 digits.'); return; }
    verifySMSOTP(code);
  });

  document.querySelectorAll('#screen-sms-otp .key-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      handleKeypadInput(inputs, btn.dataset.key);
    });
  });

  resendBtn.addEventListener('click', async () => {
    resendBtn.disabled = true;
    clearOTPInputs(inputs);
    hideAlert(alertEl);

    const { data, error } = await apiCall('POST', '/api/resend-otp', {
      userId: state.userId, channel: 'sms'
    });
    if (error) { showAlert(alertEl, error); resendBtn.disabled = false; return; }
    state.smsChallenge = data.challengeId;
    startSMSOTPTimer(data.expiresAt);
  });

  async function verifySMSOTP(code) {
    hideAlert(alertEl);
    setButtonLoading(verifyBtn, true);

    const { data, error } = await apiCall('POST', '/api/verify-sms-otp', {
      challengeId: state.smsChallenge, otp: code
    });

    setButtonLoading(verifyBtn, false);

    if (error) {
      markOTPError(inputs);
      showAlert(alertEl, error);
      return;
    }

    clearOTPInputs(inputs);
    if (state.cancelTimer) state.cancelTimer();
    showScreen('mfa-setup');
  }

  window.startSMSOTPTimer = function(expiresAt) {
    if (state.cancelTimer) state.cancelTimer();
    const totalSec = Math.floor((new Date(expiresAt) - Date.now()) / 1000);
    let resendSec = 30;
    resendBtn.disabled = true;

    state.cancelTimer = startCountdown(totalSec,
      (rem) => {
        timerEl.innerHTML = `Code expires in <span class="timer-value">${formatTimer(rem)}</span>`;
        resendSec--;
        resendCountEl.textContent = resendSec > 0
          ? ` (00:${String(resendSec).padStart(2,'0')})`
          : '';
        if (resendSec <= 0) resendBtn.disabled = false;
      },
      () => { timerEl.classList.add('expired'); resendBtn.disabled = false; }
    );
  };
})();

// ============================================================
// SCREEN 4 — Set Up MFA
// ============================================================
(function initMFASetup() {
  const cards       = document.querySelectorAll('#screen-mfa-setup .mfa-method-card');
  const continueBtn = document.getElementById('mfa-setup-continue-btn');
  const alertEl     = document.getElementById('mfa-setup-alert');

  cards.forEach(card => {
    card.addEventListener('click', () => {
      cards.forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      state.mfaMethod = card.dataset.method;
    });
  });

  // Select first by default
  if (cards.length) { cards[0].classList.add('selected'); state.mfaMethod = cards[0].dataset.method; }

  continueBtn.addEventListener('click', async () => {
    if (!state.mfaMethod) { showAlert(alertEl, 'Please select an MFA method.'); return; }

    setButtonLoading(continueBtn, true);

    const { data, error } = await apiCall('POST', '/api/setup-mfa', {
      userId: state.userId, method: state.mfaMethod
    });

    setButtonLoading(continueBtn, false);

    if (error) { showAlert(alertEl, error); return; }

    if (state.mfaMethod === 'authenticator') {
      // Show QR code screen
      document.getElementById('qr-image').src = data.qrCode;
      document.getElementById('qr-setup-key').textContent = data.setupKey;
      showScreen('auth-setup');
    } else {
      // SMS / Email MFA — already enabled, go to success
      showScreen('success');
    }
  });
})();

// ============================================================
// SCREEN 5 — Authenticator Setup (QR code)
// ============================================================
(function initAuthSetup() {
  const continueBtn = document.getElementById('auth-setup-continue-btn');
  const alertEl     = document.getElementById('auth-setup-alert');

  continueBtn.addEventListener('click', () => {
    hideAlert(alertEl);
    showScreen('auth-verify');
    document.querySelector('#screen-auth-verify .otp-input').focus();
  });
})();

// ============================================================
// SCREEN 6 — Authenticator Code Verification
// ============================================================
(function initAuthVerify() {
  const inputs    = document.querySelectorAll('#screen-auth-verify .otp-input');
  const verifyBtn = document.getElementById('auth-verify-btn');
  const alertEl   = document.getElementById('auth-verify-alert');
  const timerEl   = document.getElementById('auth-verify-timer');

  initOTPInputs(inputs, (code) => {
    if (code.length === 6) verifyAuthCode(code);
  });

  // TOTP rotates every 30 seconds
  let totpRemaining = 30;
  setInterval(() => {
    totpRemaining--;
    if (totpRemaining <= 0) totpRemaining = 30;
    timerEl.innerHTML = `Code expires in <span class="timer-value">${formatTimer(totpRemaining)}</span>`;
  }, 1000);

  verifyBtn.addEventListener('click', () => {
    const code = getOTPValue(inputs);
    if (code.length < 6) { showAlert(alertEl, 'Please enter the 6-digit code.'); return; }
    verifyAuthCode(code);
  });

  document.querySelectorAll('#screen-auth-verify .key-btn').forEach(btn => {
    btn.addEventListener('click', () => handleKeypadInput(inputs, btn.dataset.key));
  });

  async function verifyAuthCode(code) {
    hideAlert(alertEl);
    setButtonLoading(verifyBtn, true);

    const { data, error } = await apiCall('POST', '/api/verify-mfa-setup', {
      userId: state.userId, code
    });

    setButtonLoading(verifyBtn, false);

    if (error) { markOTPError(inputs); showAlert(alertEl, error); return; }

    clearOTPInputs(inputs);
    showScreen('success');
  }
})();

// ============================================================
// SCREEN 7 — Success
// ============================================================
document.getElementById('go-to-login-btn')?.addEventListener('click', () => {
  window.location.href = '/login.html';
});

// ============================================================
// NUMERIC KEYPAD HELPER
// ============================================================
function handleKeypadInput(inputs, key) {
  inputs = Array.from(inputs);
  if (key === 'del') {
    // Backspace: clear last filled input
    for (let i = inputs.length - 1; i >= 0; i--) {
      if (inputs[i].value) {
        inputs[i].value = '';
        inputs[i].classList.remove('otp-filled', 'otp-error');
        inputs[i].focus();
        return;
      }
    }
  } else {
    // Enter digit in next empty input
    for (let i = 0; i < inputs.length; i++) {
      if (!inputs[i].value) {
        inputs[i].value = key;
        inputs[i].classList.add('otp-filled');
        if (i < inputs.length - 1) inputs[i + 1].focus();
        // Fire input event to trigger auto-submit check
        inputs[i].dispatchEvent(new Event('input'));
        return;
      }
    }
  }
}

// ============================================================
// SVG HELPERS
// ============================================================
function eyeOpenSVG() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
    <circle cx="12" cy="12" r="3"/>
  </svg>`;
}
function eyeClosedSVG() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/>
    <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/>
    <line x1="1" y1="1" x2="23" y2="23"/>
  </svg>`;
}
