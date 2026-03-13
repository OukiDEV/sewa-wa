const router = require('express').Router();
const { authenticateToken } = require('../middleware/auth.middleware');
const { connect, getStatus, logout, blast, getPairingCode, stopBlast } = require('../controllers/wa.controller');

router.get('/connect', authenticateToken, connect);
router.get('/status', authenticateToken, getStatus);
router.post('/logout', authenticateToken, logout);
router.post('/blast', authenticateToken, blast);
router.post('/pairing-code', authenticateToken, getPairingCode);
router.post('/stop-blast', authenticateToken, stopBlast);

module.exports = router;