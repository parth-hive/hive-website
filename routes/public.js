const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const pool = require('../db/pool');
const PgRateLimitStore = require('../utils/pgRateLimitStore');
const { mintFormToken, checkFormGuards, turnstileEnabled } = require('../utils/formGuard');
const { getGoogleReviews } = require('../utils/googleReviews');
const { storePrivateFile, signedPrivateUrl } = require('../utils/storage');

// ---------------------------------------------------------------------------
// Abuse protection for public form submissions.
//
// Every public form below triggers an outbound email (and in some cases a
// confirmation email to an address the submitter controls). Without a limit,
// these endpoints can be scripted to relay mail off the Hive domain, burning
// our sending reputation. These IP-keyed limiters cap how often a single
// client can submit. `trust proxy` is enabled in server.js, so req.ip is the
// real client IP behind Vercel's reverse proxy.
//
// The app runs on Vercel serverless, so counters live in Postgres (see
// utils/pgRateLimitStore) rather than in memory — a per-instance memory store
// would reset on every cold start and never actually enforce the limit. Each
// limiter gets its own `prefix` so their counts stay separate in the shared
// table.
const FIFTEEN_MIN = 15 * 60 * 1000;

// Renders an EJS form view with a friendly "slow down" message on a 429.
// `extraLocals` supplies any view locals beyond { success, error } that the
// template needs so rendering never throws.
function renderLimit(view, extraLocals = {}) {
  return (req, res) => {
    res.status(429).render(view, Object.assign({
      success: false,
      error: 'Too many submissions from your network. Please wait a few minutes and try again.'
    }, extraLocals));
  };
}

// Tenant application form (POST /apply).
const applyLimiter = rateLimit({
  windowMs: FIFTEEN_MIN,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: new PgRateLimitStore({ prefix: 'apply', windowMs: FIFTEEN_MIN }),
  handler: renderLimit('public/apply', {
    prefill: { property: '', listing: '', movein: '', moveout: '' }
  })
});

// Paid tenant application flow (POST /apply-now/session) — responds with JSON.
const applyNowLimiter = rateLimit({
  windowMs: FIFTEEN_MIN,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: new PgRateLimitStore({ prefix: 'apply-now', windowMs: FIFTEEN_MIN }),
  handler: (req, res) => res.status(429).json({
    error: 'Too many attempts from your network. Please wait a few minutes and try again.'
  })
});

// Landlord / partner inquiry form (POST /partners/apply).
const landlordLimiter = rateLimit({
  windowMs: FIFTEEN_MIN,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: new PgRateLimitStore({ prefix: 'landlord', windowMs: FIFTEEN_MIN }),
  handler: renderLimit('public/landlord-apply')
});

// General contact form (POST /contact) — the endpoint seen being abused as a
// mail relay, so it gets the tightest cap.
const contactLimiter = rateLimit({
  windowMs: FIFTEEN_MIN,
  max: 4,
  standardHeaders: true,
  legacyHeaders: false,
  store: new PgRateLimitStore({ prefix: 'contact', windowMs: FIFTEEN_MIN }),
  handler: renderLimit('public/contact')
});

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

// Outbound mail helpers shared with the Stripe webhook handler.
const { sendMail, confirmationHtml, NOTIFY_EMAIL } = require('../utils/mailer');

// --- Form field validation ---------------------------------------------
// Server-side mirror of the client-side pattern/minlength attributes, so the
// rules hold even when the HTML validation is bypassed (curl, bots).
const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
const isName = (s) => /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ .'-]{1,99}$/.test(s);
const isPhone = (s) => /^[0-9()+\-. ]{7,20}$/.test(s) && (s.match(/\d/g) || []).length >= 7;
const isText = (s, min, max) => typeof s === 'string' && s.trim().length >= min && s.trim().length <= max;
// A URL or a social handle (e.g. https://linkedin.com/in/x, instagram.com/x, @handle)
const isUrlish = (s) => /^(https?:\/\/)?([\w-]+\.)+[A-Za-z]{2,}(\/\S*)?$/.test(s) || /^@?[\w.]{2,50}$/.test(s);
const isUnits = (s) => /^[0-9]{1,6} ?\+?$/.test(s);
const isSsnLast4 = (s) => /^[0-9]{4}$/.test(s);
// Applicant must be an adult with a plausible birth year.
const isAdultDob = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const dob = new Date(`${s}T00:00:00Z`);
  if (isNaN(dob.getTime())) return false;
  const now = new Date();
  const age = (now - dob) / (365.25 * 24 * 3600 * 1000);
  return age >= 18 && age <= 120;
};
// A LinkedIn or Instagram profile URL (Instagram is only accepted when the
// profile is public — stated on the form; we can't verify visibility here).
const isSocialProfile = (s) =>
  /^(https?:\/\/)?(www\.)?(linkedin\.com\/(in|pub|company)\/|instagram\.com\/)[\w\-.%/?=&]+$/i.test(s);

// Returns the first error message, or null if every check passes.
function firstError(checks) {
  for (const [ok, message] of checks) if (!ok) return message;
  return null;
}

// Footer "Residences" links mirror the cities that currently have available
// listings. Cached in memory so every page render doesn't hit the database.
let footerCitiesCache = { cities: [], fetchedAt: 0 };
const FOOTER_CITIES_TTL_MS = 5 * 60 * 1000;

// Every form view embeds a fresh signed timestamp token (see utils/formGuard),
// and renders the Turnstile widget when its keys are configured.
router.use((req, res, next) => {
  res.locals.formToken = mintFormToken();
  res.locals.turnstileSiteKey = turnstileEnabled() ? process.env.TURNSTILE_SITE_KEY : null;
  next();
});

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

router.post('/apply', applyLimiter, async (req, res) => {
  try {
    const { full_name, email, phone, about, social_media, property, move_in, move_out } = req.body;

    const guard = await checkFormGuards(req);
    if (guard.verdict === 'spam') {
      // Fake success: don't save or email, and don't tell the bot which check tripped.
      console.warn(`[formGuard] Dropped /apply submission (${guard.reason}) from ${req.ip}`);
      return res.render('public/apply', { success: true });
    }
    if (guard.verdict === 'retry') {
      return res.status(400).render('public/apply', {
        success: false,
        error: guard.message,
        prefill: {
          property: property || '',
          listing: req.body.listing_id || '',
          movein: move_in || '',
          moveout: move_out || ''
        }
      });
    }

    const error = firstError([
      [isName(full_name || ''), 'Please enter your full name (letters only, at least 2 characters).'],
      [isEmail(email || ''), 'Please enter a valid email address.'],
      [isPhone(phone || ''), 'Please enter a valid phone number (at least 7 digits).'],
      [isText(about || '', 10, 2000), 'Please tell us a bit about yourself (10–2000 characters).'],
      [isUrlish((social_media || '').trim()), 'Please enter a valid social media / LinkedIn link or handle.']
    ]);
    if (error) {
      return res.status(400).render('public/apply', {
        success: false,
        error,
        prefill: {
          property: property || '',
          listing: req.body.listing_id || '',
          movein: move_in || '',
          moveout: move_out || ''
        }
      });
    }

    // Save to database, including any booking context from a listing's "Book Now" button
    await pool.query(
      `INSERT INTO applications (full_name, email, phone, about, social_media, property, move_in, move_out)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [full_name, email, phone || null, about, social_media, property || null, move_in || null, move_out || null]
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

// Create a pending application + an embedded Checkout session.
router.post('/apply-now/session', applyNowLimiter, handleIdUpload, async (req, res) => {
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
    const birthdate = f('birthdate');
    const ssn_last4 = f('ssn_last4');
    const social_profile = f('social_profile');
    const ec_name = f('emergency_contact_name');
    const ec_phone = f('emergency_contact_phone');
    const ec_email = f('emergency_contact_email');
    const ec_relationship = f('emergency_contact_relationship');
    const idFront = req.files && req.files.id_front && req.files.id_front[0];
    const idBack = req.files && req.files.id_back && req.files.id_back[0];

    // All fields are mandatory.
    if (!first_name || !last_name || !email || !phone || !birthdate || !ssn_last4 || !social_profile ||
        !ec_name || !ec_phone || !ec_email || !ec_relationship) {
      return res.status(400).json({ error: 'Please fill in all required fields.' });
    }
    if (!idFront || !idBack) {
      return res.status(400).json({ error: 'Please upload both the front and back of your photo ID.' });
    }
    const fieldError = firstError([
      [isName(first_name), 'Please enter a valid first name (letters only, at least 2 characters).'],
      [isName(last_name), 'Please enter a valid last name (letters only, at least 2 characters).'],
      [isEmail(email), 'Please provide a valid email address.'],
      [isPhone(phone), 'Please enter a valid phone number (at least 7 digits).'],
      [isAdultDob(birthdate), 'Please enter a valid birthdate (you must be at least 18).'],
      [isSsnLast4(ssn_last4), 'Please enter the last 4 digits of your SSN (numbers only).'],
      [isSocialProfile(social_profile), 'Please enter a LinkedIn or public Instagram profile link (e.g. linkedin.com/in/you).'],
      [isName(ec_name), 'Please enter a valid emergency contact name (letters only).'],
      [isPhone(ec_phone), 'Please enter a valid emergency contact phone number.'],
      [isEmail(ec_email), 'Please provide a valid emergency contact email.'],
      [isText(ec_relationship, 2, 50), 'Please enter the emergency contact relationship (2–50 characters).']
    ]);
    if (fieldError) return res.status(400).json({ error: fieldError });

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
      birthdate,
      ssn_last4,
      social_profile,
      emergency_contact_name: ec_name,
      emergency_contact_phone: ec_phone,
      emergency_contact_email: ec_email,
      emergency_contact_relationship: ec_relationship,
      id_front_path, id_back_path,
      // Unguessable reference used in the Stripe Identity return URL, so the
      // post-verification page can look this application up without exposing
      // sequential IDs.
      identity_token: crypto.randomUUID()
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
// payment, finalize the application (idempotently), send emails once, and
// hand the applicant to step 2: Stripe Identity verification.
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
       RETURNING id, full_name, email, phone, answers, identity_status`,
      [session.payment_intent || null, sessionId]
    );

    // Already finalized (refresh) — show success (and the identity-verification
    // step in its current state) without re-emailing.
    if (rows.length === 0) {
      const { rows: existing } = await pool.query(
        `SELECT answers, identity_status FROM tenant_applications WHERE stripe_session_id = $1`,
        [sessionId]
      );
      const row = existing[0];
      return renderResult('paid', {
        identityToken: (row && row.answers && row.answers.identity_token) || null,
        identityStatus: (row && row.identity_status) || 'not_started'
      });
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
            ${row('Birthdate', a.birthdate)}
            ${row('SSN (last 4)', a.ssn_last4 ? `***-**-${a.ssn_last4}` : null)}
            ${row('LinkedIn / Instagram', a.social_profile ? `<a href="${a.social_profile.startsWith('http') ? a.social_profile : 'https://' + a.social_profile}" style="color:#d4920b;">${a.social_profile}</a>` : null)}
            ${row('Photo ID — Front', idCell(frontLink))}
            ${row('Photo ID — Back', idCell(backLink))}
            ${row('Emergency Contact', a.emergency_contact_name)}
            ${row('Emergency — Phone', a.emergency_contact_phone)}
            ${row('Emergency — Email', a.emergency_contact_email)}
            ${row('Emergency — Relationship', a.emergency_contact_relationship)}
          </table>
          <p style="margin-top:20px;color:#888;font-size:12px;">Payment confirmed via Stripe · Application #${app.id} · Stripe Identity verification pending (you'll get a follow-up email with the result)</p>`
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
          'One step remains: a quick identity verification, handled securely by Stripe Identity. Use the "Verify My Identity" button on the confirmation page (you\'ll need your government ID and a device with a camera).',
          'After that, our team will review your application and reach out with next steps.',
          'In the meantime, feel free to browse our latest listings at <a href="https://hiveny.com/properties" style="color: #d4920b;">hiveny.com/properties</a>.'
        ])
      });
    } catch (mailErr) {
      console.error('[mail] Failed to send applicant confirmation:', mailErr.message);
    }

    renderResult('paid', {
      identityToken: (app.answers && app.answers.identity_token) || null,
      identityStatus: app.identity_status || 'not_started'
    });
  } catch (err) {
    console.error('Apply-now complete error:', err);
    renderResult('error');
  }
});

// ---------------------------------------------------------------------------
// Stripe Identity — step 2 of the paid application (only reachable once paid).
//
// Redirect integration per the Stripe docs: we create a VerificationSession
// server-side, send the applicant to the Stripe-hosted flow (session.url),
// and Stripe returns them to /apply-now/identity. Hosted URLs are single-use
// and expire after 48h, so we always fetch a fresh one via retrieve/create
// instead of storing the URL. Final results arrive via webhook
// (routes/stripeWebhook.js) because document checks finish asynchronously.

// Looks up a paid application by its unguessable identity token.
async function findPaidAppByToken(token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const { rows } = await pool.query(
    `SELECT id, full_name, email, answers, identity_session_id, identity_status, identity_last_error
       FROM tenant_applications
      WHERE answers->>'identity_token' = $1 AND payment_status = 'paid'`,
    [token]
  );
  return rows[0] || null;
}

// Returns { status, url, reason } for the application's VerificationSession,
// creating one on first use and reusing it afterwards (per Stripe's guidance,
// reuse tracks failed attempts on one session instead of spawning duplicates).
async function ensureIdentitySession(app, baseUrl) {
  if (app.identity_session_id) {
    const vs = await stripe.identity.verificationSessions.retrieve(app.identity_session_id);
    if (vs.status !== 'canceled') {
      return {
        status: vs.status,
        url: vs.url || null,
        reason: (vs.last_error && vs.last_error.reason) || null
      };
    }
    // Canceled sessions can't be resumed — fall through and start a new one.
  }

  const vs = await stripe.identity.verificationSessions.create({
    type: 'document',
    options: {
      document: {
        // The applicant must take a selfie that matches the document photo,
        // proving the ID belongs to them (not just a stolen image).
        require_matching_selfie: true
      }
    },
    provided_details: { email: app.email },
    metadata: { application_id: String(app.id) },
    return_url: `${baseUrl}/apply-now/identity?token=${app.answers.identity_token}`
  }, app.identity_session_id ? undefined : {
    // Guards against double-clicks creating duplicate sessions (and duplicate
    // per-verification Stripe charges) on first use.
    idempotencyKey: `identity-${app.answers.identity_token}`
  });

  await pool.query(
    `UPDATE tenant_applications SET identity_session_id = $1, identity_status = $2 WHERE id = $3`,
    [vs.id, vs.status, app.id]
  );
  return { status: vs.status, url: vs.url || null, reason: null };
}

// "Verify My Identity" button target — sends the applicant into the hosted flow.
router.get('/apply-now/identity/start', async (req, res) => {
  try {
    if (!stripe) return res.status(503).render('public/apply-now-identity', { status: 'error', reason: null, token: null });
    const app = await findPaidAppByToken((req.query.token || '').trim());
    if (!app) return res.redirect('/apply-now');

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const { status, url } = await ensureIdentitySession(app, baseUrl);

    // Nothing left to capture (already submitted/verified) — show the status page.
    if (!url || status === 'verified' || status === 'processing') {
      return res.redirect(`/apply-now/identity?token=${encodeURIComponent(app.answers.identity_token)}`);
    }
    res.redirect(url);
  } catch (err) {
    console.error('Identity start error:', err);
    res.status(500).render('public/apply-now-identity', { status: 'error', reason: null, token: (req.query.token || '').trim() || null });
  }
});

// Stripe Identity returns the applicant here. Webhooks are authoritative for
// the final status, but we sync opportunistically so the page is fresh even
// when the webhook hasn't landed yet.
router.get('/apply-now/identity', async (req, res) => {
  const token = (req.query.token || '').trim();
  try {
    if (!stripe) return res.status(503).render('public/apply-now-identity', { status: 'error', reason: null, token: null });
    const app = await findPaidAppByToken(token);
    if (!app) return res.redirect('/apply-now');
    if (!app.identity_session_id) {
      return res.redirect(`/apply-now/identity/start?token=${encodeURIComponent(token)}`);
    }

    const vs = await stripe.identity.verificationSessions.retrieve(app.identity_session_id);
    const reason = (vs.last_error && vs.last_error.reason) || null;
    await pool.query(
      `UPDATE tenant_applications
          SET identity_status = $2,
              identity_verified_at = CASE WHEN $3 THEN COALESCE(identity_verified_at, NOW()) ELSE identity_verified_at END,
              identity_last_error = $4
        WHERE id = $1`,
      [app.id, vs.status, vs.status === 'verified', reason]
    );

    res.render('public/apply-now-identity', { status: vs.status, reason, token });
  } catch (err) {
    console.error('Identity return error:', err);
    res.status(500).render('public/apply-now-identity', { status: 'error', reason: null, token: token || null });
  }
});

// Landlord inquiry form
router.get('/partners/apply', (req, res) => {
  res.render('public/landlord-apply', { success: false });
});

router.post('/partners/apply', landlordLimiter, async (req, res) => {
  try {
    const { full_name, email, phone, property_location, num_units, property_type, message, referral_source } = req.body;

    const guard = await checkFormGuards(req);
    if (guard.verdict === 'spam') {
      console.warn(`[formGuard] Dropped /partners/apply submission (${guard.reason}) from ${req.ip}`);
      return res.render('public/landlord-apply', { success: true });
    }
    if (guard.verdict === 'retry') {
      return res.status(400).render('public/landlord-apply', { success: false, error: guard.message });
    }

    const error = firstError([
      [isName(full_name || ''), 'Please enter your full name (letters only, at least 2 characters).'],
      [isEmail(email || ''), 'Please enter a valid email address.'],
      [isPhone(phone || ''), 'Please enter a valid phone number (at least 7 digits).'],
      [isText(property_location || '', 2, 150), 'Please enter the property location (2–150 characters).'],
      [isUnits((num_units || '').trim()), 'Please enter the number of units as a number, e.g. 1, 5 or 20+.'],
      [isText(message || '', 10, 2000), 'Please tell us about your property (10–2000 characters).'],
      [isText(referral_source || '', 2, 150), 'Please tell us how you heard about Hive (2–150 characters).']
    ]);
    if (error) {
      return res.status(400).render('public/landlord-apply', { success: false, error });
    }

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

router.post('/contact', contactLimiter, async (req, res) => {
  const { full_name, email, phone, subject, message } = req.body;

  const guard = await checkFormGuards(req);
  if (guard.verdict === 'spam') {
    console.warn(`[formGuard] Dropped /contact submission (${guard.reason}) from ${req.ip}`);
    return res.render('public/contact', { success: true });
  }
  if (guard.verdict === 'retry') {
    return res.status(400).render('public/contact', { success: false, error: guard.message });
  }

  const error = firstError([
    [isName(full_name || ''), 'Please enter your full name (letters only, at least 2 characters).'],
    [isEmail(email || ''), 'Please enter a valid email address.'],
    [isPhone(phone || ''), 'Please enter a valid phone number (at least 7 digits).'],
    [isText(subject || '', 3, 150), 'Please enter a subject (3–150 characters).'],
    [isText(message || '', 10, 2000), 'Please enter a message (10–2000 characters).']
  ]);
  if (error) {
    return res.status(400).render('public/contact', { success: false, error });
  }

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
