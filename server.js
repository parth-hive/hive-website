require('dotenv').config({ path: '.env.local' });
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const path = require('path');
const pool = require('./db/pool');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust Railway's reverse proxy (needed for secure cookies over HTTPS)
app.set('trust proxy', 1);

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Sessions
app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'hive-dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    secure: process.env.NODE_ENV === 'production'
  }
}));

// Auto-migrate: add any new columns on startup (idempotent)
(async () => {
  try {
    const migrations = [
      `ALTER TABLE listings ALTER COLUMN bathrooms TYPE NUMERIC(3,1)`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS floor VARCHAR(50)`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS min_stay INTEGER DEFAULT 30`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS pet_policy TEXT`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS smoking_allowed BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS events_allowed BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS building_amenities TEXT[] DEFAULT '{}'`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS highlights TEXT`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS video_url VARCHAR(500)`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS bed_type VARCHAR(50)`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS address VARCHAR(300)`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS transit TEXT`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS floor_plan_image VARCHAR(500)`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS location VARCHAR(100) DEFAULT 'New York'`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS location_description TEXT`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS show_booking BOOLEAN DEFAULT TRUE`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS property_type VARCHAR(50)`,
      `CREATE TABLE IF NOT EXISTS bookings (
        id SERIAL PRIMARY KEY,
        listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
        guest_name VARCHAR(200),
        check_in DATE NOT NULL,
        check_out DATE NOT NULL,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS applications (
        id SERIAL PRIMARY KEY,
        full_name VARCHAR(200) NOT NULL,
        email VARCHAR(200) NOT NULL,
        phone VARCHAR(50),
        about TEXT,
        social_media TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS landlord_inquiries (
        id SERIAL PRIMARY KEY,
        full_name VARCHAR(200) NOT NULL,
        email VARCHAR(200) NOT NULL,
        phone VARCHAR(100),
        property_location VARCHAR(300),
        num_units VARCHAR(50),
        property_type VARCHAR(50),
        message TEXT,
        referral_source VARCHAR(200),
        created_at TIMESTAMP DEFAULT NOW()
      )`,
      // Paid tenant applications ($20 fee, collected via Stripe Checkout).
      // `answers` holds the (to-be-finalized) application form fields as JSON so
      // new questions can be added without further migrations.
      `CREATE TABLE IF NOT EXISTS tenant_applications (
        id SERIAL PRIMARY KEY,
        full_name VARCHAR(200) NOT NULL,
        email VARCHAR(200) NOT NULL,
        phone VARCHAR(50),
        answers JSONB DEFAULT '{}'::jsonb,
        amount_cents INTEGER NOT NULL DEFAULT 2000,
        currency VARCHAR(10) NOT NULL DEFAULT 'usd',
        payment_status VARCHAR(20) NOT NULL DEFAULT 'pending',
        stripe_session_id VARCHAR(255),
        stripe_payment_intent VARCHAR(255),
        paid_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )`,
      `CREATE INDEX IF NOT EXISTS tenant_applications_session_idx ON tenant_applications (stripe_session_id)`
    ];
    for (const sql of migrations) {
      await pool.query(sql);
    }
    console.log('Database migrations applied.');
  } catch (err) {
    console.error('Migration warning:', err.message);
  }
})();

// Public-facing, anonymized listing title — never exposes the building name
// (which is kept privately in `listing.title`). Deterministic per building so
// every room in the same unit shows the same title, while different buildings
// get different descriptors, keeping titles distinct within a city.
app.locals.publicTitle = function (listing) {
  if (!listing) return '';
  const neighborhood = (listing.neighborhood && String(listing.neighborhood).trim())
    || (listing.city && String(listing.city).trim()) || 'the city';
  const beds = parseInt(listing.bedrooms, 10);
  const bedLabel = (!beds || beds <= 0) ? 'Studio' : beds + 'BR';
  const type = (listing.property_type && String(listing.property_type).trim()) || 'apartment';
  const ADJ = ['luxury', 'modern', 'boutique', 'elegant', 'designer', 'sunlit',
               'stylish', 'chic', 'contemporary', 'serene'];
  const seed = String(listing.title || '') + '|' + String(listing.city || '');
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(h, 31) + seed.charCodeAt(i)) >>> 0;
  const adj = ADJ[h % ADJ.length];
  const article = /^[aeiou]/i.test(adj) ? 'an' : 'a';
  return `${bedLabel} in ${article} ${adj} ${type} in ${neighborhood}`;
};

// Google Maps JS API key for the approximate-area map (empty => iframe fallback).
app.locals.mapsApiKey = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY || '';

// Stripe publishable key for the client-side embedded Checkout (empty => the
// apply-now page shows a "payments not configured" notice instead of crashing).
app.locals.stripePublishableKey = process.env.STRIPE_PUBLISHABLE_KEY || '';
// The tenant application fee, in cents. Single source of truth for server + view.
app.locals.applicationFeeCents = parseInt(process.env.APPLICATION_FEE_CENTS || '2000', 10);

// Routes
app.use('/', require('./routes/public'));
app.use('/admin', require('./routes/admin'));
app.use('/api', require('./routes/api'));

// Start a long-running server only when invoked directly (local dev, Railway).
// On Vercel the app is imported by api/index.js and served as a serverless function.
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });
}

module.exports = app;
