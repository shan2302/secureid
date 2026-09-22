/**
 * validation.js — Client-side form validation helpers
 *
 * Used by: register.js, login.js
 */

// ============================================================
// Password Strength Rules
// Each rule returns true if the password satisfies it.
// ============================================================
const passwordRules = [
  {
    id:    'length',
    text:  'At least 8 characters',
    test:  (p) => p.length >= 8
  },
  {
    id:    'uppercase',
    text:  '1 uppercase letter',
    test:  (p) => /[A-Z]/.test(p)
  },
  {
    id:    'number',
    text:  '1 number',
    test:  (p) => /[0-9]/.test(p)
  },
  {
    id:    'special',
    text:  '1 special character',
    test:  (p) => /[^A-Za-z0-9]/.test(p)
  }
];

/**
 * Check how many password rules are met.
 * Returns an array of { id, met } objects.
 */
function checkPasswordRules(password) {
  return passwordRules.map(rule => ({
    id:   rule.id,
    text: rule.text,
    met:  rule.test(password)
  }));
}

/**
 * Returns true if ALL password rules are met.
 */
function isPasswordStrong(password) {
  return passwordRules.every(rule => rule.test(password));
}

/**
 * Renders the password rules UI inside a container element.
 * Marks each rule as met (green) or unmet (gray).
 *
 * @param {HTMLElement} container - element with data-rule="<id>" children
 * @param {string}      password
 */
function renderPasswordRules(container, password) {
  const results = checkPasswordRules(password);
  results.forEach(({ id, met }) => {
    const ruleEl = container.querySelector(`[data-rule="${id}"]`);
    if (!ruleEl) return;

    const iconEl = ruleEl.querySelector('.rule-icon');
    ruleEl.classList.toggle('met', met);

    if (iconEl) {
      // Checkmark SVG when met, empty when not
      iconEl.innerHTML = met
        ? `<svg width="9" height="9" viewBox="0 0 9 9" fill="none">
             <path d="M1.5 4.5L3.5 6.5L7.5 2.5" stroke="white" stroke-width="1.5"
               stroke-linecap="round" stroke-linejoin="round"/>
           </svg>`
        : '';
    }
  });
}

// ============================================================
// Field-level validation helpers
// ============================================================

/**
 * Validate an email string.
 */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/**
 * Validate a phone number (digits only, 8–15 chars after stripping spaces/dashes).
 */
function isValidPhone(phone) {
  const stripped = phone.replace(/[\s\-()]/g, '');
  return /^\+?[1-9]\d{8,14}$/.test(stripped);
}

/**
 * Show or hide a field-level error message.
 *
 * @param {HTMLInputElement} inputEl
 * @param {HTMLElement}      errorEl
 * @param {string|null}      message  - null or '' to clear the error
 */
function setFieldError(inputEl, errorEl, message) {
  if (message) {
    inputEl.classList.add('error');
    errorEl.textContent = message;
    errorEl.classList.add('visible');
  } else {
    inputEl.classList.remove('error');
    errorEl.textContent = '';
    errorEl.classList.remove('visible');
  }
}

/**
 * Clear all field errors in a form.
 */
function clearAllErrors(formEl) {
  formEl.querySelectorAll('.field-input').forEach(i => i.classList.remove('error'));
  formEl.querySelectorAll('.field-error').forEach(e => {
    e.textContent = '';
    e.classList.remove('visible');
  });
  formEl.querySelectorAll('.phone-input').forEach(i => i.classList.remove('error'));
}

/**
 * Show the global alert banner.
 */
function showAlert(alertEl, message, type = 'error') {
  alertEl.className = `alert alert-${type} visible`;
  alertEl.querySelector('.alert-message').textContent = message;
}

/**
 * Hide the global alert banner.
 */
function hideAlert(alertEl) {
  alertEl.classList.remove('visible');
}

// ============================================================
// OTP Input helpers
// ============================================================

/**
 * Initialise 6 OTP input boxes:
 *   - Auto-advance on digit entry
 *   - Backspace moves focus back
 *   - Paste fills all boxes
 *
 * @param {NodeList|Array} inputs - the 6 input elements
 * @param {function}       onComplete - called with the full 6-digit string when complete
 */
function initOTPInputs(inputs, onComplete) {
  inputs = Array.from(inputs);

  inputs.forEach((input, idx) => {
    // Only allow digits
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace') {
        if (input.value) {
          input.value = '';
          input.classList.remove('otp-filled', 'otp-error');
        } else if (idx > 0) {
          inputs[idx - 1].focus();
          inputs[idx - 1].value = '';
          inputs[idx - 1].classList.remove('otp-filled', 'otp-error');
        }
        e.preventDefault();
      }
    });

    input.addEventListener('input', (e) => {
      // Keep only the last character entered (handles autofill)
      const val = input.value.replace(/\D/g, '').slice(-1);
      input.value = val;

      if (val) {
        input.classList.add('otp-filled');
        input.classList.remove('otp-error');
        if (idx < inputs.length - 1) inputs[idx + 1].focus();
      } else {
        input.classList.remove('otp-filled');
      }

      // Check if all filled
      const full = inputs.map(i => i.value).join('');
      if (full.length === 6 && onComplete) onComplete(full);
    });

    // Handle paste
    input.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text');
      const digits = text.replace(/\D/g, '').slice(0, 6);
      digits.split('').forEach((d, i) => {
        if (inputs[i]) {
          inputs[i].value = d;
          inputs[i].classList.add('otp-filled');
        }
      });
      const nextEmpty = inputs.findIndex(i => !i.value);
      if (nextEmpty !== -1) inputs[nextEmpty].focus();
      else inputs[inputs.length - 1].focus();

      const full = inputs.map(i => i.value).join('');
      if (full.length === 6 && onComplete) onComplete(full);
    });
  });
}

/**
 * Mark OTP inputs as error state (last entered box turns red).
 */
function markOTPError(inputs) {
  inputs = Array.from(inputs);
  // Find the last filled box and mark it red
  for (let i = inputs.length - 1; i >= 0; i--) {
    if (inputs[i].value) {
      inputs[i].classList.add('otp-error');
      inputs[i].classList.remove('otp-filled');
      break;
    }
  }
}

/**
 * Clear all OTP inputs and focus the first one.
 */
function clearOTPInputs(inputs) {
  inputs = Array.from(inputs);
  inputs.forEach(i => {
    i.value = '';
    i.classList.remove('otp-filled', 'otp-error');
  });
  inputs[0].focus();
}

/**
 * Get the current OTP value from the inputs.
 */
function getOTPValue(inputs) {
  return Array.from(inputs).map(i => i.value).join('');
}

// ============================================================
// OTP Countdown Timer
// ============================================================

/**
 * Start a countdown timer.
 *
 * @param {number}      totalSeconds - how long to count down
 * @param {function}    onTick       - called every second with (remaining)
 * @param {function}    onExpire     - called when timer reaches 0
 * @returns {function}  cancel — call to stop the timer early
 */
function startCountdown(totalSeconds, onTick, onExpire) {
  let remaining = totalSeconds;
  onTick(remaining); // fire immediately

  const interval = setInterval(() => {
    remaining--;
    onTick(remaining);
    if (remaining <= 0) {
      clearInterval(interval);
      if (onExpire) onExpire();
    }
  }, 1000);

  return () => clearInterval(interval); // return cancel function
}

/**
 * Format seconds as MM:SS
 */
function formatTimer(seconds) {
  const m = String(Math.floor(seconds / 60)).padStart(2, '0');
  const s = String(Math.max(0, seconds % 60)).padStart(2, '0');
  return `${m}:${s}`;
}

// ============================================================
// Button loading state helpers
// ============================================================
function setButtonLoading(btn, loading) {
  if (loading) {
    btn.classList.add('loading');
    btn.disabled = true;
  } else {
    btn.classList.remove('loading');
    btn.disabled = false;
  }
}

// ============================================================
// API helper
// ============================================================

/**
 * Make a JSON API call. Returns { data, error }.
 */
async function apiCall(method, url, body) {
  try {
    const options = {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'  // send cookies
    };
    if (body) options.body = JSON.stringify(body);

    const res = await fetch(url, options);
    const data = await res.json();

    if (!res.ok) return { data: null, error: data.error || 'Something went wrong.' };
    return { data, error: null };

  } catch (err) {
    return { data: null, error: 'Network error. Please check your connection.' };
  }
}
