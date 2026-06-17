const pool = require('./pool');
const bcrypt = require('bcryptjs');

async function seed() {
  try {
    // Create default admin user
    const passwordHash = await bcrypt.hash('hiveny2026', 10);
    await pool.query(`
      INSERT INTO admin_users (email, password_hash, name)
      VALUES ($1, $2, $3)
      ON CONFLICT (email) DO NOTHING
    `, ['admin@hiveny.com', passwordHash, 'Hive Admin']);

    // Seed existing listings from hardcoded data
    const listings = [
      // Featured listings from index.html
      {
        title: 'Modern Studio in Midtown',
        neighborhood: 'Midtown',
        city: 'Manhattan',
        state: 'NY',
        bedrooms: 0,
        bathrooms: 1,
        sqft: 450,
        price_monthly: 3850,
        status: 'available',
        available_from: '2026-03-01',
        available_to: '2026-08-31',
        description: 'A sleek, modern studio in the heart of Midtown Manhattan. Walk to Times Square, Bryant Park, and countless dining options. Fully furnished with premium finishes.',
        featured: true,
        sort_order: 1
      },
      {
        title: 'Sun-Filled 1BR in SoHo',
        neighborhood: 'SoHo',
        city: 'Manhattan',
        state: 'NY',
        bedrooms: 1,
        bathrooms: 1,
        sqft: 620,
        price_monthly: 5200,
        status: 'available',
        available_from: '2026-04-01',
        available_to: '2026-09-30',
        description: 'Bright, sun-drenched one-bedroom in the heart of SoHo. High ceilings, hardwood floors, and surrounded by galleries, boutiques, and restaurants.',
        featured: true,
        sort_order: 2
      },
      {
        title: 'Spacious 2BR in Chelsea',
        neighborhood: 'Chelsea',
        city: 'Manhattan',
        state: 'NY',
        bedrooms: 2,
        bathrooms: 2,
        sqft: 950,
        price_monthly: 6400,
        status: 'available',
        available_from: '2026-02-15',
        available_to: '2026-07-15',
        description: 'A spacious two-bedroom in Chelsea with stunning city views. Steps from the High Line, Chelsea Market, and Hudson Yards.',
        featured: true,
        sort_order: 3
      },
      // Listings from properties.html
      {
        title: 'The Mercer Loft',
        neighborhood: 'SoHo',
        city: 'Manhattan',
        state: 'NY',
        bedrooms: 1,
        bathrooms: 1,
        sqft: 680,
        price_monthly: 4200,
        status: 'available',
        available_from: '2026-03-01',
        available_to: '2026-08-31',
        description: 'A beautifully designed loft in the heart of SoHo with exposed brick and modern amenities.',
        featured: false,
        sort_order: 4
      },
      {
        title: 'Waterfront Studio',
        neighborhood: 'Downtown',
        city: 'Jersey City',
        state: 'NJ',
        bedrooms: 0,
        bathrooms: 1,
        sqft: 520,
        price_monthly: 3800,
        status: 'available',
        available_from: '2026-03-15',
        available_to: '2026-09-15',
        description: 'A stunning waterfront studio with views of the Manhattan skyline. Minutes from the PATH train.',
        featured: false,
        sort_order: 5
      },
      {
        title: 'Prospect Heights Two-Bed',
        neighborhood: 'Prospect Heights',
        city: 'Brooklyn',
        state: 'NY',
        bedrooms: 2,
        bathrooms: 1,
        sqft: 920,
        price_monthly: 5600,
        status: 'coming_soon',
        available_from: '2026-05-01',
        available_to: '2026-10-31',
        description: 'A gorgeous two-bedroom in Prospect Heights, steps from Prospect Park and the Brooklyn Museum.',
        featured: false,
        sort_order: 6
      },
      {
        title: 'The Hoboken Classic',
        neighborhood: 'Hoboken',
        city: 'Hoboken',
        state: 'NJ',
        bedrooms: 1,
        bathrooms: 1,
        sqft: 740,
        price_monthly: 3400,
        status: 'coming_soon',
        available_from: '2026-04-15',
        available_to: '2026-10-15',
        description: 'A charming one-bedroom in Hoboken with classic brownstone character and modern updates.',
        featured: false,
        sort_order: 7
      },
      {
        title: 'Midtown Corner Suite',
        neighborhood: 'Midtown',
        city: 'Manhattan',
        state: 'NY',
        bedrooms: 1,
        bathrooms: 1,
        sqft: 810,
        price_monthly: 6100,
        status: 'available',
        available_from: '2026-03-01',
        available_to: '2026-08-31',
        description: 'A premium corner suite in Midtown with floor-to-ceiling windows and city views in every direction.',
        featured: false,
        sort_order: 8
      },
      {
        title: 'Williamsburg Penthouse',
        neighborhood: 'Williamsburg',
        city: 'Brooklyn',
        state: 'NY',
        bedrooms: 2,
        bathrooms: 2,
        sqft: 1050,
        price_monthly: 4800,
        status: 'coming_soon',
        available_from: '2026-06-01',
        available_to: '2026-11-30',
        description: 'A stunning penthouse in Williamsburg with a private rooftop terrace and panoramic views.',
        featured: false,
        sort_order: 9
      }
    ];

    for (const l of listings) {
      await pool.query(`
        INSERT INTO listings (title, neighborhood, city, state, bedrooms, bathrooms, sqft, price_monthly, status, available_from, available_to, description, featured, sort_order)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      `, [l.title, l.neighborhood, l.city, l.state, l.bedrooms, l.bathrooms, l.sqft, l.price_monthly, l.status, l.available_from, l.available_to, l.description, l.featured, l.sort_order]);
    }

    console.log('Seed data inserted successfully.');
    console.log('Admin login: admin@hiveny.com / hiveny2026');
    process.exit(0);
  } catch (err) {
    console.error('Error seeding database:', err);
    process.exit(1);
  }
}

seed();
