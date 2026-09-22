/**
 * SecureID — Backend API
 * Node.js + Express server
 *
 * Authentication flow:
 *   Registration: /api/register → /api/verify-email-otp → /api/send-sms-otp
 *                 → /api/verify-sms-otp → /api/setup-mfa → /api/verify-mfa-setup
 *   Login:        /api/login → /api/verify-login-otp → session + JWT issued
 *   Protected:    GET /api/me (requires session or JWT cookie)
 *   JWT demo:     POST /api/token → GET /api/protected (requires Bearer token)
 *   Logout:       POST /api/logout → session destroyed, cookies cleared
 */

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

// ================================================================
// CONFIGURATION
// ================================================================
const PORT             = process.env.PORT || 3000;
const JWT_SECRET       = process.env.JWT_SECRET       || 'secureid-jwt-secret-CHANGE-IN-PRODUCTION';
const SESSION_SECRET   = process.env.SESSION_SECRET   || 'secureid-session-secret-CHANGE-IN-PRODUCTION';
const APP_NAME         = process.env.APP_NAME         || 'SecureID';
const IS_PRODUCTION    = process.env.NODE_ENV === 'production';

const OTP_EXPIRY_MINUTES = 5;   // OTP valid for 5 minutes
const OTP_MAX_ATTEMPTS   = 3;   // 3 wrong attempts before lockout
const MAX_LOGIN_ATTEMPTS = 5;   // 5 wrong passwords before account lock
const LOCKOUT_MINUTES    = 15;  // Lock account for 15 minutes
const SALT_ROUNDS        = 12;  // bcrypt cost factor

// ================================================================
// IN-MEMORY STORES
// (In production, replace with a real database like PostgreSQL/MongoDB)
// ================================================================

/** userId -> user object */
const users = new Map();

/**
 * challengeId -> challenge object
 * {
 *   challengeId, userId, channel, otpHash,
 *   expiresAt, attempts, used
 * }
 */
const challenges = new Map();

/** Set of JWT strings that have been explicitly revoked (logout) */
const revokedTokens = new Set();

// ================================================================
// MIDDLEWARE
// ================================================================
app.use(express.json());
app.use(cookieParser());

// Serve frontend static files
app.use(express.static(path.join(__dirname, '../public')));

// CORS — allow requests from the frontend origin with credentials
app.use(cors({
  origin: process.env.FRONTEND_URL || `http://localhost:${PORT}`,
  credentials: true
}));

// Session middleware
// The session ID is stored in an httpOnly cookie named 'secureid.sid'
app.use(session({
  secret:            SESSION_SECRET,
  resave:            false,
  saveUninitialized: false,
  name:              'secureid.sid',
  cookie: {
    httpOnly: true,                                   // JS cannot read this cookie
    secure:   IS_PRODUCTION,                          // Only sent over HTTPS in production
    sameSite: IS_PRODUCTION ? 'strict' : 'lax',      // CSRF protection
    maxAge:   24 * 60 * 60 * 1000                    // 24 hours
  }
}));

// ================================================================
// UTILITY FUNCTIONS
// ================================================================

/**
 * Generate a cryptographically secure 6-digit OTP.
 * We use crypto.randomInt (not Math.random) for security.
 */
function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

/**
 * Create and store an OTP challenge.
 * The raw OTP is hashed with bcrypt before storage.
 *
 * @param {string} userId
 * @param {string} channel - 'email' | 'sms' | 'email-login' | 'sms-login' | 'totp-login'
 * @param {string} otpPlain - the plain-text OTP to hash and store
 * @returns {{ challengeId: string, expiresAt: Date }}
 */
async function createChallenge(userId, channel, otpPlain) {
  const challengeId = uuidv4();
  // Hash the OTP — we store only the hash, not the plain text
  const otpHash  = await bcrypt.hash(otpPlain, SALT_ROUNDS);
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

  challenges.set(challengeId, {
    challengeId,
    userId,
    channel,
    otpHash,
    expiresAt,
    attempts: 0,
    used:     false
  });

  // Auto-remove after expiry + 1 min grace
  setTimeout(() => challenges.delete(challengeId),
    (OTP_EXPIRY_MINUTES + 1) * 60 * 1000);

  return { challengeId, expiresAt };
}

/**
 * Simulate OTP delivery by printing to server console.
 * In production this would call an email/SMS provider.
 */
function simulateDelivery(channel, recipient, otp) {
  const line = '='.repeat(55);
  console.log('\n' + line);
  console.log(`[SIMULATED ${channel.toUpperCase()} — DEV MODE]`);
  console.log(`To:    ${recipient}`);
  console.log(`OTP:   ${otp}`);
  console.log(`Valid: ${OTP_EXPIRY_MINUTES} minutes`);
  console.log(line + '\n');
}

/**
 * Verify an OTP challenge.
 * Returns { ok: true } or { ok: false, error, expired?, maxAttemptsReached? }
 */
async function verifyChallenge(challengeId, otp) {
  const challenge = challenges.get(challengeId);

  if (!challenge)            return { ok: false, error: 'Challenge not found or expired.' };
  if (challenge.used)        return { ok: false, error: 'This code has already been used.' };
  if (new Date() > new Date(challenge.expiresAt)) {
    return { ok: false, error: 'This code has expired.', expired: true };
  }
  if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
    return { ok: false, error: 'Maximum attempts reached. Please request a new code.', maxAttemptsReached: true };
  }

  const valid = await bcrypt.compare(otp, challenge.otpHash);
  if (!valid) {
    challenge.attempts++;
    const left = OTP_MAX_ATTEMPTS - challenge.attempts;
    if (left <= 0) {
      return { ok: false,
        error: 'Maximum attempts reached. Please request a new code.',
        maxAttemptsReached: true };
    }
    return { ok: false,
      error: `Incorrect code. Please try again. You have ${left} attempt${left !== 1 ? 's' : ''} left.`,
      attemptsLeft: left };
  }

  // Valid — invalidate immediately (single-use)
  challenge.used = true;
  return { ok: true, challenge };
}

/**
 * Extract Bearer token from Authorization header
 */
function extractBearerToken(req) {
  const h = req.headers['authorization'];
  return (h && h.startsWith('Bearer ')) ? h.slice(7) : null;
}

/**
 * Authentication middleware.
 * Accepts either a valid server-side session OR a valid JWT httpOnly cookie.
 */
function requireAuth(req, res, next) {
  // 1. Check session
  if (req.session && req.session.userId) {
    const user = users.get(req.session.userId);
    if (user) { req.user = user; return next(); }
  }

  // 2. Check JWT cookie (or Bearer header for /api/protected demo)
  const token = req.cookies['secureid.jwt'] || extractBearerToken(req);
  if (token) {
    if (revokedTokens.has(token)) {
      return res.status(401).json({ error: 'Token has been revoked. Please log in again.' });
    }
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = users.get(decoded.userId);
      if (user) { req.user = user; req.jwtToken = token; return next(); }
    } catch (_) { /* invalid/expired */ }
  }

  return res.status(401).json({ error: 'Authentication required. Please log in.' });
}

/**
 * Issue and set the JWT as an httpOnly cookie + return in response
 */
function issueJWT(res, user) {
  const token = jwt.sign(
    { userId: user.userId, email: user.email },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
  res.cookie('secureid.jwt', token, {
    httpOnly: true,
    secure:   IS_PRODUCTION,
    sameSite: IS_PRODUCTION ? 'strict' : 'lax',
    maxAge:   60 * 60 * 1000 // 1 hour
  });
  return token;
}

// ================================================================
// ROUTES — REGISTRATION
// ================================================================

/**
 * POST /api/register
 * Validate input, hash password, create user, send email OTP.
 */
app.post('/api/register', async (req, res) => {
  try {
    const { fullName, email, phone, password } = req.body;

    // --- Field validation ---
    const errors = {};
    if (!fullName || fullName.trim().length < 2)
      errors.fullName = 'Full name must be at least 2 characters.';

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      errors.email = 'Please enter a valid email address.';

    if (!phone || !/^\+?[1-9]\d{8,14}$/.test(phone.replace(/[\s\-()]/g, '')))
      errors.phone = 'Please enter a valid phone number.';

    if (!password || password.length < 8)
      errors.password = 'Password must be at least 8 characters.';
    else if (!/[A-Z]/.test(password))
      errors.password = 'Password must contain at least one uppercase letter.';
    else if (!/[0-9]/.test(password))
      errors.password = 'Password must contain at least one number.';
    else if (!/[^A-Za-z0-9]/.test(password))
      errors.password = 'Password must contain at least one special character.';

    if (Object.keys(errors).length > 0)
      return res.status(400).json({ error: 'Validation failed', errors });

    // --- Duplicate email check ---
    for (const [, u] of users) {
      if (u.email === email.toLowerCase().trim())
        return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    // --- Create user (not yet verified) ---
    const userId      = uuidv4();
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    users.set(userId, {
      userId,
      fullName:            fullName.trim(),
      email:               email.toLowerCase().trim(),
      phone:               phone.replace(/[\s\-()]/g, ''),
      passwordHash,
      emailVerified:       false,
      phoneVerified:       false,
      mfaEnabled:          false,
      mfaMethod:           null,
      totpSecret:          null,
      totpSecretPending:   null,
      loginAttempts:       0,
      lockedUntil:         null,
      registrationComplete: false,
      createdAt:           new Date().toISOString()
    });

    // --- Generate email OTP and create challenge ---
    const otp = generateOTP();
    const { challengeId, expiresAt } = await createChallenge(userId, 'email', otp);

    simulateDelivery('EMAIL', email, otp);

    return res.status(201).json({
      message:     'Account created. Please verify your email.',
      challengeId,
      expiresAt,
      userId         // frontend needs this for subsequent steps
    });

  } catch (err) {
    console.error('POST /api/register error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * POST /api/verify-email-otp
 * Verify the 6-digit email OTP sent during registration.
 */
app.post('/api/verify-email-otp', async (req, res) => {
  try {
    const { challengeId, otp } = req.body;
    if (!challengeId || !otp)
      return res.status(400).json({ error: 'challengeId and otp are required.' });

    const result = await verifyChallenge(challengeId, otp);
    if (!result.ok)
      return res.status(400).json({ error: result.error, expired: result.expired,
        maxAttemptsReached: result.maxAttemptsReached, attemptsLeft: result.attemptsLeft });

    // Mark email as verified
    const user = users.get(result.challenge.userId);
    if (user) user.emailVerified = true;

    return res.json({ success: true, message: 'Email verified.', userId: result.challenge.userId });
  } catch (err) {
    console.error('POST /api/verify-email-otp error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * POST /api/send-sms-otp
 * Generate and (simulate) send an SMS OTP.
 */
app.post('/api/send-sms-otp', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required.' });

    const user = users.get(userId);
    if (!user)                return res.status(404).json({ error: 'User not found.' });
    if (!user.emailVerified)  return res.status(400).json({ error: 'Email must be verified first.' });

    const otp = generateOTP();
    const { challengeId, expiresAt } = await createChallenge(userId, 'sms', otp);

    simulateDelivery('SMS', user.phone, otp);

    return res.json({ message: 'SMS OTP sent.', challengeId, expiresAt });
  } catch (err) {
    console.error('POST /api/send-sms-otp error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * POST /api/verify-sms-otp
 * Verify the 6-digit SMS OTP.
 */
app.post('/api/verify-sms-otp', async (req, res) => {
  try {
    const { challengeId, otp } = req.body;
    if (!challengeId || !otp)
      return res.status(400).json({ error: 'challengeId and otp are required.' });

    const result = await verifyChallenge(challengeId, otp);
    if (!result.ok)
      return res.status(400).json({ error: result.error, expired: result.expired,
        maxAttemptsReached: result.maxAttemptsReached, attemptsLeft: result.attemptsLeft });

    const user = users.get(result.challenge.userId);
    if (user) user.phoneVerified = true;

    return res.json({ success: true, message: 'Mobile verified.', userId: result.challenge.userId });
  } catch (err) {
    console.error('POST /api/verify-sms-otp error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * POST /api/setup-mfa
 * Set the preferred MFA method.
 * - 'authenticator' → returns QR code + setup key
 * - 'sms' or 'email' → marks MFA enabled immediately
 */
app.post('/api/setup-mfa', async (req, res) => {
  try {
    const { userId, method } = req.body;
    if (!userId || !method)
      return res.status(400).json({ error: 'userId and method are required.' });

    const validMethods = ['authenticator', 'sms', 'email'];
    if (!validMethods.includes(method))
      return res.status(400).json({ error: 'Invalid MFA method.' });

    const user = users.get(userId);
    if (!user)                return res.status(404).json({ error: 'User not found.' });
    if (!user.emailVerified || !user.phoneVerified)
      return res.status(400).json({ error: 'Email and mobile must be verified first.' });

    if (method === 'authenticator') {
      // Generate a TOTP secret (stored pending until user scans and verifies)
      const secret    = authenticator.generateSecret();
      user.totpSecretPending = secret;

      const otpAuthUrl   = authenticator.keyuri(user.email, APP_NAME, secret);
      const qrCodeDataUrl = await QRCode.toDataURL(otpAuthUrl);

      return res.json({
        method:   'authenticator',
        qrCode:   qrCodeDataUrl,   // base64 PNG data URL
        setupKey: secret,          // manual entry key for the authenticator app
        message:  'Scan the QR code with your authenticator app, then enter the 6-digit code.'
      });

    } else {
      // SMS or Email MFA — already verified above; just enable
      user.mfaEnabled          = true;
      user.mfaMethod           = method;
      user.registrationComplete = true;

      return res.json({ success: true, mfaEnabled: true, mfaMethod: method,
        message: `MFA enabled via ${method}.` });
    }

  } catch (err) {
    console.error('POST /api/setup-mfa error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * POST /api/verify-mfa-setup
 * Confirm the TOTP code from the authenticator app to complete setup.
 */
app.post('/api/verify-mfa-setup', async (req, res) => {
  try {
    const { userId, code } = req.body;
    if (!userId || !code)
      return res.status(400).json({ error: 'userId and code are required.' });

    const user = users.get(userId);
    if (!user || !user.totpSecretPending)
      return res.status(404).json({ error: 'No pending authenticator setup found.' });

    const valid = authenticator.verify({ token: code, secret: user.totpSecretPending });
    if (!valid)
      return res.status(400).json({ error: 'Invalid code. Please try again.' });

    // Commit the secret
    user.totpSecret           = user.totpSecretPending;
    user.totpSecretPending    = null;
    user.mfaEnabled           = true;
    user.mfaMethod            = 'authenticator';
    user.registrationComplete  = true;

    return res.json({ success: true, message: 'Authenticator app configured successfully.' });
  } catch (err) {
    console.error('POST /api/verify-mfa-setup error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// ================================================================
// ROUTES — LOGIN
// ================================================================

/**
 * POST /api/login
 * Validate credentials, handle account lockout, initiate MFA if enabled.
 */
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password are required.' });

    // Find user
    let user = null;
    for (const [, u] of users) {
      if (u.email === email.toLowerCase().trim()) { user = u; break; }
    }

    // Account lockout check
    if (user && user.lockedUntil && new Date() < new Date(user.lockedUntil)) {
      const leftMs  = new Date(user.lockedUntil) - Date.now();
      const leftMin = Math.ceil(leftMs / 60000);
      return res.status(423).json({
        error: `Account temporarily locked. Please try again in ${leftMin} minute(s).`,
        lockedUntil: user.lockedUntil
      });
    }

    // If user not found, still run bcrypt to prevent timing attacks
    if (!user) {
      await bcrypt.compare(password, '$2a$12$invalidhashfortimingattackprevention000000000000000000000');
      return res.status(401).json({ error: 'Invalid email or password. Please try again.' });
    }

    const passwordValid = await bcrypt.compare(password, user.passwordHash);

    if (!passwordValid) {
      user.loginAttempts = (user.loginAttempts || 0) + 1;
      if (user.loginAttempts >= MAX_LOGIN_ATTEMPTS) {
        user.lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000).toISOString();
        return res.status(423).json({
          error: `Too many failed attempts. Account locked for ${LOCKOUT_MINUTES} minutes.` });
      }
      return res.status(401).json({ error: 'Invalid email or password. Please try again.' });
    }

    // Reset failed counter on successful password
    user.loginAttempts = 0;
    user.lockedUntil   = null;

    // --- MFA required ---
    if (user.mfaEnabled) {
      let challengeId, expiresAt, method;

      if (user.mfaMethod === 'authenticator') {
        // TOTP: no OTP to generate/send; create a login session placeholder
        method = 'authenticator';
        // We still use a challenge to tie the login attempt to the userId
        const dummy = generateOTP();
        const cr = await createChallenge(user.userId, 'totp-login', dummy);
        challengeId = cr.challengeId;
        expiresAt   = cr.expiresAt;

      } else if (user.mfaMethod === 'sms') {
        method = 'sms';
        const otp = generateOTP();
        const cr  = await createChallenge(user.userId, 'sms-login', otp);
        challengeId = cr.challengeId;
        expiresAt   = cr.expiresAt;
        simulateDelivery('SMS', user.phone, otp);

      } else {
        // email MFA
        method = 'email';
        const otp = generateOTP();
        const cr  = await createChallenge(user.userId, 'email-login', otp);
        challengeId = cr.challengeId;
        expiresAt   = cr.expiresAt;
        simulateDelivery('EMAIL', user.email, otp);
      }

      return res.json({ mfaRequired: true, method, challengeId, expiresAt,
        maskedEmail: user.email.replace(/(.{2}).+(@.+)/, '$1***$2'),
        maskedPhone: user.phone.slice(-4).padStart(user.phone.length, '*')
      });
    }

    // --- No MFA — create session + JWT immediately ---
    req.session.userId    = user.userId;
    req.session.createdAt = new Date().toISOString();
    issueJWT(res, user);

    return res.json({ success: true, message: 'Login successful.' });

  } catch (err) {
    console.error('POST /api/login error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * POST /api/verify-login-otp
 * Verify MFA code during login. On success: create session + JWT.
 */
app.post('/api/verify-login-otp', async (req, res) => {
  try {
    const { challengeId, otp } = req.body;
    if (!challengeId || !otp)
      return res.status(400).json({ error: 'challengeId and otp are required.' });

    const challenge = challenges.get(challengeId);
    if (!challenge) return res.status(404).json({ error: 'Challenge not found or expired.' });
    if (challenge.used) return res.status(400).json({ error: 'This code has already been used.' });

    const user = users.get(challenge.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    if (challenge.channel === 'totp-login') {
      // TOTP verification — check against the stored TOTP secret
      if (challenge.attempts >= OTP_MAX_ATTEMPTS)
        return res.status(400).json({ error: 'Maximum attempts reached.', maxAttemptsReached: true });

      const valid = authenticator.verify({ token: otp, secret: user.totpSecret });
      if (!valid) {
        challenge.attempts++;
        const left = OTP_MAX_ATTEMPTS - challenge.attempts;
        if (left <= 0)
          return res.status(400).json({ error: 'Maximum attempts reached.', maxAttemptsReached: true });
        return res.status(400).json({
          error: `Invalid code. Please try again. You have ${left} attempt${left !== 1 ? 's' : ''} left.`,
          attemptsLeft: left });
      }
      challenge.used = true;

    } else {
      // Email / SMS OTP verification
      const result = await verifyChallenge(challengeId, otp);
      if (!result.ok)
        return res.status(400).json({ error: result.error, expired: result.expired,
          maxAttemptsReached: result.maxAttemptsReached, attemptsLeft: result.attemptsLeft });
    }

    // Create authenticated session
    req.session.userId    = user.userId;
    req.session.createdAt = new Date().toISOString();
    issueJWT(res, user);

    return res.json({ success: true, message: 'Authentication successful.' });

  } catch (err) {
    console.error('POST /api/verify-login-otp error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// ================================================================
// ROUTES — RESEND OTP
// ================================================================

/**
 * POST /api/resend-otp
 * Generate a fresh OTP for any channel.
 */
app.post('/api/resend-otp', async (req, res) => {
  try {
    const { userId, channel } = req.body;
    if (!userId || !channel)
      return res.status(400).json({ error: 'userId and channel are required.' });

    const user = users.get(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const otp = generateOTP();
    const { challengeId, expiresAt } = await createChallenge(userId, channel, otp);
    const recipient = channel === 'sms' ? user.phone : user.email;
    simulateDelivery(channel.toUpperCase(), recipient, otp);

    return res.json({ message: `New OTP sent via ${channel}.`, challengeId, expiresAt });
  } catch (err) {
    console.error('POST /api/resend-otp error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// ================================================================
// ROUTES — SESSION + JWT
// ================================================================

/**
 * GET /api/me
 * Returns the authenticated user's safe profile.
 * Accepts session cookie OR JWT cookie.
 */
app.get('/api/me', requireAuth, (req, res) => {
  const u = req.user;
  return res.json({
    userId:     u.userId,
    fullName:   u.fullName,
    email:      u.email,
    phone:      u.phone,
    emailVerified:  u.emailVerified,
    phoneVerified:  u.phoneVerified,
    mfaEnabled:     u.mfaEnabled,
    mfaMethod:      u.mfaMethod,
    createdAt:      u.createdAt
    // passwordHash, totpSecret, otpHash — NEVER exposed
  });
});

/**
 * POST /api/logout
 * Revoke JWT, destroy session, clear cookies.
 */
app.post('/api/logout', (req, res) => {
  // Add current JWT to revoked set
  const token = req.cookies['secureid.jwt'] || extractBearerToken(req);
  if (token) {
    revokedTokens.add(token);
    // Remove from set after JWT would expire anyway
    setTimeout(() => revokedTokens.delete(token), 60 * 60 * 1000);
  }

  // Destroy server-side session
  req.session.destroy((err) => {
    if (err) console.error('Session destroy error:', err);
  });

  // Clear cookies
  res.clearCookie('secureid.jwt');
  res.clearCookie('secureid.sid');

  return res.json({ success: true, message: 'Logged out successfully.' });
});

/**
 * POST /api/token
 * Issue a short-lived JWT for programmatic API access.
 * Requires an existing authenticated session or cookie.
 */
app.post('/api/token', requireAuth, (req, res) => {
  const token = jwt.sign(
    { userId: req.user.userId, email: req.user.email, type: 'api-access' },
    JWT_SECRET,
    { expiresIn: '15m' }
  );
  return res.json({ token, expiresIn: 900, tokenType: 'Bearer' });
});

/**
 * GET /api/protected
 * A JWT-protected resource — requires Authorization: Bearer <token>.
 * Demonstrates JWT Bearer flow separately from the session cookie flow.
 */
app.get('/api/protected', (req, res) => {
  const token = extractBearerToken(req);
  if (!token)
    return res.status(401).json({ error: 'Authorization: Bearer <token> required.' });

  if (revokedTokens.has(token))
    return res.status(401).json({ error: 'Token has been revoked.' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user    = users.get(decoded.userId);
    if (!user) return res.status(401).json({ error: 'User not found.' });

    return res.json({
      message: 'Access granted to protected resource.',
      user:    { userId: user.userId, email: user.email, fullName: user.fullName },
      tokenInfo: {
        issuedAt:  new Date(decoded.iat * 1000).toISOString(),
        expiresAt: new Date(decoded.exp * 1000).toISOString()
      }
    });
  } catch (err) {
    if (err.name === 'TokenExpiredError')
      return res.status(401).json({ error: 'Token has expired.' });
    return res.status(401).json({ error: 'Invalid token.' });
  }
});

// ================================================================
// DEV-ONLY ROUTES — disabled in production
// ================================================================

/**
 * GET /api/dev/challenges
 * DEV ONLY — List active challenges.
 * The actual OTP values are in the server console, NOT returned here.
 * ⚠️ Must be disabled / removed before production.
 */
app.get('/api/dev/challenges', (req, res) => {
  if (IS_PRODUCTION) return res.status(404).json({ error: 'Not found.' });

  const active = [];
  for (const [id, ch] of challenges) {
    if (!ch.used && new Date() < new Date(ch.expiresAt)) {
      active.push({
        challengeId: id,
        channel:     ch.channel,
        expiresAt:   ch.expiresAt,
        attempts:    ch.attempts
        // otpHash NOT exposed — check server console for OTP value
      });
    }
  }
  return res.json({
    note:       '⚠️  DEV ONLY — OTP values are in the server console, not here.',
    challenges: active
  });
});

/**
 * GET /api/dev/users
 * DEV ONLY — List registered users (safe fields only).
 */
app.get('/api/dev/users', (req, res) => {
  if (IS_PRODUCTION) return res.status(404).json({ error: 'Not found.' });

  const list = [];
  for (const [, u] of users) {
    list.push({
      userId:              u.userId,
      fullName:            u.fullName,
      email:               u.email,
      phone:               u.phone,
      emailVerified:       u.emailVerified,
      phoneVerified:       u.phoneVerified,
      mfaEnabled:          u.mfaEnabled,
      mfaMethod:           u.mfaMethod,
      registrationComplete: u.registrationComplete,
      createdAt:           u.createdAt
    });
  }
  return res.json({ note: '⚠️  DEV ONLY', users: list });
});

// ================================================================
// START SERVER
// ================================================================
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n${'━'.repeat(55)}`);
    console.log(`  SecureID API  →  http://localhost:${PORT}`);
    console.log(`  Mode: ${IS_PRODUCTION ? 'PRODUCTION' : 'DEVELOPMENT'}`);
    console.log(`${'━'.repeat(55)}`);
    console.log('\n  Endpoints:');
    console.log('  POST /api/register');
    console.log('  POST /api/verify-email-otp');
    console.log('  POST /api/send-sms-otp');
    console.log('  POST /api/verify-sms-otp');
    console.log('  POST /api/setup-mfa');
    console.log('  POST /api/verify-mfa-setup');
    console.log('  POST /api/login');
    console.log('  POST /api/verify-login-otp');
    console.log('  GET  /api/me');
    console.log('  POST /api/logout');
    console.log('  POST /api/token');
    console.log('  GET  /api/protected');
    if (!IS_PRODUCTION) {
      console.log('  GET  /api/dev/challenges  [DEV ONLY]');
      console.log('  GET  /api/dev/users       [DEV ONLY]');
    }
    console.log(`\n  OTP values are printed to this console.\n`);
  });
}

module.exports = app;
