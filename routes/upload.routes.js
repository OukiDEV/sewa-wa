const router = require('express').Router();
const { authenticateToken, requireAdmin } = require('../middleware/auth.middleware');
const upload = require('../config/multer');

router.post('/image', authenticateToken, requireAdmin, upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'File tidak valid atau terlalu besar (max 5MB)' });
    res.json({ success: true, imageUrl: `/uploads/${req.file.filename}` });
});

module.exports = router;
