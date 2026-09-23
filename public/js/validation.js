const passwordRules = [
  { id: 'length',    text: 'At least 8 characters',  test: p => p.length >= 8 },
  { id: 'uppercase', text: '1 uppercase letter',      test: p => /[A-Z]/.test(p) },
  { id: 'number',    text: '1 number',                test: p => /[0-9]/.test(p) },
  { id: 'special',   text: '1 special character',     test: p => /[^A-Za-z0-9]/.test(p) }
];

function checkPasswordRules(password) {
  return passwordRules.map(r => ({ id: r.id, text: r.text, met: r.test(password) }));
}

function isPasswordStrong(password) {
  return passwordRules.every(r => r.test(password));
}

function renderPasswordRules(container, password) {
  checkPasswordRules(password).forEach(({ id, met }) => {
    const el = container.querySelector(`[data-rule="${id}"]`);
    if (!el) return;
    el.classList.toggle('met', met);
    const icon = el.querySelector('.rule-icon');
    if (icon) {
      icon.innerHTML = met
        ? `<svg width="9" height="9" viewBox="0 0 9 9" fill="none"><path d="M1.5 4.5L3.5 6.5L7.5 2.5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`
        : '';
    }
  });
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function isValidPhone(phone) {
  return /^\+?[1-9]\d{8,14}$/.test(phone.replace(/[\s\-()]/g, ''));
}

function setFieldError(input, errEl, msg) {
  if (msg) {
    input.classList.add('error');
    errEl.textContent = msg;
    errEl.classList.add('visible');
  } else {
    input.classList.remove('error');
    errEl.textContent = '';
    errEl.classList.remove('visible');
  }
}

function clearAllErrors(form) {
  form.querySelectorAll('.field-input').forEach(i => i.classList.remove('error'));
  form.querySelectorAll('.field-error').forEach(e => { e.textContent = ''; e.classList.remove('visible'); });
  form.querySelectorAll('.phone-input').forEach(i => i.classList.remove('error'));
}

function showAlert(el, msg, type = 'error') {
  el.className = `alert alert-${type} visible`;
  el.querySelector('.alert-message').textContent = msg;
}

function hideAlert(el) {
  el.classList.remove('visible');
}

function initOTPInputs(inputs, onComplete) {
  inputs = Array.from(inputs);

  inputs.forEach((input, idx) => {
    input.addEventListener('keydown', e => {
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

    input.addEventListener('input', () => {
      const val = input.value.replace(/\D/g, '').slice(-1);
      input.value = val;
      if (val) {
        input.classList.add('otp-filled');
        input.classList.remove('otp-error');
        if (idx < inputs.length - 1) inputs[idx + 1].focus();
      } else {
        input.classList.remove('otp-filled');
      }
      const full = inputs.map(i => i.value).join('');
      if (full.length === 6 && onComplete) onComplete(full);
    });

    input.addEventListener('paste', e => {
      e.preventDefault();
      const digits = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '').slice(0, 6);
      digits.split('').forEach((d, i) => {
        if (inputs[i]) { inputs[i].value = d; inputs[i].classList.add('otp-filled'); }
      });
      const next = inputs.findIndex(i => !i.value);
      (next !== -1 ? inputs[next] : inputs[inputs.length - 1]).focus();
      const full = inputs.map(i => i.value).join('');
      if (full.length === 6 && onComplete) onComplete(full);
    });
  });
}

function markOTPError(inputs) {
  inputs = Array.from(inputs);
  for (let i = inputs.length - 1; i >= 0; i--) {
    if (inputs[i].value) {
      inputs[i].classList.add('otp-error');
      inputs[i].classList.remove('otp-filled');
      break;
    }
  }
}

function clearOTPInputs(inputs) {
  inputs = Array.from(inputs);
  inputs.forEach(i => { i.value = ''; i.classList.remove('otp-filled', 'otp-error'); });
  inputs[0].focus();
}

function getOTPValue(inputs) {
  return Array.from(inputs).map(i => i.value).join('');
}

function startCountdown(total, onTick, onExpire) {
  let rem = total;
  onTick(rem);
  const iv = setInterval(() => {
    rem--;
    onTick(rem);
    if (rem <= 0) { clearInterval(iv); if (onExpire) onExpire(); }
  }, 1000);
  return () => clearInterval(iv);
}

function formatTimer(secs) {
  const m = String(Math.floor(secs / 60)).padStart(2, '0');
  const s = String(Math.max(0, secs % 60)).padStart(2, '0');
  return `${m}:${s}`;
}

function setButtonLoading(btn, loading) {
  btn.classList.toggle('loading', loading);
  btn.disabled = loading;
}

async function apiCall(method, url, body) {
  try {
    const opts = { method, headers: { 'Content-Type': 'application/json' }, credentials: 'include' };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    const data = await res.json();
    if (!res.ok) return { data: null, error: data.error || 'Something went wrong.' };
    return { data, error: null };
  } catch {
    return { data: null, error: 'Network error. Please check your connection.' };
  }
}
