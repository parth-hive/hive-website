// One-off importer: derives the 6 key amenity categories from the "Amenities"
// column (col N) of "Copy of Hive Cities.xlsx" and stores them per listing in
// listings.key_amenities. Matching is by normalized Title.
//
// Usage: node scripts/populate-key-amenities.js /path/to/amenities_map.json
// where amenities_map.json is { "<normalized title>": ["Gym", "Pool", ...] }
// (produced by the accompanying Python parse step).

const fs = require('fs');
const pool = require('../db/pool');

const norm = (s) => (s == null ? '' : String(s).trim().toLowerCase().replace(/\s+/g, ' '));

async function main() {
  const mapPath = process.argv[2];
  if (!mapPath) {
    console.error('Provide the path to amenities_map.json');
    process.exit(1);
  }
  const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));

  await pool.query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS key_amenities TEXT[] DEFAULT '{}'`);

  const { rows } = await pool.query('SELECT id, title FROM listings');
  let updated = 0, withAmen = 0, noMatch = 0;
  for (const l of rows) {
    const amen = map[norm(l.title)];
    if (!amen) { noMatch++; continue; }
    await pool.query('UPDATE listings SET key_amenities = $1 WHERE id = $2', [amen, l.id]);
    updated++;
    if (amen.length) withAmen++;
  }
  console.log(`Updated ${updated} listings (${withAmen} with >=1 amenity, ${noMatch} unmatched).`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
