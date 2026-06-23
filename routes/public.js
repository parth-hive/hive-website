const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { getGoogleReviews } = require('../utils/googleReviews');

// Stripe client for the paid tenant application. Null when no secret key is
// configured, so the apply-now page degrades gracefully instead of crashing.
const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;
const APPLICATION_FEE_CENTS = parseInt(process.env.APPLICATION_FEE_CENTS || '2000', 10);

// All outbound mail is sent from the Hive domain (verified in Resend).
const MAIL_FROM = process.env.MAIL_FROM || 'Hive <vineet.dutta@hiveny.com>';
// Master recipient for submitted inquiry/application details.
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'vineet.dutta@hiveny.com';

// Low-level mail send via the Resend HTTP API. Throws on failure so callers can
// log it; callers wrap this so a failed send never blocks saving the inquiry.
async function sendMail({ to, subject, html, replyTo }) {
  if (!to) return;
  if (!process.env.RESEND_API_KEY) {
    console.warn(`[mail] RESEND_API_KEY missing — "${subject}" to ${to} not sent.`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: [to],
      subject,
      html,
      reply_to: replyTo || undefined
    })
  });
  if (!res.ok) {
    throw new Error(`Resend ${res.status}: ${await res.text()}`);
  }
  console.log(`[mail] Sent "${subject}" to ${to}`);
}

// Branded wrapper for confirmation emails sent to the person who submitted a form.
function confirmationHtml(heading, bodyLines) {
  return `
    <div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a18;">
      <h2 style="color: #1a1a18;">${heading}</h2>
      ${bodyLines.map(l => `<p style="line-height: 1.6; color: #444;">${l}</p>`).join('')}
      <p style="line-height: 1.6; color: #444;">Warm regards,<br>Vineet Dutta<br>Hive · <a href="https://hiveny.com" style="color: #d4920b;">hiveny.com</a></p>
      <p style="margin-top: 20px; color: #888; font-size: 12px;">This is an automated confirmation from Hive. You can reply directly to this email to reach us.</p>
    </div>`;
}

router.get('/', async (req, res) => {
  try {
    // One listing per property: rooms in the same unit share title + city, so
    // DISTINCT ON (title, city) keeps a single room per property in featuring.
    const { rows: featuredListings } = await pool.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (lower(btrim(title)), city) *
         FROM listings
         WHERE featured = true AND status != 'rented'
         ORDER BY lower(btrim(title)), city, sort_order ASC
       ) t
       ORDER BY sort_order ASC LIMIT 6`
    );
    // Fallback: if no featured listings, get the most recent available ones
    let listings = featuredListings;
    if (listings.length === 0) {
      const result = await pool.query(
        `SELECT * FROM (
           SELECT DISTINCT ON (lower(btrim(title)), city) *
           FROM listings
           WHERE status != 'rented'
           ORDER BY lower(btrim(title)), city, created_at DESC
         ) t
         ORDER BY created_at DESC LIMIT 6`
      );
      listings = result.rows;
    }

    // Fetch Google reviews (cached, won't slow down page load)
    const googleReviews = await getGoogleReviews();

    res.render('public/index', { featuredListings: listings, googleReviews });
  } catch (err) {
    console.error('Error loading homepage:', err);
    res.render('public/index', { featuredListings: [], googleReviews: { reviews: [], rating: 0, totalReviews: 0 } });
  }
});

router.get('/properties', async (req, res) => {
  try {
    const { rows: listings } = await pool.query(
      `SELECT * FROM listings WHERE status != 'rented'
       ORDER BY sort_order ASC, created_at DESC`
    );
    // Convert deprecated Drive uc?export URLs to thumbnail format
    listings.forEach(l => { if (l.images) l.images = l.images.map(url => {
      const m = url && url.match(/drive\.google\.com\/(?:uc\?export=view&id=|thumbnail\?id=)([a-zA-Z0-9_-]+)/);
      return m ? `https://lh3.googleusercontent.com/d/${m[1]}=w2000` : url;
    }); });
    res.render('public/properties', { listings });
  } catch (err) {
    console.error('Error loading properties:', err);
    res.render('public/properties', { listings: [] });
  }
});

router.get('/properties/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^\d+$/.test(id)) {
      return res.redirect('/properties');
    }

    const { rows } = await pool.query('SELECT * FROM listings WHERE id = $1', [id]);
    if (rows.length === 0) {
      return res.redirect('/properties');
    }

    const listing = rows[0];

    // Fetch bookings for this listing (current and future only)
    const { rows: bookings } = await pool.query(
      `SELECT check_in, check_out FROM bookings
       WHERE listing_id = $1 AND check_out >= CURRENT_DATE
       ORDER BY check_in ASC`,
      [id]
    );

    // Fetch related listings (same neighborhood or city, excluding current)
    const { rows: relatedListings } = await pool.query(
      `SELECT * FROM listings
       WHERE id != $1 AND status != 'rented'
       AND (neighborhood = $2 OR city = $3)
       ORDER BY sort_order ASC
       LIMIT 3`,
      [id, listing.neighborhood, listing.city]
    );

    // Convert deprecated Drive uc?export URLs to thumbnail format
    const fixDriveUrl = (url) => {
      if (!url) return url;
      const m = url.match(/drive\.google\.com\/uc\?export=view&id=([a-zA-Z0-9_-]+)/);
      return m ? `https://drive.google.com/thumbnail?id=${m[1]}&sz=w2000` : url;
    };
    if (listing.images) listing.images = listing.images.map(fixDriveUrl);
    if (listing.floor_plan_image) listing.floor_plan_image = fixDriveUrl(listing.floor_plan_image);
    relatedListings.forEach(r => { if (r.images) r.images = r.images.map(fixDriveUrl); });

    res.render('public/listing-detail', { listing, relatedListings, bookings });
  } catch (err) {
    console.error('Error loading listing detail:', err);
    res.redirect('/properties');
  }
});

// Keep .html routes working for backwards compatibility
router.get('/properties.html', (req, res) => res.redirect('/properties'));
router.get('/partners.html', (req, res) => res.redirect('/partners'));

router.get('/partners', async (req, res) => {
  res.render('public/partners');
});

// Apply page
router.get('/apply', (req, res) => {
  res.render('public/apply', { success: false });
});

router.post('/apply', async (req, res) => {
  try {
    const { full_name, email, phone, about, social_media } = req.body;

    // Save to database
    await pool.query(
      `INSERT INTO applications (full_name, email, phone, about, social_media)
       VALUES ($1, $2, $3, $4, $5)`,
      [full_name, email, phone || null, about, social_media]
    );

    // Notify the master inbox with the submitted details (best-effort — already saved)
    try {
      await sendMail({
        to: NOTIFY_EMAIL,
        replyTo: email,
        subject: `New Hive Application: ${full_name}`,
        html: `
        <h2>New Tenant Application</h2>
        <table style="border-collapse: collapse; width: 100%; max-width: 600px;">
          <tr><td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold; width: 160px;">Name</td><td style="padding: 10px; border-bottom: 1px solid #eee;">${full_name}</td></tr>
          <tr><td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Email</td><td style="padding: 10px; border-bottom: 1px solid #eee;">${email}</td></tr>
          <tr><td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Phone</td><td style="padding: 10px; border-bottom: 1px solid #eee;">${phone || 'Not provided'}</td></tr>
          <tr><td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">About</td><td style="padding: 10px; border-bottom: 1px solid #eee;">${about}</td></tr>
          <tr><td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Social / LinkedIn</td><td style="padding: 10px; border-bottom: 1px solid #eee;">${social_media}</td></tr>
        </table>
        <p style="margin-top: 20px; color: #888; font-size: 12px;">Submitted via Hive Application Form</p>
      `
      });
    } catch (mailErr) {
      console.error('[mail] Failed to send application notification:', mailErr.message);
    }

    // Send a confirmation to the applicant (best-effort)
    try {
      await sendMail({
        to: email,
        subject: 'We received your Hive application',
        html: confirmationHtml(`Thanks for applying, ${full_name}!`, [
          'We have received your application and our team will review it shortly.',
          'If your profile is a good fit, we will reach out with available homes and next steps.',
          'In the meantime, feel free to browse our latest listings at <a href="https://hiveny.com/properties" style="color: #d4920b;">hiveny.com/properties</a>.'
        ])
      });
    } catch (mailErr) {
      console.error('[mail] Failed to send applicant confirmation:', mailErr.message);
    }

    res.render('public/apply', { success: true });
  } catch (err) {
    console.error('Application submission error:', err);
    // Still show success if DB saved but email failed
    res.render('public/apply', { success: true });
  }
});

// =====================================================================
// Paid tenant application ($20 fee via Stripe embedded Checkout)
// Flow: fill form -> POST /apply-now/session (saves a pending row, opens the
// embedded Checkout modal) -> pay -> Stripe returns to /apply-now/complete,
// which verifies payment, finalizes the application, and emails confirmations.
// =====================================================================

// Fields captured outside the free-form `answers` JSON (the final field list
// is TBD — every other posted field is stored in `answers` automatically).
const APPLICATION_BASE_FIELDS = ['full_name', 'email', 'phone'];

router.get('/apply-now', (req, res) => {
  res.render('public/apply-now', {
    feeCents: APPLICATION_FEE_CENTS,
    paymentsEnabled: !!stripe && !!res.app.locals.stripePublishableKey
  });
});

// Create a pending application + an embedded Checkout session.
router.post('/apply-now/session', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: 'Payments are not configured yet. Please try again later.' });
    }
    const body = req.body || {};
    const full_name = (body.full_name || '').trim();
    const email = (body.email || '').trim();
    const phone = (body.phone || '').trim();

    if (!full_name || !email) {
      return res.status(400).json({ error: 'Please provide your name and email.' });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'Please provide a valid email address.' });
    }

    // Everything that isn't a known base field is stored as a flexible answer.
    const answers = {};
    for (const [k, v] of Object.entries(body)) {
      if (!APPLICATION_BASE_FIELDS.includes(k)) answers[k] = v;
    }

    const { rows } = await pool.query(
      `INSERT INTO tenant_applications (full_name, email, phone, answers, amount_cents, payment_status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING id`,
      [full_name, email, phone || null, answers, APPLICATION_FEE_CENTS]
    );
    const appId = rows[0].id;

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const checkoutSession = await stripe.checkout.sessions.create({
      ui_mode: 'embedded',
      mode: 'payment',
      customer_email: email,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: APPLICATION_FEE_CENTS,
          product_data: {
            name: 'Hive Tenant Application Fee',
            description: 'Non-refundable application processing fee'
          }
        }
      }],
      metadata: { application_id: String(appId) },
      payment_intent_data: { metadata: { application_id: String(appId) } },
      return_url: `${baseUrl}/apply-now/complete?session_id={CHECKOUT_SESSION_ID}`
    });

    await pool.query(
      `UPDATE tenant_applications SET stripe_session_id = $1 WHERE id = $2`,
      [checkoutSession.id, appId]
    );

    res.json({ clientSecret: checkoutSession.client_secret });
  } catch (err) {
    console.error('Apply-now session error:', err);
    res.status(500).json({ error: 'Could not start payment. Please try again.' });
  }
});

// Stripe returns here after the embedded Checkout completes. Verify the
// payment, finalize the application (idempotently), and send emails once.
router.get('/apply-now/complete', async (req, res) => {
  const renderResult = (status, extra = {}) =>
    res.render('public/apply-now-complete', Object.assign({ status }, extra));

  try {
    if (!stripe) return renderResult('error');
    const sessionId = req.query.session_id;
    if (!sessionId) return res.redirect('/apply-now');

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== 'paid') {
      return renderResult('unpaid');
    }

    // Mark paid only if not already paid — the WHERE clause makes this idempotent,
    // so a page refresh won't re-send confirmation emails.
    const { rows } = await pool.query(
      `UPDATE tenant_applications
         SET payment_status = 'paid',
             paid_at = NOW(),
             stripe_payment_intent = $1
       WHERE stripe_session_id = $2 AND payment_status <> 'paid'
       RETURNING id, full_name, email, phone, answers`,
      [session.payment_intent || null, sessionId]
    );

    // Already finalized (refresh) — just show success without re-emailing.
    if (rows.length === 0) {
      return renderResult('paid');
    }

    const app = rows[0];

    // Notify the master inbox (best-effort).
    try {
      const answerRows = Object.entries(app.answers || {})
        .map(([k, v]) => `<tr><td style="padding:10px;border-bottom:1px solid #eee;font-weight:bold;width:160px;text-transform:capitalize;">${k.replace(/_/g, ' ')}</td><td style="padding:10px;border-bottom:1px solid #eee;">${Array.isArray(v) ? v.join(', ') : v}</td></tr>`)
        .join('');
      await sendMail({
        to: NOTIFY_EMAIL,
        replyTo: app.email,
        subject: `New PAID Hive Application: ${app.full_name}`,
        html: `
          <h2>New Tenant Application (Paid — $${(APPLICATION_FEE_CENTS / 100).toFixed(2)})</h2>
          <table style="border-collapse:collapse;width:100%;max-width:600px;">
            <tr><td style="padding:10px;border-bottom:1px solid #eee;font-weight:bold;width:160px;">Name</td><td style="padding:10px;border-bottom:1px solid #eee;">${app.full_name}</td></tr>
            <tr><td style="padding:10px;border-bottom:1px solid #eee;font-weight:bold;">Email</td><td style="padding:10px;border-bottom:1px solid #eee;">${app.email}</td></tr>
            <tr><td style="padding:10px;border-bottom:1px solid #eee;font-weight:bold;">Phone</td><td style="padding:10px;border-bottom:1px solid #eee;">${app.phone || 'Not provided'}</td></tr>
            ${answerRows}
          </table>
          <p style="margin-top:20px;color:#888;font-size:12px;">Payment confirmed via Stripe · Application #${app.id}</p>`
      });
    } catch (mailErr) {
      console.error('[mail] Failed to send paid-application notification:', mailErr.message);
    }

    // Confirmation to the applicant (best-effort).
    try {
      await sendMail({
        to: app.email,
        subject: 'We received your Hive application',
        html: confirmationHtml(`Thanks for applying, ${app.full_name}!`, [
          `We have received your application and your $${(APPLICATION_FEE_CENTS / 100).toFixed(2)} application fee.`,
          'Our team will review your application shortly and reach out with next steps.',
          'In the meantime, feel free to browse our latest listings at <a href="https://hiveny.com/properties" style="color: #d4920b;">hiveny.com/properties</a>.'
        ])
      });
    } catch (mailErr) {
      console.error('[mail] Failed to send applicant confirmation:', mailErr.message);
    }

    renderResult('paid');
  } catch (err) {
    console.error('Apply-now complete error:', err);
    renderResult('error');
  }
});

// Landlord inquiry form
router.get('/partners/apply', (req, res) => {
  res.render('public/landlord-apply', { success: false });
});

router.post('/partners/apply', async (req, res) => {
  try {
    const { full_name, email, phone, property_location, num_units, property_type, message, referral_source } = req.body;

    // Save to database
    await pool.query(
      `INSERT INTO landlord_inquiries (full_name, email, phone, property_location, num_units, property_type, message, referral_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [full_name, email, phone || null, property_location, num_units || null, property_type || null, message, referral_source || null]
    );

    // Notify the master inbox with the submitted details (best-effort — already saved)
    try {
      await sendMail({
        to: NOTIFY_EMAIL,
        replyTo: email,
        subject: `New Landlord Inquiry: ${full_name}`,
        html: `
        <h2>New Landlord Inquiry</h2>
        <table style="border-collapse: collapse; width: 100%; max-width: 600px;">
          <tr><td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold; width: 160px;">Name</td><td style="padding: 10px; border-bottom: 1px solid #eee;">${full_name}</td></tr>
          <tr><td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Email</td><td style="padding: 10px; border-bottom: 1px solid #eee;">${email}</td></tr>
          <tr><td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Phone</td><td style="padding: 10px; border-bottom: 1px solid #eee;">${phone || 'Not provided'}</td></tr>
          <tr><td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Property Location</td><td style="padding: 10px; border-bottom: 1px solid #eee;">${property_location}</td></tr>
          <tr><td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Number of Units</td><td style="padding: 10px; border-bottom: 1px solid #eee;">${num_units || 'Not provided'}</td></tr>
          <tr><td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Property Type</td><td style="padding: 10px; border-bottom: 1px solid #eee;">${property_type || 'Not provided'}</td></tr>
          <tr><td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Message</td><td style="padding: 10px; border-bottom: 1px solid #eee;">${message}</td></tr>
          <tr><td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Referral Source</td><td style="padding: 10px; border-bottom: 1px solid #eee;">${referral_source || 'Not provided'}</td></tr>
        </table>
        <p style="margin-top: 20px; color: #888; font-size: 12px;">Submitted via Hive Landlord Inquiry Form</p>
      `
      });
    } catch (mailErr) {
      console.error('[mail] Failed to send landlord inquiry notification:', mailErr.message);
    }

    // Send a confirmation to the landlord (best-effort)
    try {
      await sendMail({
        to: email,
        subject: 'Thanks for your interest in partnering with Hive',
        html: confirmationHtml(`Thank you, ${full_name}!`, [
          'We have received your inquiry about partnering with Hive and our team will be in touch soon.',
          'We will review the details you shared about your property and follow up with next steps.'
        ])
      });
    } catch (mailErr) {
      console.error('[mail] Failed to send landlord confirmation:', mailErr.message);
    }

    res.render('public/landlord-apply', { success: true });
  } catch (err) {
    console.error('Landlord inquiry submission error:', err);
    // Still show success if DB saved but email failed
    res.render('public/landlord-apply', { success: true });
  }
});

module.exports = router;
