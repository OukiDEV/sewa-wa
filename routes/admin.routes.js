const router = require('express').Router();
const { authenticateToken, requireAdmin } = require('../middleware/auth.middleware');
const {
    getUsersOnline, getAllUsers, getUsersBalance,
    updateUserRate, toggleBan, resetBalance,
    getAllSessions, getSettings, updateSettings
} = require('../controllers/admin.controller');
const {
    getAllWithdrawals, approveWithdrawal, rejectWithdrawal, getWithdrawalStats
} = require('../controllers/withdrawal.controller');

const guard = [authenticateToken, requireAdmin];

// Users
router.get('/users-online',            ...guard, getUsersOnline);
router.get('/users',                   ...guard, getAllUsers);
router.get('/users-balance',           ...guard, getUsersBalance);
router.post('/users/:id/rate',         ...guard, updateUserRate);
router.post('/users/:id/ban',          ...guard, toggleBan);
router.post('/users/:id/reset-balance',...guard, resetBalance);

// Sessions
router.get('/all-sessions',            ...guard, getAllSessions);

// Settings
router.get('/settings',                ...guard, getSettings);
router.post('/settings',               ...guard, updateSettings);

// Withdrawals
router.get('/withdrawals',             ...guard, getAllWithdrawals);
router.get('/withdrawals/stats',       ...guard, getWithdrawalStats);
router.post('/withdrawals/:id/approve',...guard, approveWithdrawal);
router.post('/withdrawals/:id/reject', ...guard, rejectWithdrawal);

module.exports = router;
