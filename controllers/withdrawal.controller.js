const mysql = require('../db');
const { getSetting } = require('../services/settings.service');

const WITHDRAWAL_TABLE = `
    CREATE TABLE IF NOT EXISTS withdrawals (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        amount BIGINT NOT NULL,
        bank_name VARCHAR(100) NOT NULL,
        account_number VARCHAR(100) NOT NULL,
        account_name VARCHAR(100) NOT NULL,
        status ENUM('pending','approved','rejected') DEFAULT 'pending',
        admin_note TEXT,
        created_at DATETIME DEFAULT NOW(),
        updated_at DATETIME DEFAULT NOW() ON UPDATE NOW()
    )
`;

const requestWithdrawal = async (req, res) => {
    const { amount, bank_name, account_number, account_name } = req.body;
    const userId = req.user.id;
    try {
        const MIN_WITHDRAW = parseInt(await getSetting('min_withdraw', '10000')) || 10000;
        if (!amount || !bank_name || !account_number || !account_name)
            return res.status(400).json({ success: false, message: 'Semua field wajib diisi!' });
        if (amount < MIN_WITHDRAW)
            return res.status(400).json({ success: false, message: `Minimal withdrawal Rp ${MIN_WITHDRAW.toLocaleString('id-ID')}!` });

        const [userRows] = await mysql.query(`SELECT balance FROM users WHERE id = ?`, [userId]);
        if (!userRows[0] || userRows[0].balance < amount)
            return res.status(400).json({ success: false, message: 'Saldo tidak mencukupi!' });

        const [pendingRows] = await mysql.query(
            `SELECT id FROM withdrawals WHERE user_id = ? AND status = 'pending'`, [userId]
        );
        if (pendingRows.length > 0)
            return res.status(400).json({ success: false, message: 'Kamu masih punya withdrawal yang belum diproses!' });

        await mysql.query(WITHDRAWAL_TABLE);
        await mysql.query(`UPDATE users SET balance = balance - ? WHERE id = ?`, [amount, userId]);
        const [result] = await mysql.query(
            'INSERT INTO withdrawals (user_id, amount, bank_name, account_number, account_name) VALUES (?, ?, ?, ?, ?)',
            [userId, amount, bank_name, account_number, account_name]
        );
        res.json({ success: true, message: 'Permintaan withdrawal berhasil dikirim!', id: result.insertId });
    } catch (err) {
        console.error('[Withdrawal] Error:', err);
        res.status(500).json({ success: false, message: 'Gagal mengajukan withdrawal' });
    }
};

const getHistory = async (req, res) => {
    try {
        await mysql.query(WITHDRAWAL_TABLE);
        const [rows] = await mysql.query(
            'SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC',
            [req.user.id]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// Admin actions
const getAllWithdrawals = async (req, res) => {
    const status = req.query.status || 'all';
    try {
        await mysql.query(WITHDRAWAL_TABLE);
        let rows;
        if (status !== 'all') {
            [rows] = await mysql.query(
                'SELECT w.*, u.username FROM withdrawals w JOIN users u ON w.user_id = u.id WHERE w.status = ? ORDER BY w.created_at DESC',
                [status]
            );
        } else {
            [rows] = await mysql.query(
                'SELECT w.*, u.username FROM withdrawals w JOIN users u ON w.user_id = u.id ORDER BY w.created_at DESC'
            );
        }
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const approveWithdrawal = async (req, res) => {
    const { admin_note } = req.body;
    try {
        const [rows] = await mysql.query(`SELECT * FROM withdrawals WHERE id = ?`, [req.params.id]);
        if (!rows[0]) return res.status(404).json({ success: false, message: 'Tidak ditemukan' });
        if (rows[0].status !== 'pending') return res.status(400).json({ success: false, message: 'Sudah diproses!' });
        await mysql.query(
            `UPDATE withdrawals SET status = 'approved', admin_note = ? WHERE id = ?`,
            [admin_note || null, req.params.id]
        );
        res.json({ success: true, message: 'Withdrawal disetujui!' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

const rejectWithdrawal = async (req, res) => {
    const { admin_note } = req.body;
    try {
        const [rows] = await mysql.query(`SELECT * FROM withdrawals WHERE id = ?`, [req.params.id]);
        if (!rows[0]) return res.status(404).json({ success: false, message: 'Tidak ditemukan' });
        if (rows[0].status !== 'pending') return res.status(400).json({ success: false, message: 'Sudah diproses!' });
        await mysql.query(`UPDATE users SET balance = balance + ? WHERE id = ?`, [rows[0].amount, rows[0].user_id]);
        await mysql.query(
            `UPDATE withdrawals SET status = 'rejected', admin_note = ? WHERE id = ?`,
            [admin_note || null, req.params.id]
        );
        res.json({ success: true, message: 'Withdrawal ditolak & saldo dikembalikan!' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

const getWithdrawalStats = async (req, res) => {
    try {
        const [pending] = await mysql.query(`SELECT COUNT(*) as c, COALESCE(SUM(amount),0) as total FROM withdrawals WHERE status='pending'`);
        const [approved] = await mysql.query(`SELECT COUNT(*) as c, COALESCE(SUM(amount),0) as total FROM withdrawals WHERE status='approved'`);
        const [rejected] = await mysql.query(`SELECT COUNT(*) as c FROM withdrawals WHERE status='rejected'`);
        res.json({
            pending: { count: pending[0].c, total: pending[0].total },
            approved: { count: approved[0].c, total: approved[0].total },
            rejected: { count: rejected[0].c }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

module.exports = { requestWithdrawal, getHistory, getAllWithdrawals, approveWithdrawal, rejectWithdrawal, getWithdrawalStats };
