const router = require('express').Router();
const { authenticateToken } = require('../middleware/auth.middleware');
const { requestWithdrawal, getHistory } = require('../controllers/withdrawal.controller');

router.post('/request', authenticateToken, requestWithdrawal);
router.get('/history',  authenticateToken, getHistory);

module.exports = router;
