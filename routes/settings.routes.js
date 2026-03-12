const router = require('express').Router();
const { authenticateToken } = require('../middleware/auth.middleware');
const mysql = require('../db');

// Public settings — bisa diakses semua user (bukan hanya admin)
router.get('/', authenticateToken, async (req, res) => {
    try {
        const [rows] = await mysql.query(
            "SELECT `key`, `value` FROM global_settings WHERE `key` IN ('price_per_msg', 'min_withdraw', 'wa_support')"
        );
        const result = {};
        rows.forEach(r => result[r.key] = r.value);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;