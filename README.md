# SecureID — IAM Authentication & Registration

A complete Identity & Access Management (IAM) system with multi-factor authentication,
built with **HTML, CSS, JavaScript** (frontend) and **Node.js + Express** (backend).

---

## Features

- **Registration Journey**: Form → Email OTP → SMS OTP → MFA Setup → Success
- **Login Journey**: Credentials → Choose Method → OTP → Authenticated Dashboard
- **MFA**: Authenticator App (TOTP/QR), SMS, or Email
- **Password Strength**: Live indicator with 4 rules (length, uppercase, number, special char)
- **Password Show/Hide**: Eye icon toggle
- **OTP**: Cryptographically secure, hashed with bcrypt, single-use, 5-min expiry, 3-attempt limit
- **Session Auth**: httpOnly cookie (`secureid.sid`)
- **JWT Auth**: Short-lived JWT cookie + Bearer token for `/api/protected`
- **Logout**: Invalidates session + revokes JWT
- **Account Lockout**: 5 wrong passwords → 15-min lockout
- **`/api/me`**: Returns authenticated user profile (no secrets exposed)

---

## Technology

| Layer | Technology |
|---|---|
| Frontend | HTML5, CSS3, Vanilla JavaScript |
| Backend | Node.js, Express |
| Password hashing | bcryptjs |
| JWT | jsonwebtoken |
| Session | express-session |
| OTP | crypto.randomInt + bcryptjs |
| TOTP | otplib |
| QR Code | qrcode |
| Deployment | Vercel |

---

## Project Structure

```
secureid/
├── public/                # Frontend (served as static files)
│   ├── index.html         # Landing page
│   ├── register.html      # Registration journey (7 screens)
│   ├── login.html         # Login journey (3 screens)
│   ├── dashboard.html     # Authenticated dashboard
│   ├── css/
│   │   └── styles.css     # Complete design system
│   └── js/
│       ├── validation.js  # Shared helpers (OTP inputs, timers, password rules)
│       ├── register.js    # Registration flow controller
│       ├── login.js       # Login flow controller
│       └── auth.js        # Dashboard: /api/me, JWT demo, logout
├── api/
│   └── index.js           # Express backend — all routes
├── package.json
├── vercel.json            # Vercel deployment config
├── .env.example           # Environment variable template
├── .gitignore
└── README.md
```

---

## Local Setup

### 1. Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/secureid.git
cd secureid
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` and set:

```env
PORT=3000
NODE_ENV=development
JWT_SECRET=your-strong-random-64-char-secret
SESSION_SECRET=your-strong-random-32-char-secret
FRONTEND_URL=http://localhost:3000
APP_NAME=SecureID
```

Generate secrets with:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### 4. Run the server

```bash
# Development (with auto-reload)
npm run dev

# OR production
npm start
```

Server runs at: `http://localhost:3000`

> **OTP values are printed to the server console** — watch the terminal during testing.

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/register` | Register user, send email OTP |
| POST | `/api/verify-email-otp` | Verify email OTP |
| POST | `/api/send-sms-otp` | Send SMS OTP |
| POST | `/api/verify-sms-otp` | Verify SMS OTP |
| POST | `/api/setup-mfa` | Choose MFA method (authenticator/sms/email) |
| POST | `/api/verify-mfa-setup` | Verify TOTP code to complete authenticator setup |
| POST | `/api/resend-otp` | Resend OTP |
| POST | `/api/login` | Login, validate credentials |
| POST | `/api/verify-login-otp` | Verify MFA → create session + JWT |
| GET  | `/api/me` | Get authenticated user (session or JWT) |
| POST | `/api/logout` | Revoke JWT, destroy session, clear cookies |
| POST | `/api/token` | Issue short-lived JWT Bearer token |
| GET  | `/api/protected` | Protected resource (requires Bearer token) |
| GET  | `/api/dev/challenges` | **DEV ONLY** — list active OTP challenges |
| GET  | `/api/dev/users` | **DEV ONLY** — list registered users |

---

## Authentication Flow

### How tokens/sessions are created

```
Login + MFA verified
       ↓
POST /api/verify-login-otp
       ↓
Server creates:
  1. express-session → stores userId server-side
     Sets cookie: secureid.sid (httpOnly, SameSite, Secure in prod)
  2. jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: '1h' })
     Sets cookie: secureid.jwt (httpOnly)
```

### How they are stored
- **Session**: Server memory (Map). Client holds only the session ID in `secureid.sid` cookie.
- **JWT**: Client holds the token in `secureid.jwt` httpOnly cookie. **Not in localStorage.**

### How they are sent
- Every request sends both cookies automatically (browser handles this).
- `credentials: 'include'` in `fetch()` ensures cookies are sent cross-origin.

### How they are validated (`/api/me`)
```
GET /api/me
  → requireAuth middleware
  → Check req.session.userId → find user in store → attach to req.user
  OR
  → Check secureid.jwt cookie → jwt.verify(token, JWT_SECRET)
  → Decode userId → find user in store → attach to req.user
  → Return safe profile (NO passwordHash, NO totpSecret)
```

### How logout invalidates them
```
POST /api/logout
  → Add JWT to revokedTokens Set
  → req.session.destroy() — removes server-side session
  → res.clearCookie('secureid.jwt')
  → res.clearCookie('secureid.sid')
  → After logout: /api/me returns 401
```

---

## OTP Flow

```
1. Server generates OTP: crypto.randomInt(100000, 999999)
2. OTP is hashed: bcrypt.hash(otp, 12)
3. Challenge stored: { challengeId, userId, otpHash, expiresAt, attempts: 0 }
4. PLAIN OTP is printed to console (simulated delivery)
5. Only challengeId is returned to frontend
6. User enters OTP → frontend sends { challengeId, otp }
7. Server: bcrypt.compare(otp, challenge.otpHash)
8. If valid: challenge.used = true (single-use), proceed
9. If invalid: challenge.attempts++ (max 3), return error
10. If expired: return error with expired: true
```

---

## Password Strength Rules

All 4 must pass for registration:
- ✓ At least 8 characters
- ✓ 1 uppercase letter (A-Z)
- ✓ 1 number (0-9)
- ✓ 1 special character (!@#$...)

---

## Vercel Deployment

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit: SecureID IAM system"
git remote add origin https://github.com/YOUR_USERNAME/secureid.git
git push -u origin main
```

### 2. Deploy to Vercel

```bash
npx vercel --prod
```

OR connect the GitHub repo on [vercel.com](https://vercel.com).

### 3. Set environment variables in Vercel Dashboard

- `JWT_SECRET` = your production secret
- `SESSION_SECRET` = your production secret
- `NODE_ENV` = `production`
- `FRONTEND_URL` = `https://your-name-secureid.vercel.app`
- `APP_NAME` = `SecureID`

### 4. Target URL

```
https://your-name-secureid.vercel.app
```

> **Note**: The in-memory store resets on each Vercel cold start. For production,
> replace the `users` and `challenges` Maps with a real database (PostgreSQL, MongoDB, Redis).

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 3000) |
| `NODE_ENV` | Yes | `development` or `production` |
| `JWT_SECRET` | Yes | Secret for signing JWTs (min 32 chars) |
| `SESSION_SECRET` | Yes | Secret for signing session cookies |
| `FRONTEND_URL` | Yes | Frontend URL for CORS |
| `APP_NAME` | No | App name in TOTP QR codes (default: SecureID) |

---

## Security Notes

- Passwords hashed with **bcrypt** (12 salt rounds) — never stored in plain text
- OTPs hashed with **bcrypt** — raw OTP never stored
- JWT signed with `JWT_SECRET` from environment — never hard-coded
- httpOnly cookies — inaccessible to JavaScript (XSS protection)
- SameSite cookie attribute — CSRF protection
- Timing-attack prevention on login (bcrypt compare even for unknown users)
- Account lockout after 5 failed login attempts (15 min)
- Dev-only endpoints return 404 in production

---

## Test Credentials

> These are generated at runtime — register first, then check the server console for OTPs.
>
> There are no pre-seeded credentials (for security).

**Dev testing steps:**
1. Start server: `npm run dev`
2. Open `http://localhost:3000/register.html`
3. Fill in the form and submit
4. Check the **server console** for the email OTP
5. Enter OTP → check console for SMS OTP
6. Complete MFA setup
7. Login with your credentials

---

## GitHub Setup

```bash
# Initialize
git init
echo "node_modules/" >> .gitignore
echo ".env" >> .gitignore

# First commit
git add .
git commit -m "feat: SecureID IAM authentication system"

# Push
git remote add origin https://github.com/YOUR_USERNAME/secureid.git
git branch -M main
git push -u origin main
```

> ⚠️ **Never commit** `.env`, secrets, or `node_modules/`
