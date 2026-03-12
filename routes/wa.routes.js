const router = require('express').Router();
const { authenticateToken } = require('../middleware/auth.middleware');
const { connect, getStatus, logout, blast } = require('../controllers/wa.controller');

router.get('/connect',  authenticateToken, connect);
router.get('/status',   authenticateToken, getStatus);
router.post('/logout',  authenticateToken, logout);
router.post('/blast',   authenticateToken, blast);

module.exports = router;
