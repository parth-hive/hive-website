const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Bot checks for public form submissions, layered on top of the per-IP rate
// limiters in routes/public.js (which distributed bots bypass by rotating IPs):
//
//  1. Honeypot — a visually hidden "company_website" field humans never see.
//     Autofill bots populate it; any value marks the submission as spam.
//  2. Signed timestamp — each rendered form embeds an HMAC-signed mint time.
//     Rejects direct POSTs that never loaded the page (no/forged token) and
//     scripted submits faster than a human can type (< MIN_FILL_MS).
//  3. Cloudflare Turnstile (optional) — an invisible CAPTCHA, enabled by
//     setting TURNSTILE_SITE_KEY + TURNSTILE_SECRET_KEY. Until the keys are
//     set, this layer is skipped and nothing changes for visitors.
//
// All state is inside the token itself, so this works on Vercel serverless
// with no shared storage.
// ---------------------------------------------------------------------------

// Falls back to the session secret so no new env var is required; set
// FORM_TOKEN_SECRET to rotate the form tokens independently of sessions.
const TOKEN_SECRET = process.env.FORM_TOKEN_SECRET
  || process.env.SESSION_SECRET
  || 'hive-dev-secret-change-in-production';

const MIN_FILL_MS = 3 * 1000;            // faster than this = scripted
const MAX_AGE_MS = 12 * 60 * 60 * 1000;  // older than this = stale page, ask to resubmit

const HONEYPOT_FIELD = 'company_website';

const turnstileEnabled = () =>
  !!(process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY);

function sign(ts) {
  return crypto.createHmac('sha256', TOKEN_SECRET).update(String(ts)).digest('hex');
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// Embedded in each form as <input type="hidden" name="form_ts">.
function mintFormToken() {
  const ts = Date.now();
  return `${ts}.${sign(ts)}`;
}

async function verifyTurnstile(token, ip) {
  if (!token) return false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: process.env.TURNSTILE_SECRET_KEY,
        response: token,
        remoteip: ip
      })
    });
    const data = await res.json();
    return data.success === true;
  } catch (err) {
    // Fail open: a Cloudflare outage must not block real inquiries. The
    // honeypot, timestamp and rate-limit layers still apply.
    console.error('[formGuard] Turnstile verification unavailable, allowing:', err.message);
    return true;
  }
}

// Runs every bot check against a submitted form. Returns one of:
//   { verdict: 'ok' }                       — let the submission through
//   { verdict: 'spam', reason }             — drop silently (render fake success
//                                             so bots can't learn what tripped)
//   { verdict: 'retry', message }           — likely human, ask to resubmit
async function checkFormGuards(req) {
  const body = req.body || {};

  if (typeof body[HONEYPOT_FIELD] === 'string' && body[HONEYPOT_FIELD].trim() !== '') {
    return { verdict: 'spam', reason: 'honeypot filled' };
  }

  const [tsStr, sig] = String(body.form_ts || '').split('.');
  const ts = parseInt(tsStr, 10);
  if (!tsStr || !sig || !Number.isFinite(ts) || !timingSafeEqual(sig, sign(ts))) {
    return { verdict: 'spam', reason: 'missing or forged form token' };
  }

  const age = Date.now() - ts;
  if (age < MIN_FILL_MS) {
    return { verdict: 'spam', reason: `submitted ${age}ms after page load` };
  }
  if (age > MAX_AGE_MS) {
    return {
      verdict: 'retry',
      message: 'This page had been open for a while, so we could not accept the submission. Please refresh the page and submit again.'
    };
  }

  if (turnstileEnabled()) {
    const human = await verifyTurnstile(body['cf-turnstile-response'], req.ip);
    if (!human) {
      return {
        verdict: 'retry',
        message: 'We could not verify your submission. Please complete the verification below and try again.'
      };
    }
  }

  return { verdict: 'ok' };
}

module.exports = { mintFormToken, checkFormGuards, turnstileEnabled, HONEYPOT_FIELD };
