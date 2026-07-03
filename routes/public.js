const express = require('express');
const path = require('path');
const multer = require('multer');
const router = express.Router();
const pool = require('../db/pool');
const { getGoogleReviews } = require('../utils/googleReviews');
const { storePrivateFile, signedPrivateUrl } = require('../utils/storage');

// Stripe client for the paid tenant application. Null when no secret key is
// configured, so the apply-now page degrades gracefully instead of crashing.
const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;
const APPLICATION_FEE_CENTS = parseInt(process.env.APPLICATION_FEE_CENTS || '2000', 10);

// Photo-ID uploads kept in memory, then pushed to the PRIVATE bucket. Accepts
// images + PDF, 10 MB max per file.
const idUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp|pdf/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    if (ext || mime) return cb(null, true);
    cb(new Error('Photo ID must be an image (JPEG, PNG, WebP) or PDF.'));
  }
});

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

// Footer "Residences" links mirror the cities that currently have available
// listings. Cached in memory so every page render doesn't hit the database.
let footerCitiesCache = { cities: [], fetchedAt: 0 };
const FOOTER_CITIES_TTL_MS = 5 * 60 * 1000;

router.use(async (req, res, next) => {
  const now = Date.now();
  if (now - footerCitiesCache.fetchedAt > FOOTER_CITIES_TTL_MS) {
    try {
      // `location` is the market name the properties-page filter matches on
      // (cards default it to 'New York'), so the footer links use it too.
      const { rows } = await pool.query(
        `SELECT DISTINCT COALESCE(NULLIF(btrim(location), ''), 'New York') AS city
         FROM listings WHERE status != 'rented'
         ORDER BY city ASC`
      );
      footerCitiesCache = { cities: rows.map(r => r.city), fetchedAt: now };
    } catch (err) {
      console.error('Error loading footer cities:', err.message);
      footerCitiesCache.fetchedAt = now; // keep last known list, retry after TTL
    }
  }
  res.locals.footerCities = footerCitiesCache.cities;
  next();
});

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
  res.render('public/apply', {
    success: false,
    prefill: {
      property: req.query.property || '',
      listing: req.query.listing || '',
      movein: req.query.movein || '',
      moveout: req.query.moveout || ''
    }
  });
});

router.post('/apply', async (req, res) => {
  try {
    const { full_name, email, phone, about, social_media, property, move_in, move_out } = req.body;

    // Save to database
    await pool.query(
      `INSERT INTO applications (full_name, email, phone, about, social_media)
       VALUES ($1, $2, $3, $4, $5)`,
      [full_name, email, phone || null, about, social_media]
    );

    // Optional booking context carried over from a listing's "Book Now" button.
    const stayRange = (move_in || move_out) ? `${move_in || 'Flexible'} to ${move_out || 'Flexible'}` : '';
    const bookingRows = `
        ${property ? `<tr><td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Property</td><td style="padding: 10px; border-bottom: 1px solid #eee;">${property}</td></tr>` : ''}
        ${stayRange ? `<tr><td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Requested Dates</td><td style="padding: 10px; border-bottom: 1px solid #eee;">${stayRange}</td></tr>` : ''}`;

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
          ${bookingRows}
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

router.get('/apply-now', (req, res) => {
  res.render('public/apply-now', {
    feeCents: APPLICATION_FEE_CENTS,
    paymentsEnabled: !!stripe && !!res.app.locals.stripePublishableKey
  });
});

// Parse the two ID files (multipart), converting multer errors into JSON.
const idFields = idUpload.fields([{ name: 'id_front', maxCount: 1 }, { name: 'id_back', maxCount: 1 }]);
function handleIdUpload(req, res, next) {
  idFields(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Each photo ID must be 10 MB or smaller.' : (err.message || 'File upload failed.');
      return res.status(400).json({ error: msg });
    }
    next();
  });
}

const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

// Create a pending application + an embedded Checkout session.
router.post('/apply-now/session', handleIdUpload, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: 'Payments are not configured yet. Please try again later.' });
    }
    const body = req.body || {};
    const f = (k) => (body[k] || '').trim();
    const first_name = f('first_name');
    const last_name = f('last_name');
    const email = f('email');
    const phone = f('phone');
    const ec_name = f('emergency_contact_name');
    const ec_phone = f('emergency_contact_phone');
    const ec_email = f('emergency_contact_email');
    const ec_relationship = f('emergency_contact_relationship');
    const idFront = req.files && req.files.id_front && req.files.id_front[0];
    const idBack = req.files && req.files.id_back && req.files.id_back[0];

    // All fields are mandatory.
    if (!first_name || !last_name || !email || !phone || !ec_name || !ec_phone || !ec_email || !ec_relationship) {
      return res.status(400).json({ error: 'Please fill in all required fields.' });
    }
    if (!idFront || !idBack) {
      return res.status(400).json({ error: 'Please upload both the front and back of your photo ID.' });
    }
    if (!isEmail(email)) return res.status(400).json({ error: 'Please provide a valid email address.' });
    if (!isEmail(ec_email)) return res.status(400).json({ error: 'Please provide a valid emergency contact email.' });

    // Store the sensitive ID images in the private bucket (paths, not public URLs).
    let id_front_path, id_back_path;
    try {
      id_front_path = await storePrivateFile(idFront, 'pending');
      id_back_path = await storePrivateFile(idBack, 'pending');
    } catch (upErr) {
      console.error('ID upload failed:', upErr.message);
      return res.status(500).json({ error: 'Could not upload your photo ID. Please try again.' });
    }

    const full_name = `${first_name} ${last_name}`;
    const answers = {
      first_name, last_name,
      emergency_contact_name: ec_name,
      emergency_contact_phone: ec_phone,
      emergency_contact_email: ec_email,
      emergency_contact_relationship: ec_relationship,
      id_front_path, id_back_path
    };

    const { rows } = await pool.query(
      `INSERT INTO tenant_applications (full_name, email, phone, answers, amount_cents, payment_status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING id`,
      [full_name, email, phone, answers, APPLICATION_FEE_CENTS]
    );
    const appId = rows[0].id;

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const checkoutSession = await stripe.checkout.sessions.create({
      ui_mode: 'embedded_page',
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
      const a = app.answers || {};
      const row = (label, value) => `<tr><td style="padding:10px;border-bottom:1px solid #eee;font-weight:bold;width:200px;">${label}</td><td style="padding:10px;border-bottom:1px solid #eee;">${value || 'Not provided'}</td></tr>`;
      // Short-lived signed links so the admin can view the photo IDs (private bucket).
      const frontLink = await signedPrivateUrl(a.id_front_path).catch(() => null);
      const backLink = await signedPrivateUrl(a.id_back_path).catch(() => null);
      const idCell = (url) => url ? `<a href="${url}" style="color:#d4920b;">View (link valid 7 days)</a>` : 'Uploaded (open in admin)';
      await sendMail({
        to: NOTIFY_EMAIL,
        replyTo: app.email,
        subject: `New PAID Hive Application: ${app.full_name}`,
        html: `
          <h2>New Tenant Application (Paid — $${(APPLICATION_FEE_CENTS / 100).toFixed(2)})</h2>
          <table style="border-collapse:collapse;width:100%;max-width:600px;">
            ${row('First Name', a.first_name)}
            ${row('Last Name', a.last_name)}
            ${row('Email', app.email)}
            ${row('Phone', app.phone)}
            ${row('Photo ID — Front', idCell(frontLink))}
            ${row('Photo ID — Back', idCell(backLink))}
            ${row('Emergency Contact', a.emergency_contact_name)}
            ${row('Emergency — Phone', a.emergency_contact_phone)}
            ${row('Emergency — Email', a.emergency_contact_email)}
            ${row('Emergency — Relationship', a.emergency_contact_relationship)}
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

// FAQ — static page of common questions
router.get('/faq', (req, res) => {
  res.render('public/faq');
});
router.get('/faqs', (req, res) => res.redirect('/faq'));

// Contact Us — general enquiry form (distinct from the landlord partner inquiry)
router.get('/contact', (req, res) => {
  res.render('public/contact', { success: false });
});

router.post('/contact', async (req, res) => {
  const { full_name, email, phone, subject, message } = req.body;

  // Notify the master inbox with the submitted details (best-effort)
  try {
    await sendMail({
      to: NOTIFY_EMAIL,
      replyTo: email,
      subject: `New Contact Message: ${subject || full_name}`,
      html: `
      <h2>New Contact Message</h2>
      <table style="border-collapse: collapse; width: 100%; max-width: 600px;">
        <tr><td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold; width: 160px;">Name</td><td style="padding: 10px; border-bottom: 1px solid #eee;">${full_name}</td></tr>
        <tr><td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Email</td><td style="padding: 10px; border-bottom: 1px solid #eee;">${email}</td></tr>
        <tr><td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Phone</td><td style="padding: 10px; border-bottom: 1px solid #eee;">${phone || 'Not provided'}</td></tr>
        <tr><td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Subject</td><td style="padding: 10px; border-bottom: 1px solid #eee;">${subject || 'Not provided'}</td></tr>
        <tr><td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Message</td><td style="padding: 10px; border-bottom: 1px solid #eee;">${message}</td></tr>
      </table>
      <p style="margin-top: 20px; color: #888; font-size: 12px;">Submitted via Hive Contact Form</p>
    `
    });
  } catch (mailErr) {
    console.error('[mail] Failed to send contact notification:', mailErr.message);
  }

  // Send a confirmation to the sender (best-effort)
  try {
    await sendMail({
      to: email,
      subject: 'We received your message',
      html: confirmationHtml(`Thanks for reaching out, ${full_name}!`, [
        'We have received your message and our team will get back to you shortly.',
        'If your enquiry is time-sensitive, feel free to reply directly to this email.'
      ])
    });
  } catch (mailErr) {
    console.error('[mail] Failed to send contact confirmation:', mailErr.message);
  }

  res.render('public/contact', { success: true });
});

module.exports = router;
