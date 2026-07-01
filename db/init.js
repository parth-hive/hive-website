const pool = require('./pool');

async function init() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(100) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS listings (
        id SERIAL PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        neighborhood VARCHAR(100) NOT NULL,
        city VARCHAR(100) NOT NULL,
        state VARCHAR(2) NOT NULL DEFAULT 'NY',
        bedrooms INTEGER NOT NULL DEFAULT 0,
        bathrooms INTEGER NOT NULL DEFAULT 1,
        sqft INTEGER,
        price_monthly INTEGER NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'coming_soon',
        available_from DATE,
        available_to DATE,
        description TEXT,
        amenities TEXT[] DEFAULT '{}',
        images TEXT[] DEFAULT '{}',
        featured BOOLEAN DEFAULT FALSE,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Add new columns for listing detail pages (idempotent)
    const newColumns = [
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
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS key_amenities TEXT[] DEFAULT '{}'`
    ];

    for (const sql of newColumns) {
      await pool.query(sql);
    }

    console.log('Database tables created successfully.');
    process.exit(0);
  } catch (err) {
    console.error('Error initializing database:', err);
    process.exit(1);
  }
}

init();
