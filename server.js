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
      )`
    ];
    for (const sql of migrations) {
      await pool.query(sql);
    }
    console.log('Database migrations applied.');
  } catch (err) {
    console.error('Migration warning:', err.message);
  }
})();

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
