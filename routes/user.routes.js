const router = require('express').Router();
const { authenticateToken } = require('../middleware/auth.middleware');
const { getProfile } = require('../controllers/user.controller');

router.get('/profile', authenticateToken, getProfile);

module.exports = router;
