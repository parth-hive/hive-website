// Image storage helper.
//
// In production (Vercel) the filesystem is read-only, so uploaded images are
// pushed to a public Supabase Storage bucket and the public URL is stored.
// When Supabase env vars are not set (e.g. local dev), images fall back to
// the local `public/uploads` directory so behavior is unchanged offline.

const path = require('path');
const fs = require('fs');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'listings';

let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
  });
}

function uniqueName(originalName) {
  return Date.now() + '-' + Math.round(Math.random() * 1e6) + path.extname(originalName || '');
}

// Persist a single in-memory multer file and return a URL/path string
// suitable for storing in the `listings.images` / `floor_plan_image` columns.
async function storeImage(file) {
  const name = uniqueName(file.originalname);

  if (supabase) {
    const { error } = await supabase.storage.from(BUCKET).upload(name, file.buffer, {
      contentType: file.mimetype,
      upsert: false
    });
    if (error) throw new Error('Supabase Storage upload failed: ' + error.message);
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(name);
    return data.publicUrl;
  }

  // Local fallback
  const dir = path.join(__dirname, '..', 'public', 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), file.buffer);
  return '/uploads/' + name;
}

// Private bucket for sensitive uploads (e.g. applicant photo IDs). Never public —
// objects are retrieved by admins via short-lived signed URLs. Stores and returns
// the object *path* (not a public URL).
const PRIVATE_BUCKET = process.env.SUPABASE_PRIVATE_BUCKET || 'applicant-ids';

async function storePrivateFile(file, prefix) {
  const name = (prefix ? prefix.replace(/[^a-z0-9/_-]/gi, '') + '/' : '') + uniqueName(file.originalname);
  if (supabase) {
    const { error } = await supabase.storage.from(PRIVATE_BUCKET).upload(name, file.buffer, {
      contentType: file.mimetype,
      upsert: false
    });
    if (error) throw new Error('Private upload failed: ' + error.message);
    return name; // store the object path; resolve to a signed URL on demand
  }
  // Local fallback (dev only) — keep IDs out of the public uploads dir.
  const dir = path.join(__dirname, '..', 'private_uploads');
  fs.mkdirSync(path.join(dir, path.dirname(name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), file.buffer);
  return 'local:' + name;
}

// Resolve a stored private path to a temporary signed URL (default 7 days).
async function signedPrivateUrl(objectPath, expiresInSeconds = 7 * 24 * 60 * 60) {
  if (!objectPath || objectPath.startsWith('local:')) return null;
  if (!supabase) return null;
  const { data, error } = await supabase.storage.from(PRIVATE_BUCKET).createSignedUrl(objectPath, expiresInSeconds);
  if (error) return null;
  return data.signedUrl;
}

module.exports = { storeImage, storePrivateFile, signedPrivateUrl, storageEnabled: !!supabase, PRIVATE_BUCKET };
