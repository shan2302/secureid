require('dotenv').config();

const express      = require('express');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const session      = require('express-session');
const cookieParser = require('cookie-parser');
const cors         = require('cors');
const crypto       = require('crypto');
const { authenticator } = require('otplib');
const QRCode       = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const path         = require('path');

const app = express();

const PORT           = process.env.PORT || 3000;
const JWT_SECRET     = process.env.JWT_SECRET     || 'secureid-jwt-secret-CHANGE-IN-PRODUCTION';
const SESSION_SECRET = process.env.SESSION_SECRET || 'secureid-session-secret-CHANGE-IN-PRODUCTION';
const APP_NAME       = process.env.APP_NAME       || 'SecureID';
const IS_PROD        = process.env.NODE_ENV === 'production';

const OTP_EXPIRY   = 5;
const OTP_ATTEMPTS = 3;
const MAX_LOGINS   = 5;
const LOCKOUT_MIN  = 15;
const SALT         = 12;

const users         = new Map();
const challenges    = new Map();
const revokedTokens = new Set();

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '../public')));

app.use(cors({
  origin: process.env.FRONTEND_URL || `http://localhost:${PORT}`,
  credentials: true
}));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'secureid.sid',
  cookie: {
    httpOnly: true,
    secure:   IS_PROD,
    sameSite: IS_PROD ? 'strict' : 'lax',
    maxAge:   24 * 60 * 60 * 1000
  }
}));

function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

async function createChallenge(userId, channel, otpPlain) {
  const id       = uuidv4();
  const hash     = await bcrypt.hash(otpPlain, SALT);
  const expiresAt = new Date(Date.now() + OTP_EXPIRY * 60 * 1000);

  challenges.set(id, { challengeId: id, userId, channel, otpHash: hash, expiresAt, attempts: 0, used: false });
  setTimeout(() => challenges.delete(id), (OTP_EXPIRY + 1) * 60 * 1000);

  return { challengeId: id, expiresAt };
}

function simulateDelivery(channel, recipient, otp) {
  const line = '='.repeat(55);
  console.log('\n' + line);
  console.log(`[SIMULATED ${channel.toUpperCase()} — DEV MODE]`);
  console.log(`To:    ${recipient}`);
  console.log(`OTP:   ${otp}`);
  console.log(`Valid: ${OTP_EXPIRY} minutes`);
  console.log(line + '\n');
}

async function verifyChallenge(challengeId, otp) {
  const ch = challenges.get(challengeId);
  if (!ch)        return { ok: false, error: 'Challenge not found or expired.' };
  if (ch.used)    return { ok: false, error: 'This code has already been used.' };
  if (new Date() > new Date(ch.expiresAt)) return { ok: false, error: 'This code has expired.', expired: true };
  if (ch.attempts >= OTP_ATTEMPTS) return { ok: false, error: 'Maximum attempts reached. Please request a new code.', maxAttemptsReached: true };

  const valid = await bcrypt.compare(otp, ch.otpHash);
  if (!valid) {
    ch.attempts++;
    const left = OTP_ATTEMPTS - ch.attempts;
    if (left <= 0) return { ok: false, error: 'Maximum attempts reached. Please request a new code.', maxAttemptsReached: true };
    return { ok: false, error: `Incorrect code. ${left} attempt${left !== 1 ? 's' : ''} left.`, attemptsLeft: left };
  }

  ch.used = true;
  return { ok: true, challenge: ch };
}

function extractBearer(req) {
  const h = req.headers['authorization'];
  return (h && h.startsWith('Bearer ')) ? h.slice(7) : null;
}

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    const user = users.get(req.session.userId);
    if (user) { req.user = user; return next(); }
  }

  const token = req.cookies['secureid.jwt'] || extractBearer(req);
  if (token) {
    if (revokedTokens.has(token)) return res.status(401).json({ error: 'Token has been revoked.' });
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user    = users.get(decoded.userId);
      if (user) { req.user = user; req.jwtToken = token; return next(); }
    } catch (_) {}
  }

  return res.status(401).json({ error: 'Authentication required. Please log in.' });
}

function issueJWT(res, user) {
  const token = jwt.sign({ userId: user.userId, email: user.email }, JWT_SECRET, { expiresIn: '1h' });
  res.cookie('secureid.jwt', token, {
    httpOnly: true,
    secure:   IS_PROD,
    sameSite: IS_PROD ? 'strict' : 'lax',
    maxAge:   60 * 60 * 1000
  });
  return token;
}

app.post('/api/register', async (req, res) => {
  try {
    const { fullName, email, phone, password } = req.body;

    const errors = {};
    if (!fullName || fullName.trim().length < 2) errors.fullName = 'Full name must be at least 2 characters.';
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Please enter a valid email address.';
    if (!phone || !/^\+?[1-9]\d{8,14}$/.test(phone.replace(/[\s\-()]/g, ''))) errors.phone = 'Please enter a valid phone number.';
    if (!password || password.length < 8) errors.password = 'Password must be at least 8 characters.';
    else if (!/[A-Z]/.test(password)) errors.password = 'Password must contain at least one uppercase letter.';
    else if (!/[0-9]/.test(password)) errors.password = 'Password must contain at least one number.';
    else if (!/[^A-Za-z0-9]/.test(password)) errors.password = 'Password must contain at least one special character.';

    if (Object.keys(errors).length > 0) return res.status(400).json({ error: 'Validation failed', errors });

    for (const [, u] of users) {
      if (u.email === email.toLowerCase().trim()) return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const userId = uuidv4();
    const passwordHash = await bcrypt.hash(password, SALT);

    users.set(userId, {
      userId, fullName: fullName.trim(),
      email: email.toLowerCase().trim(),
      phone: phone.replace(/[\s\-()]/g, ''),
      passwordHash,
      emailVerified: false, phoneVerified: false,
      mfaEnabled: false, mfaMethod: null,
      totpSecret: null, totpSecretPending: null,
      loginAttempts: 0, lockedUntil: null,
      registrationComplete: false,
      createdAt: new Date().toISOString()
    });

    const otp = generateOTP();
    const { challengeId, expiresAt } = await createChallenge(userId, 'email', otp);
    simulateDelivery('EMAIL', email, otp);

    return res.status(201).json({ message: 'Account created. Please verify your email.', challengeId, expiresAt, userId });
  } catch (err) {
    console.error('POST /api/register error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

app.post('/api/verify-email-otp', async (req, res) => {
  try {
    const { challengeId, otp } = req.body;
    if (!challengeId || !otp) return res.status(400).json({ error: 'challengeId and otp are required.' });

    const result = await verifyChallenge(challengeId, otp);
    if (!result.ok) return res.status(400).json({ error: result.error, expired: result.expired, maxAttemptsReached: result.maxAttemptsReached, attemptsLeft: result.attemptsLeft });

    const user = users.get(result.challenge.userId);
    if (user) user.emailVerified = true;

    return res.json({ success: true, message: 'Email verified.', userId: result.challenge.userId });
  } catch (err) {
    console.error('POST /api/verify-email-otp error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

app.post('/api/send-sms-otp', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required.' });

    const user = users.get(userId);
    if (!user)               return res.status(404).json({ error: 'User not found.' });
    if (!user.emailVerified) return res.status(400).json({ error: 'Email must be verified first.' });

    const otp = generateOTP();
    const { challengeId, expiresAt } = await createChallenge(userId, 'sms', otp);
    simulateDelivery('SMS', user.phone, otp);

    return res.json({ message: 'SMS OTP sent.', challengeId, expiresAt });
  } catch (err) {
    console.error('POST /api/send-sms-otp error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

app.post('/api/verify-sms-otp', async (req, res) => {
  try {
    const { challengeId, otp } = req.body;
    if (!challengeId || !otp) return res.status(400).json({ error: 'challengeId and otp are required.' });

    const result = await verifyChallenge(challengeId, otp);
    if (!result.ok) return res.status(400).json({ error: result.error, expired: result.expired, maxAttemptsReached: result.maxAttemptsReached, attemptsLeft: result.attemptsLeft });

    const user = users.get(result.challenge.userId);
    if (user) user.phoneVerified = true;

    return res.json({ success: true, message: 'Mobile verified.', userId: result.challenge.userId });
  } catch (err) {
    console.error('POST /api/verify-sms-otp error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

app.post('/api/setup-mfa', async (req, res) => {
  try {
    const { userId, method } = req.body;
    if (!userId || !method) return res.status(400).json({ error: 'userId and method are required.' });
    if (!['authenticator', 'sms', 'email'].includes(method)) return res.status(400).json({ error: 'Invalid MFA method.' });

    const user = users.get(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (!user.emailVerified || !user.phoneVerified) return res.status(400).json({ error: 'Email and mobile must be verified first.' });

    if (method === 'authenticator') {
      const secret   = authenticator.generateSecret();
      user.totpSecretPending = secret;
      const otpUrl   = authenticator.keyuri(user.email, APP_NAME, secret);
      const qrCode   = await QRCode.toDataURL(otpUrl);
      return res.json({ method: 'authenticator', qrCode, setupKey: secret, message: 'Scan the QR code with your authenticator app.' });
    }

    user.mfaEnabled = true;
    user.mfaMethod  = method;
    user.registrationComplete = true;
    return res.json({ success: true, mfaEnabled: true, mfaMethod: method, message: `MFA enabled via ${method}.` });
  } catch (err) {
    console.error('POST /api/setup-mfa error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

app.post('/api/verify-mfa-setup', async (req, res) => {
  try {
    const { userId, code } = req.body;
    if (!userId || !code) return res.status(400).json({ error: 'userId and code are required.' });

    const user = users.get(userId);
    if (!user || !user.totpSecretPending) return res.status(404).json({ error: 'No pending authenticator setup found.' });

    const valid = authenticator.verify({ token: code, secret: user.totpSecretPending });
    if (!valid) return res.status(400).json({ error: 'Invalid code. Please try again.' });

    user.totpSecret          = user.totpSecretPending;
    user.totpSecretPending   = null;
    user.mfaEnabled          = true;
    user.mfaMethod           = 'authenticator';
    user.registrationComplete = true;

    return res.json({ success: true, message: 'Authenticator app configured successfully.' });
  } catch (err) {
    console.error('POST /api/verify-mfa-setup error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

    let user = null;
    for (const [, u] of users) {
      if (u.email === email.toLowerCase().trim()) { user = u; break; }
    }

    if (user && user.lockedUntil && new Date() < new Date(user.lockedUntil)) {
      const left = Math.ceil((new Date(user.lockedUntil) - Date.now()) / 60000);
      return res.status(423).json({ error: `Account temporarily locked. Try again in ${left} minute(s).`, lockedUntil: user.lockedUntil });
    }

    if (!user) {
      await bcrypt.compare(password, '$2a$12$invalidhashfortimingattackprevention000000000000000000000');
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      user.loginAttempts = (user.loginAttempts || 0) + 1;
      if (user.loginAttempts >= MAX_LOGINS) {
        user.lockedUntil = new Date(Date.now() + LOCKOUT_MIN * 60 * 1000).toISOString();
        return res.status(423).json({ error: `Too many failed attempts. Account locked for ${LOCKOUT_MIN} minutes.` });
      }
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    user.loginAttempts = 0;
    user.lockedUntil   = null;

    if (user.mfaEnabled) {
      let challengeId, expiresAt, method;

      if (user.mfaMethod === 'authenticator') {
        method = 'authenticator';
        const cr = await createChallenge(user.userId, 'totp-login', generateOTP());
        challengeId = cr.challengeId; expiresAt = cr.expiresAt;
      } else if (user.mfaMethod === 'sms') {
        method = 'sms';
        const otp = generateOTP();
        const cr  = await createChallenge(user.userId, 'sms-login', otp);
        challengeId = cr.challengeId; expiresAt = cr.expiresAt;
        simulateDelivery('SMS', user.phone, otp);
      } else {
        method = 'email';
        const otp = generateOTP();
        const cr  = await createChallenge(user.userId, 'email-login', otp);
        challengeId = cr.challengeId; expiresAt = cr.expiresAt;
        simulateDelivery('EMAIL', user.email, otp);
      }

      return res.json({
        mfaRequired: true, method, challengeId, expiresAt,
        maskedEmail: user.email.replace(/(.{2}).+(@.+)/, '$1***$2'),
        maskedPhone: user.phone.slice(-4).padStart(user.phone.length, '*')
      });
    }

    req.session.userId    = user.userId;
    req.session.createdAt = new Date().toISOString();
    issueJWT(res, user);
    return res.json({ success: true, message: 'Login successful.' });

  } catch (err) {
    console.error('POST /api/login error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

app.post('/api/verify-login-otp', async (req, res) => {
  try {
    const { challengeId, otp } = req.body;
    if (!challengeId || !otp) return res.status(400).json({ error: 'challengeId and otp are required.' });

    const ch = challenges.get(challengeId);
    if (!ch)      return res.status(404).json({ error: 'Challenge not found or expired.' });
    if (ch.used)  return res.status(400).json({ error: 'This code has already been used.' });

    const user = users.get(ch.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    if (ch.channel === 'totp-login') {
      if (ch.attempts >= OTP_ATTEMPTS) return res.status(400).json({ error: 'Maximum attempts reached.', maxAttemptsReached: true });
      const valid = authenticator.verify({ token: otp, secret: user.totpSecret });
      if (!valid) {
        ch.attempts++;
        const left = OTP_ATTEMPTS - ch.attempts;
        if (left <= 0) return res.status(400).json({ error: 'Maximum attempts reached.', maxAttemptsReached: true });
        return res.status(400).json({ error: `Invalid code. ${left} attempt${left !== 1 ? 's' : ''} left.`, attemptsLeft: left });
      }
      ch.used = true;
    } else {
      const result = await verifyChallenge(challengeId, otp);
      if (!result.ok) return res.status(400).json({ error: result.error, expired: result.expired, maxAttemptsReached: result.maxAttemptsReached, attemptsLeft: result.attemptsLeft });
    }

    req.session.userId    = user.userId;
    req.session.createdAt = new Date().toISOString();
    issueJWT(res, user);
    return res.json({ success: true, message: 'Authentication successful.' });

  } catch (err) {
    console.error('POST /api/verify-login-otp error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

app.post('/api/resend-otp', async (req, res) => {
  try {
    const { userId, channel } = req.body;
    if (!userId || !channel) return res.status(400).json({ error: 'userId and channel are required.' });

    const user = users.get(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const otp = generateOTP();
    const { challengeId, expiresAt } = await createChallenge(userId, channel, otp);
    simulateDelivery(channel.toUpperCase(), channel === 'sms' ? user.phone : user.email, otp);

    return res.json({ message: `New OTP sent via ${channel}.`, challengeId, expiresAt });
  } catch (err) {
    console.error('POST /api/resend-otp error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

app.get('/api/me', requireAuth, (req, res) => {
  const u = req.user;
  return res.json({
    userId: u.userId, fullName: u.fullName, email: u.email, phone: u.phone,
    emailVerified: u.emailVerified, phoneVerified: u.phoneVerified,
    mfaEnabled: u.mfaEnabled, mfaMethod: u.mfaMethod, createdAt: u.createdAt
  });
});

app.post('/api/logout', (req, res) => {
  const token = req.cookies['secureid.jwt'] || extractBearer(req);
  if (token) {
    revokedTokens.add(token);
    setTimeout(() => revokedTokens.delete(token), 60 * 60 * 1000);
  }
  req.session.destroy(err => { if (err) console.error('Session destroy error:', err); });
  res.clearCookie('secureid.jwt');
  res.clearCookie('secureid.sid');
  return res.json({ success: true, message: 'Logged out successfully.' });
});

app.post('/api/token', requireAuth, (req, res) => {
  const token = jwt.sign(
    { userId: req.user.userId, email: req.user.email, type: 'api-access' },
    JWT_SECRET, { expiresIn: '15m' }
  );
  return res.json({ token, expiresIn: 900, tokenType: 'Bearer' });
});

app.get('/api/protected', (req, res) => {
  const token = extractBearer(req);
  if (!token) return res.status(401).json({ error: 'Authorization: Bearer <token> required.' });
  if (revokedTokens.has(token)) return res.status(401).json({ error: 'Token has been revoked.' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user    = users.get(decoded.userId);
    if (!user) return res.status(401).json({ error: 'User not found.' });
    return res.json({
      message: 'Access granted to protected resource.',
      user: { userId: user.userId, email: user.email, fullName: user.fullName },
      tokenInfo: { issuedAt: new Date(decoded.iat * 1000).toISOString(), expiresAt: new Date(decoded.exp * 1000).toISOString() }
    });
  } catch (err) {
    return res.status(401).json({ error: err.name === 'TokenExpiredError' ? 'Token has expired.' : 'Invalid token.' });
  }
});

app.get('/api/dev/challenges', (req, res) => {
  if (IS_PROD) return res.status(404).json({ error: 'Not found.' });
  const active = [];
  for (const [id, ch] of challenges) {
    if (!ch.used && new Date() < new Date(ch.expiresAt))
      active.push({ challengeId: id, channel: ch.channel, expiresAt: ch.expiresAt, attempts: ch.attempts });
  }
  return res.json({ note: 'DEV ONLY — OTP values are in the server console.', challenges: active });
});

app.get('/api/dev/users', (req, res) => {
  if (IS_PROD) return res.status(404).json({ error: 'Not found.' });
  const list = [];
  for (const [, u] of users) {
    list.push({
      userId: u.userId, fullName: u.fullName, email: u.email, phone: u.phone,
      emailVerified: u.emailVerified, phoneVerified: u.phoneVerified,
      mfaEnabled: u.mfaEnabled, mfaMethod: u.mfaMethod,
      loginAttempts: u.loginAttempts, lockedUntil: u.lockedUntil,
      registrationComplete: u.registrationComplete, createdAt: u.createdAt
    });
  }
  return res.json({ count: list.length, users: list });
});

app.get('/api/health', (req, res) => {
  return res.json({ status: 'ok', uptime: process.uptime() });
});

if (!IS_PROD) {
  const banner = '━'.repeat(55);
  console.log(`\n${banner}\n  ${APP_NAME} API  →  http://localhost:${PORT}\n  Mode: DEVELOPMENT\n${banner}\n  OTP values are printed to this console.\n`);
  app.listen(PORT);
}

module.exports = app;
