#!/usr/bin/env node
/*
 * Listing image optimizer.
 *
 * Shrinks the Supabase `listings` storage bucket by resizing oversized photos
 * and re-encoding everything to WebP, then repointing each listing's image URLs
 * at the new optimized objects. Originals are left in place until you prune them
 * in a separate, explicit step.
 *
 * Modes (safe by default — dry-run never writes anything):
 *   node scripts/optimize-images.js                 # dry-run: sample + project savings
 *   node scripts/optimize-images.js --dry-run -n 20 # dry-run on 20 sampled images
 *   node scripts/optimize-images.js --apply         # optimize ALL + update DB URLs
 *   node scripts/optimize-images.js --apply --limit 50   # optimize first 50 (staged rollout)
 *   node scripts/optimize-images.js --prune-originals    # delete objects no listing references
 *
 * Tunables: --max-width <px> (default 2000), --quality <1-100> (default 80),
 *           --concurrency <n> (default 6).
 */
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();
const sharp = require('sharp');
const pool = require('../db/pool');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'listings';

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env.');
  process.exit(1);
}
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// ---- args ----
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const APPLY = has('--apply');
const PRUNE = has('--prune-originals');
const DRY = !APPLY && !PRUNE;
const SAMPLE_N = parseInt(val('-n', val('--sample', '12')), 10);
const LIMIT = val('--limit', null) ? parseInt(val('--limit'), 10) : null;
const MAX_W = parseInt(val('--max-width', '2000'), 10);
const QUALITY = parseInt(val('--quality', '80'), 10);
const CONC = parseInt(val('--concurrency', '6'), 10);

const publicUrl = (name) => `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${name}`;
const mb = (b) => (b / 1024 / 1024).toFixed(2);
// Optimized objects get an .opt.webp suffix so they never collide with originals
// and are easy to recognize / re-skip on a second run.
const isOptimized = (name) => /\.opt\.webp$/i.test(name);
const optName = (name) => name.replace(/\.[^.]+$/, '') + '.opt.webp';

// Simple promise pool.
async function mapPool(items, fn, concurrency) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

async function listAllObjects() {
  const { rows } = await pool.query(
    `SELECT o.name AS name, COALESCE((o.metadata->>'size')::bigint,0) AS size
       FROM storage.objects o JOIN storage.buckets b ON b.id=o.bucket_id
      WHERE b.name=$1 ORDER BY o.name`, [BUCKET]);
  return rows.map(r => ({ name: r.name, size: Number(r.size) }));
}

async function downloadBytes(name) {
  const res = await fetch(publicUrl(name));
  if (!res.ok) throw new Error(`download ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function transform(buf) {
  return sharp(buf, { failOn: 'none' })
    .rotate()                                   // bake EXIF orientation before resize
    .resize({ width: MAX_W, height: MAX_W, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: QUALITY })
    .toBuffer();
}

// ---------------- DRY RUN ----------------
async function dryRun() {
  const objs = (await listAllObjects()).filter(o => !isOptimized(o.name));
  if (!objs.length) { console.log('Nothing to optimize (all objects already optimized).'); return; }
  const step = Math.max(1, Math.floor(objs.length / SAMPLE_N));
  const sample = objs.filter((_, idx) => idx % step === 0).slice(0, SAMPLE_N);
  console.log(`DRY RUN — sampling ${sample.length} of ${objs.length} objects (max-width ${MAX_W}px, webp q${QUALITY})\n`);

  let inSum = 0, outSum = 0, ok = 0;
  await mapPool(sample, async (o) => {
    try {
      const buf = await downloadBytes(o.name);
      const meta = await sharp(buf).metadata().catch(() => ({}));
      const out = await transform(buf);
      inSum += buf.length; outSum += out.length; ok++;
      const pct = ((1 - out.length / buf.length) * 100).toFixed(0);
      console.log(`  ${o.name.slice(0, 36).padEnd(36)} ${String(meta.width || '?')}x${String(meta.height || '?')} ${meta.format || ''}  ${mb(buf.length)}MB -> ${mb(out.length)}MB  (-${pct}%)`);
    } catch (e) { console.log(`  ${o.name.slice(0, 36).padEnd(36)} SKIP (${e.message})`); }
  }, CONC);

  if (!ok) { console.log('\nNo images could be sampled.'); return; }
  const ratio = outSum / inSum;
  const totalBytes = objs.reduce((s, o) => s + o.size, 0);
  console.log(`\nSample: ${mb(inSum)}MB -> ${mb(outSum)}MB  (avg -${((1 - ratio) * 100).toFixed(0)}%)`);
  console.log(`Projected bucket: ${mb(totalBytes)}MB -> ~${mb(totalBytes * ratio)}MB across ${objs.length} objects`);
  console.log(`Projected savings: ~${mb(totalBytes * (1 - ratio))}MB`);
  console.log('\nNothing was modified. Re-run with --apply to optimize for real.');
}

// ---------------- APPLY ----------------
async function apply() {
  let objs = (await listAllObjects()).filter(o => !isOptimized(o.name));
  if (LIMIT) objs = objs.slice(0, LIMIT);
  console.log(`APPLY — optimizing ${objs.length} objects (max-width ${MAX_W}px, webp q${QUALITY}, concurrency ${CONC})\n`);

  let done = 0, failed = 0, inSum = 0, outSum = 0, dbUpdated = 0;
  await mapPool(objs, async (o) => {
    try {
      const newName = optName(o.name);
      const buf = await downloadBytes(o.name);
      const out = await transform(buf);
      const { error: upErr } = await supabase.storage.from(BUCKET)
        .upload(newName, out, { contentType: 'image/webp', upsert: true });
      if (upErr) throw new Error('upload: ' + upErr.message);

      const oldUrl = publicUrl(o.name);
      const newUrl = publicUrl(newName);
      // Repoint every listing that references the old URL (array_replace handles dupes).
      const r = await pool.query(
        `UPDATE listings SET images = array_replace(images, $1, $2), updated_at = NOW()
          WHERE $1 = ANY(images) RETURNING id`, [oldUrl, newUrl]);
      dbUpdated += r.rowCount;

      inSum += buf.length; outSum += out.length; done++;
      if (done % 100 === 0) console.log(`  …${done}/${objs.length} (${mb(inSum)}MB -> ${mb(outSum)}MB so far)`);
    } catch (e) { failed++; console.error(`  FAIL ${o.name}: ${e.message}`); }
  }, CONC);

  console.log(`\nDone. Optimized ${done}, failed ${failed}. DB url-references updated: ${dbUpdated}.`);
  console.log(`Size: ${mb(inSum)}MB -> ${mb(outSum)}MB (-${inSum ? ((1 - outSum / inSum) * 100).toFixed(0) : 0}%).`);
  console.log('\nOriginals are still in the bucket. Verify the site, then run --prune-originals to reclaim space.');
}

// ---------------- PRUNE ----------------
async function prune() {
  const objs = await listAllObjects();
  const { rows } = await pool.query(`SELECT images FROM listings WHERE images IS NOT NULL`);
  const referenced = new Set();
  for (const row of rows) for (const url of (row.images || [])) {
    const m = url && url.match(new RegExp(`/${BUCKET}/(.+?)(?:\\?|$)`));
    if (m) referenced.add(decodeURIComponent(m[1]));
  }
  const orphans = objs.filter(o => !referenced.has(o.name));
  const orphanBytes = orphans.reduce((s, o) => s + o.size, 0);
  if (!orphans.length) { console.log('No orphaned objects to prune.'); return; }
  console.log(`PRUNE — ${orphans.length} unreferenced objects = ${mb(orphanBytes)}MB to delete.`);

  // Delete in chunks of 100 (Supabase remove() accepts arrays).
  let removed = 0;
  for (let i = 0; i < orphans.length; i += 100) {
    const chunk = orphans.slice(i, i + 100).map(o => o.name);
    const { error } = await supabase.storage.from(BUCKET).remove(chunk);
    if (error) { console.error('remove error:', error.message); break; }
    removed += chunk.length;
    console.log(`  removed ${removed}/${orphans.length}`);
  }
  console.log(`\nPruned ${removed} objects, reclaimed ~${mb(orphanBytes)}MB.`);
}

(async () => {
  try {
    if (DRY) await dryRun();
    else if (APPLY) await apply();
    else if (PRUNE) await prune();
  } catch (e) {
    console.error('Fatal:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
