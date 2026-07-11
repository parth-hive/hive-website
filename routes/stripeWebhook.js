const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { sendMail, NOTIFY_EMAIL } = require('../utils/mailer');

// Stripe webhook receiver — currently handles Stripe Identity verification
// outcomes for the paid tenant application. Document checks are asynchronous
// (they can finish minutes after the applicant leaves the hosted flow), so the
// webhook is the source of truth for the final verification status.
//
// IMPORTANT: this router is mounted in server.js BEFORE express.json() /
// express.urlencoded(), because Stripe signature verification needs the raw,
// unparsed request body.
const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

// Applies the verification outcome to the matching application row and
// returns it (or null when no row matches / status unchanged).
async function updateIdentityStatus(sessionId, status, { verified = false, lastError = null } = {}) {
  const { rows } = await pool.query(
    `UPDATE tenant_applications
        SET identity_status = $2,
            identity_verified_at = CASE WHEN $3 THEN NOW() ELSE identity_verified_at END,
            identity_last_error = $4
      WHERE identity_session_id = $1 AND identity_status <> $2
      RETURNING id, full_name, email`,
    [sessionId, status, verified, lastError]
  );
  return rows[0] || null;
}

router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    console.warn('[stripe-webhook] Received event but STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET is not configured.');
    return res.status(503).send('Webhook not configured');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[stripe-webhook] Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'identity.verification_session.verified': {
        const session = event.data.object;
        const app = await updateIdentityStatus(session.id, 'verified', { verified: true });
        if (app) {
          // Best-effort heads-up to the master inbox; the row is already updated.
          try {
            await sendMail({
              to: NOTIFY_EMAIL,
              subject: `Identity VERIFIED — Hive Application #${app.id}: ${app.full_name}`,
              html: `
                <h2>Identity Verification Passed</h2>
                <p style="line-height:1.6;color:#444;">Stripe Identity verified the government ID for application #${app.id} (${app.full_name}, ${app.email}).</p>
                <p style="line-height:1.6;color:#444;">Full results are in the Stripe Dashboard under Identity &rarr; session <code>${session.id}</code>.</p>`
            });
          } catch (mailErr) {
            console.error('[mail] Failed to send identity-verified notification:', mailErr.message);
          }
        }
        break;
      }

      case 'identity.verification_session.requires_input': {
        const session = event.data.object;
        const reason = (session.last_error && session.last_error.reason) || 'Verification could not be completed.';
        const app = await updateIdentityStatus(session.id, 'requires_input', { lastError: reason });
        if (app) {
          try {
            await sendMail({
              to: NOTIFY_EMAIL,
              subject: `Identity check FAILED — Hive Application #${app.id}: ${app.full_name}`,
              html: `
                <h2>Identity Verification Needs Attention</h2>
                <p style="line-height:1.6;color:#444;">Stripe Identity could not verify application #${app.id} (${app.full_name}, ${app.email}).</p>
                <p style="line-height:1.6;color:#444;"><strong>Reason:</strong> ${reason}</p>
                <p style="line-height:1.6;color:#444;">The applicant can retry from their confirmation page. Details: Stripe Dashboard &rarr; Identity &rarr; session <code>${session.id}</code>.</p>`
            });
          } catch (mailErr) {
            console.error('[mail] Failed to send identity-failed notification:', mailErr.message);
          }
        }
        break;
      }

      case 'identity.verification_session.processing': {
        await updateIdentityStatus(event.data.object.id, 'processing');
        break;
      }

      case 'identity.verification_session.canceled': {
        await updateIdentityStatus(event.data.object.id, 'canceled');
        break;
      }

      default:
        // Not an event we act on — acknowledge so Stripe stops retrying.
        break;
    }

    res.json({ received: true });
  } catch (err) {
    // 500 makes Stripe retry with backoff, so transient DB errors self-heal.
    console.error(`[stripe-webhook] Error handling ${event.type}:`, err.message);
    res.status(500).send('Webhook handler error');
  }
});

module.exports = router;
