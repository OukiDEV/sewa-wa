const router = require('express').Router();
const { authenticateToken, requireAdmin } = require('../middleware/auth.middleware');
const {
    getUsersOnline, getAllUsers, getUsersBalance, updateUserRate,
    toggleBanUser, resetUserBalance, getAllSessions,
    getSettings, updateSettings
} = require('../controllers/admin.controller');
const {
    getAllWithdrawals, approveWithdrawal, rejectWithdrawal, getWithdrawalStats
} = require('../controllers/withdrawal.controller');

// User management
router.get('/users-online',              authenticateToken, requireAdmin, getUsersOnline);
router.get('/users',                     authenticateToken, requireAdmin, getAllUsers);
router.get('/users-balance',             authenticateToken, requireAdmin, getUsersBalance);
router.post('/users/:id/rate',           authenticateToken, requireAdmin, updateUserRate);
router.post('/users/:id/ban',            authenticateToken, requireAdmin, toggleBanUser);
router.post('/users/:id/reset-balance',  authenticateToken, requireAdmin, resetUserBalance);

// Sessions
router.get('/all-sessions',              authenticateToken, requireAdmin, getAllSessions);

// Settings
router.get('/settings',                  authenticateToken, requireAdmin, getSettings);
router.post('/settings',                 authenticateToken, requireAdmin, updateSettings);

// Withdrawals
router.get('/withdrawals',               authenticateToken, requireAdmin, getAllWithdrawals);
router.get('/withdrawals/stats',         authenticateToken, requireAdmin, getWithdrawalStats);
router.post('/withdrawals/:id/approve',  authenticateToken, requireAdmin, approveWithdrawal);
router.post('/withdrawals/:id/reject',   authenticateToken, requireAdmin, rejectWithdrawal);

module.exports = router;
