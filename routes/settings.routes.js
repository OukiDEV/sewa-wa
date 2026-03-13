const router = require('express').Router();
const { authenticateToken } = require('../middleware/auth.middleware');
const { getSettings } = require('../controllers/admin.controller');

// Public settings — bisa diakses semua user yang login (bukan admin only)
// Dipakai oleh index.html untuk load price_per_msg & min_withdraw
router.get('/', authenticateToken, getSettings);

module.exports = router;