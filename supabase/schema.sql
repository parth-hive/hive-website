-- ============================================================
-- Hive — Supabase database schema
-- Run this ONCE in the Supabase SQL Editor (Dashboard → SQL Editor → New query).
-- No CLI required. It is idempotent — safe to re-run.
-- ============================================================

-- Admin users -------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_users (
  id            SERIAL PRIMARY KEY,
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name          VARCHAR(100) NOT NULL,
  created_at    TIMESTAMP DEFAULT NOW()
);

-- Listings ----------------------------------------------------
CREATE TABLE IF NOT EXISTS listings (
  id                   SERIAL PRIMARY KEY,
  title                VARCHAR(200) NOT NULL,
  neighborhood         VARCHAR(100) NOT NULL,
  city                 VARCHAR(100) NOT NULL,
  state                VARCHAR(2)  NOT NULL DEFAULT 'NY',
  bedrooms             INTEGER     NOT NULL DEFAULT 0,
  bathrooms            NUMERIC(3,1) NOT NULL DEFAULT 1,
  sqft                 INTEGER,
  price_monthly        INTEGER     NOT NULL,
  status               VARCHAR(20) NOT NULL DEFAULT 'coming_soon',
  available_from       DATE,
  available_to         DATE,
  description          TEXT,
  amenities            TEXT[] DEFAULT '{}',
  images               TEXT[] DEFAULT '{}',
  featured             BOOLEAN DEFAULT FALSE,
  sort_order           INTEGER DEFAULT 0,
  created_at           TIMESTAMP DEFAULT NOW(),
  updated_at           TIMESTAMP DEFAULT NOW(),
  -- detail-page columns
  floor                VARCHAR(50),
  min_stay             INTEGER DEFAULT 30,
  pet_policy           TEXT,
  smoking_allowed      BOOLEAN DEFAULT FALSE,
  events_allowed       BOOLEAN DEFAULT FALSE,
  building_amenities   TEXT[] DEFAULT '{}',
  highlights           TEXT,
  video_url            VARCHAR(500),
  bed_type             VARCHAR(50),
  address              VARCHAR(300),
  transit              TEXT,
  floor_plan_image     VARCHAR(500),
  location             VARCHAR(100) DEFAULT 'New York',
  location_description  TEXT,
  show_booking         BOOLEAN DEFAULT TRUE
);

-- Bookings ----------------------------------------------------
CREATE TABLE IF NOT EXISTS bookings (
  id          SERIAL PRIMARY KEY,
  listing_id  INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  guest_name  VARCHAR(200),
  check_in    DATE NOT NULL,
  check_out   DATE NOT NULL,
  notes       TEXT,
  created_at  TIMESTAMP DEFAULT NOW()
);

-- Applications ------------------------------------------------
CREATE TABLE IF NOT EXISTS applications (
  id           SERIAL PRIMARY KEY,
  full_name    VARCHAR(200) NOT NULL,
  email        VARCHAR(200) NOT NULL,
  phone        VARCHAR(50),
  about        TEXT,
  social_media TEXT,
  -- Booking context carried over from a listing's "Book Now" button (optional)
  property     VARCHAR(300),
  move_in      DATE,
  move_out     DATE,
  created_at   TIMESTAMP DEFAULT NOW()
);

-- Landlord inquiries ------------------------------------------
CREATE TABLE IF NOT EXISTS landlord_inquiries (
  id                SERIAL PRIMARY KEY,
  full_name         VARCHAR(200) NOT NULL,
  email             VARCHAR(200) NOT NULL,
  phone             VARCHAR(100),
  property_location VARCHAR(300),
  num_units         VARCHAR(50),
  property_type     VARCHAR(50),
  message           TEXT,
  referral_source   VARCHAR(200),
  created_at        TIMESTAMP DEFAULT NOW()
);

-- Default admin user ------------------------------------------
-- Email:    admin@hiveny.com
-- Password: hiveny2026   (CHANGE THIS after first login)
INSERT INTO admin_users (email, password_hash, name)
VALUES (
  'admin@hiveny.com',
  '$2a$10$xPiTlJftMH1GqCXy3TYLJuOo3/daCrxYXbP/C3rv9aYUItFb62GBe',
  'Hive Admin'
)
ON CONFLICT (email) DO NOTHING;

-- Note: the express-session store table ("session") is created automatically
-- at runtime by connect-pg-simple (createTableIfMissing: true).
