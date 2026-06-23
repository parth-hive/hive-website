const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const pool = require('../db/pool');
const { requireAdmin } = require('../middleware/auth');
const { storeImage, signedPrivateUrl } = require('../utils/storage');

// --- Multer config for image uploads ---
// Files are kept in memory, then handed to storeImage() which writes them to
// Supabase Storage in production (Vercel) or to local disk in development.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp|gif|svg/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    if (ext || mime) return cb(null, true);
    cb(new Error('Only image files (JPEG, PNG, WebP, GIF, SVG) are allowed.'));
  }
});

// --- Auth Routes ---

router.get('/login', (req, res) => {
  if (req.session && req.session.adminId) {
    return res.redirect('/admin/dashboard');
  }
  res.render('admin/login', { error: null });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM admin_users WHERE email = $1', [email]);
    if (rows.length === 0) {
      return res.render('admin/login', { error: 'Invalid email or password.' });
    }
    const admin = rows[0];
    const match = await bcrypt.compare(password, admin.password_hash);
    if (!match) {
      return res.render('admin/login', { error: 'Invalid email or password.' });
    }
    req.session.adminId = admin.id;
    req.session.adminName = admin.name;
    res.redirect('/admin/dashboard');
  } catch (err) {
    console.error('Login error:', err);
    res.render('admin/login', { error: 'Something went wrong. Please try again.' });
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/admin/login');
  });
});

// --- Account / Change Password ---

router.get('/account', requireAdmin, (req, res) => {
  res.render('admin/account', { adminName: req.session.adminName, error: null, success: null });
});

router.post('/account/password', requireAdmin, async (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  const render = (opts) => res.render('admin/account', Object.assign(
    { adminName: req.session.adminName, error: null, success: null }, opts
  ));

  try {
    if (!current_password || !new_password || !confirm_password) {
      return render({ error: 'All fields are required.' });
    }
    if (new_password.length < 8) {
      return render({ error: 'New password must be at least 8 characters.' });
    }
    if (new_password !== confirm_password) {
      return render({ error: 'New password and confirmation do not match.' });
    }

    const { rows } = await pool.query('SELECT * FROM admin_users WHERE id = $1', [req.session.adminId]);
    if (rows.length === 0) {
      return render({ error: 'Account not found.' });
    }
    const admin = rows[0];

    const match = await bcrypt.compare(current_password, admin.password_hash);
    if (!match) {
      return render({ error: 'Current password is incorrect.' });
    }
    if (await bcrypt.compare(new_password, admin.password_hash)) {
      return render({ error: 'New password must be different from your current password.' });
    }

    const newHash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE admin_users SET password_hash = $1 WHERE id = $2', [newHash, admin.id]);
    return render({ success: 'Password updated successfully.' });
  } catch (err) {
    console.error('Password change error:', err);
    return render({ error: 'Something went wrong. Please try again.' });
  }
});

// --- Protected Admin Routes ---

router.get('/dashboard', requireAdmin, async (req, res) => {
  try {
    const { rows: listings } = await pool.query(
      'SELECT * FROM listings ORDER BY sort_order ASC, created_at DESC'
    );
    res.render('admin/dashboard', {
      listings,
      adminName: req.session.adminName,
      success: req.query.success || null
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.render('admin/dashboard', { listings: [], adminName: req.session.adminName, success: null });
  }
});

// --- Reorder listings (drag-and-drop) ---
router.post('/listings/reorder', requireAdmin, async (req, res) => {
  try {
    const { order } = req.body;
    if (!order || !Array.isArray(order)) {
      return res.status(400).json({ error: 'Invalid order data' });
    }
    for (const item of order) {
      await pool.query('UPDATE listings SET sort_order = $1 WHERE id = $2', [item.sort_order, item.id]);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Reorder error:', err);
    res.status(500).json({ error: 'Failed to reorder listings' });
  }
});

router.get('/listings/new', requireAdmin, (req, res) => {
  res.render('admin/listing-form', {
    listing: null,
    bookings: [],
    adminName: req.session.adminName,
    error: null
  });
});

router.post('/listings', requireAdmin, upload.fields([{ name: 'image_files', maxCount: 10 }, { name: 'floor_plan_file', maxCount: 1 }]), async (req, res) => {
  const {
    title, location, neighborhood, city, state, bedrooms, bathrooms,
    sqft, price_monthly, status, available_from, available_to,
    description, amenities, amenities_custom, featured, sort_order, existing_images,
    floor, min_stay, pet_policy, smoking_allowed, events_allowed,
    building_amenities_list, building_amenities_custom, highlights, video_url, bed_type, address, transit,
    floor_plan_image, image_order, location_description, show_booking, property_type
  } = req.body;

  try {
    // Combine checked amenities with custom ones
    const checkedAmenities = amenities ? (Array.isArray(amenities) ? amenities : [amenities]) : [];
    const customAmenities = amenities_custom ? amenities_custom.split(',').map(s => s.trim()).filter(Boolean) : [];
    const amenitiesArr = checkedAmenities.concat(customAmenities);

    const checkedBuildingAmenities = building_amenities_list ? (Array.isArray(building_amenities_list) ? building_amenities_list : [building_amenities_list]) : [];
    const customBuildingAmenities = building_amenities_custom ? building_amenities_custom.split(',').map(s => s.trim()).filter(Boolean) : [];
    const buildingAmenitiesArr = checkedBuildingAmenities.concat(customBuildingAmenities);

    // Build ordered images array using image_order from drag-and-drop
    const imageFiles = req.files && req.files['image_files'] ? req.files['image_files'] : [];
    const urlImages = existing_images ? (Array.isArray(existing_images) ? existing_images : [existing_images]).filter(Boolean) : [];
    const newUploads = await Promise.all(imageFiles.map(f => storeImage(f)));
    let imagesArr = [];

    // Handle floor plan file upload
    const floorPlanFiles = req.files && req.files['floor_plan_file'] ? req.files['floor_plan_file'] : [];
    let finalFloorPlan = floor_plan_image || null;
    if (floorPlanFiles.length > 0) {
      finalFloorPlan = await storeImage(floorPlanFiles[0]);
    }

    if (image_order) {
      try {
        const order = JSON.parse(image_order);
        order.forEach(function(identifier) {
          if (typeof identifier === 'string' && identifier.startsWith('file:')) {
            const fileIndex = parseInt(identifier.split(':')[1], 10);
            if (newUploads[fileIndex]) imagesArr.push(newUploads[fileIndex]);
          } else if (typeof identifier === 'string' && identifier.length > 0) {
            if (urlImages.includes(identifier)) imagesArr.push(identifier);
          }
        });
      } catch (e) {
        console.error('image_order parse error:', e);
        imagesArr = urlImages.concat(newUploads);
      }
    } else {
      imagesArr = urlImages.concat(newUploads);
    }

    await pool.query(`
      INSERT INTO listings (
        title, location, neighborhood, city, state, bedrooms, bathrooms, sqft, price_monthly,
        status, available_from, available_to, description, amenities, images,
        featured, sort_order, floor, min_stay, pet_policy, smoking_allowed,
        events_allowed, building_amenities, highlights, video_url, bed_type, address, transit,
        floor_plan_image, location_description, show_booking, property_type
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32)
    `, [
      title, location || 'New York', neighborhood, city, state || 'NY',
      parseInt(bedrooms) || 0, parseFloat(bathrooms) || 1,
      sqft ? parseInt(sqft) : null, parseInt(price_monthly),
      status || 'coming_soon',
      available_from || null, available_to || null,
      description || null, amenitiesArr, imagesArr,
      featured === 'on' || featured === 'true', parseInt(sort_order) || 0,
      floor || null, min_stay ? parseInt(min_stay) : 30,
      pet_policy || null,
      smoking_allowed === 'on' || smoking_allowed === 'true',
      events_allowed === 'on' || events_allowed === 'true',
      buildingAmenitiesArr, highlights || null, video_url || null,
      bed_type || null, address || null, transit || null,
      finalFloorPlan, location_description || null,
      show_booking === 'on' || show_booking === 'true',
      property_type || null
    ]);

    res.redirect('/admin/dashboard?success=Listing created successfully');
  } catch (err) {
    console.error('Create listing error:', err);
    res.render('admin/listing-form', {
      listing: req.body,
      bookings: [],
      adminName: req.session.adminName,
      error: 'Failed to create listing. Please try again.'
    });
  }
});

router.get('/listings/:id/edit', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM listings WHERE id = $1', [req.params.id]);
    if (rows.length === 0) {
      return res.redirect('/admin/dashboard');
    }
    const { rows: bookings } = await pool.query(
      'SELECT * FROM bookings WHERE listing_id = $1 ORDER BY check_in ASC', [req.params.id]
    );
    // Convert deprecated Drive uc?export URLs to thumbnail format
    const fixUrl = (url) => {
      if (!url) return url;
      const m = url.match(/drive\.google\.com\/(?:uc\?export=view&id=|thumbnail\?id=)([a-zA-Z0-9_-]+)/);
      return m ? `https://lh3.googleusercontent.com/d/${m[1]}=w2000` : url;
    };
    const listing = rows[0];
    if (listing.images) listing.images = listing.images.map(fixUrl);
    if (listing.floor_plan_image) listing.floor_plan_image = fixUrl(listing.floor_plan_image);

    res.render('admin/listing-form', {
      listing,
      bookings: bookings,
      adminName: req.session.adminName,
      error: null
    });
  } catch (err) {
    console.error('Edit listing error:', err);
    res.redirect('/admin/dashboard');
  }
});

router.post('/listings/:id', requireAdmin, upload.fields([{ name: 'image_files', maxCount: 10 }, { name: 'floor_plan_file', maxCount: 1 }]), async (req, res) => {
  const {
    title, location, neighborhood, city, state, bedrooms, bathrooms,
    sqft, price_monthly, status, available_from, available_to,
    description, amenities, amenities_custom, featured, sort_order, existing_images,
    floor, min_stay, pet_policy, smoking_allowed, events_allowed,
    building_amenities_list, building_amenities_custom, highlights, video_url, bed_type, address, transit,
    floor_plan_image, image_order, location_description, show_booking, property_type
  } = req.body;

  try {
    // Combine checked amenities with custom ones
    const checkedAmenities = amenities ? (Array.isArray(amenities) ? amenities : [amenities]) : [];
    const customAmenitiesList = amenities_custom ? amenities_custom.split(',').map(s => s.trim()).filter(Boolean) : [];
    const amenitiesArr = checkedAmenities.concat(customAmenitiesList);

    const checkedBuildingAmenities = building_amenities_list ? (Array.isArray(building_amenities_list) ? building_amenities_list : [building_amenities_list]) : [];
    const customBuildingAmenitiesList = building_amenities_custom ? building_amenities_custom.split(',').map(s => s.trim()).filter(Boolean) : [];
    const buildingAmenitiesArr = checkedBuildingAmenities.concat(customBuildingAmenitiesList);

    // Build ordered images array using image_order from drag-and-drop
    const imageFiles = req.files && req.files['image_files'] ? req.files['image_files'] : [];
    const urlImages = existing_images ? (Array.isArray(existing_images) ? existing_images : [existing_images]).filter(Boolean) : [];
    const newUploads = await Promise.all(imageFiles.map(f => storeImage(f)));
    let imagesArr = [];

    // Handle floor plan file upload
    const floorPlanFiles = req.files && req.files['floor_plan_file'] ? req.files['floor_plan_file'] : [];
    let finalFloorPlan = floor_plan_image || null;
    if (floorPlanFiles.length > 0) {
      finalFloorPlan = await storeImage(floorPlanFiles[0]);
    }

    if (image_order) {
      try {
        const order = JSON.parse(image_order);
        order.forEach(function(identifier) {
          if (typeof identifier === 'string' && identifier.startsWith('file:')) {
            const fileIndex = parseInt(identifier.split(':')[1], 10);
            if (newUploads[fileIndex]) imagesArr.push(newUploads[fileIndex]);
          } else if (typeof identifier === 'string' && identifier.length > 0) {
            if (urlImages.includes(identifier)) imagesArr.push(identifier);
          }
        });
      } catch (e) {
        console.error('image_order parse error:', e);
        imagesArr = urlImages.concat(newUploads);
      }
    } else {
      imagesArr = urlImages.concat(newUploads);
    }

    await pool.query(`
      UPDATE listings SET
        title = $1, location = $2, neighborhood = $3, city = $4, state = $5,
        bedrooms = $6, bathrooms = $7, sqft = $8, price_monthly = $9,
        status = $10, available_from = $11, available_to = $12,
        description = $13, amenities = $14, images = $15,
        featured = $16, sort_order = $17,
        floor = $18, min_stay = $19, pet_policy = $20,
        smoking_allowed = $21, events_allowed = $22,
        building_amenities = $23, highlights = $24,
        video_url = $25, bed_type = $26, address = $27, transit = $28,
        floor_plan_image = $29, location_description = $30,
        show_booking = $31, property_type = $32,
        updated_at = NOW()
      WHERE id = $33
    `, [
      title, location || 'New York', neighborhood, city, state || 'NY',
      parseInt(bedrooms) || 0, parseFloat(bathrooms) || 1,
      sqft ? parseInt(sqft) : null, parseInt(price_monthly),
      status || 'coming_soon',
      available_from || null, available_to || null,
      description || null, amenitiesArr, imagesArr,
      featured === 'on' || featured === 'true', parseInt(sort_order) || 0,
      floor || null, min_stay ? parseInt(min_stay) : 30,
      pet_policy || null,
      smoking_allowed === 'on' || smoking_allowed === 'true',
      events_allowed === 'on' || events_allowed === 'true',
      buildingAmenitiesArr, highlights || null, video_url || null,
      bed_type || null, address || null, transit || null,
      finalFloorPlan, location_description || null,
      show_booking === 'on' || show_booking === 'true',
      property_type || null,
      req.params.id
    ]);

    res.redirect('/admin/dashboard?success=Listing updated successfully');
  } catch (err) {
    console.error('Update listing error:', err);
    const { rows } = await pool.query('SELECT * FROM listings WHERE id = $1', [req.params.id]);
    const { rows: bookings } = await pool.query(
      'SELECT * FROM bookings WHERE listing_id = $1 ORDER BY check_in ASC', [req.params.id]
    ).catch(() => ({ rows: [] }));
    res.render('admin/listing-form', {
      listing: rows[0] || req.body,
      bookings: bookings,
      adminName: req.session.adminName,
      error: 'Failed to update listing. Please try again.'
    });
  }
});

router.post('/listings/:id/delete', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM listings WHERE id = $1', [req.params.id]);
    res.redirect('/admin/dashboard?success=Listing deleted');
  } catch (err) {
    console.error('Delete listing error:', err);
    res.redirect('/admin/dashboard');
  }
});

// --- Applications Tab ---
router.get('/applications', requireAdmin, async (req, res) => {
  try {
    const { rows: applications } = await pool.query(
      'SELECT * FROM applications ORDER BY created_at DESC'
    );
    res.render('admin/applications', {
      applications,
      adminName: req.session.adminName
    });
  } catch (err) {
    console.error('Applications error:', err);
    res.render('admin/applications', { applications: [], adminName: req.session.adminName });
  }
});

router.post('/applications/:id/delete', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM applications WHERE id = $1', [req.params.id]);
    res.redirect('/admin/applications');
  } catch (err) {
    console.error('Delete application error:', err);
    res.redirect('/admin/applications');
  }
});

// --- Paid Applications Tab (tenant applications that paid the $20 fee) ---
router.get('/paid-applications', requireAdmin, async (req, res) => {
  try {
    const { rows: applications } = await pool.query(
      `SELECT * FROM tenant_applications
        WHERE payment_status = 'paid'
        ORDER BY paid_at DESC NULLS LAST, created_at DESC`
    );
    res.render('admin/paid-applications', { applications, adminName: req.session.adminName });
  } catch (err) {
    console.error('Paid applications error:', err);
    res.render('admin/paid-applications', { applications: [], adminName: req.session.adminName });
  }
});

// Stream a fresh, short-lived signed URL for an applicant's photo ID. The browser
// follows the redirect to view it; the raw private path never reaches the client.
router.get('/paid-applications/:id/id/:side', requireAdmin, async (req, res) => {
  try {
    const { id, side } = req.params;
    if (!['front', 'back'].includes(side)) return res.status(400).send('Invalid side');
    const { rows } = await pool.query('SELECT answers FROM tenant_applications WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).send('Application not found');
    const objectPath = rows[0].answers && rows[0].answers['id_' + side + '_path'];
    if (!objectPath) return res.status(404).send('No ID on file');
    const url = await signedPrivateUrl(objectPath, 300); // 5-minute link
    if (!url) return res.status(404).send('ID unavailable');
    res.redirect(url);
  } catch (err) {
    console.error('ID view error:', err);
    res.status(500).send('Could not load ID');
  }
});

router.post('/paid-applications/:id/delete', requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM tenant_applications WHERE id = $1`, [req.params.id]);
    res.redirect('/admin/paid-applications');
  } catch (err) {
    console.error('Delete paid application error:', err);
    res.redirect('/admin/paid-applications');
  }
});

// --- Landlord Inquiries Tab ---
router.get('/landlord-inquiries', requireAdmin, async (req, res) => {
  try {
    const { rows: inquiries } = await pool.query(
      'SELECT * FROM landlord_inquiries ORDER BY created_at DESC'
    );
    res.render('admin/landlord-inquiries', {
      inquiries,
      adminName: req.session.adminName
    });
  } catch (err) {
    console.error('Landlord inquiries error:', err);
    res.render('admin/landlord-inquiries', { inquiries: [], adminName: req.session.adminName });
  }
});

router.post('/landlord-inquiries/:id/delete', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM landlord_inquiries WHERE id = $1', [req.params.id]);
    res.redirect('/admin/landlord-inquiries');
  } catch (err) {
    console.error('Delete landlord inquiry error:', err);
    res.redirect('/admin/landlord-inquiries');
  }
});

// --- Bookings Tab ---
router.get('/bookings', requireAdmin, async (req, res) => {
  try {
    const { rows: bookings } = await pool.query(
      `SELECT b.*, l.title AS listing_title
       FROM bookings b
       LEFT JOIN listings l ON b.listing_id = l.id
       ORDER BY b.check_in DESC`
    );
    res.render('admin/bookings', {
      bookings,
      adminName: req.session.adminName
    });
  } catch (err) {
    console.error('Bookings error:', err);
    res.render('admin/bookings', { bookings: [], adminName: req.session.adminName });
  }
});

router.post('/bookings/:id/delete', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM bookings WHERE id = $1', [req.params.id]);
    res.redirect('/admin/bookings');
  } catch (err) {
    console.error('Delete booking error:', err);
    res.redirect('/admin/bookings');
  }
});

// --- Bookings (from listing edit form) ---
router.post('/listings/:id/bookings', requireAdmin, async (req, res) => {
  const { guest_name, check_in, check_out, notes } = req.body;
  try {
    await pool.query(
      'INSERT INTO bookings (listing_id, guest_name, check_in, check_out, notes) VALUES ($1, $2, $3, $4, $5)',
      [req.params.id, guest_name || null, check_in, check_out, notes || null]
    );
    res.redirect('/admin/listings/' + req.params.id + '/edit?success=Booking added');
  } catch (err) {
    console.error('Add booking error:', err);
    res.redirect('/admin/listings/' + req.params.id + '/edit');
  }
});

router.post('/listings/:id/bookings/:bookingId/delete', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM bookings WHERE id = $1 AND listing_id = $2', [req.params.bookingId, req.params.id]);
    res.redirect('/admin/listings/' + req.params.id + '/edit?success=Booking removed');
  } catch (err) {
    console.error('Delete booking error:', err);
    res.redirect('/admin/listings/' + req.params.id + '/edit');
  }
});

// --- Google Drive Folder API ---
router.get('/api/drive-folder/:folderId', requireAdmin, async (req, res) => {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return res.json({ error: 'Google API key not configured. Add GOOGLE_API_KEY to your environment variables.' });
  }

  const folderId = req.params.folderId;
  const https = require('https');
  const apiUrl = `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+mimeType+contains+'image'&key=${apiKey}&fields=files(id,name,mimeType)&pageSize=50`;

  https.get(apiUrl, (apiRes) => {
    let body = '';
    apiRes.on('data', chunk => body += chunk);
    apiRes.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.error) {
          return res.json({ error: data.error.message || 'Failed to fetch folder contents.' });
        }
        const images = (data.files || []).map(file => ({
          id: file.id,
          name: file.name,
          url: 'https://lh3.googleusercontent.com/d/' + file.id + '=w2000'
        }));
        res.json({ images });
      } catch (e) {
        res.json({ error: 'Failed to parse folder contents.' });
      }
    });
  }).on('error', (err) => {
    console.error('Drive folder error:', err);
    res.json({ error: 'Failed to fetch folder contents.' });
  });
});

module.exports = router;
