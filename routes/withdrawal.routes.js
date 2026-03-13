const router = require('express').Router();
const { authenticateToken, requireAdmin } = require('../middleware/auth.middleware');
const { requestWithdrawal, getHistory, getAllWithdrawals, approveWithdrawal, rejectWithdrawal, getWithdrawalStats } = require('../controllers/withdrawal.controller');

router.post('/request', authenticateToken, requestWithdrawal);
router.get('/history',  authenticateToken, getHistory);

module.exports = router;
