const mysql = require('../db');

const getUsersOnline = async (req, res) => {
    try {
        await mysql.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active DATETIME DEFAULT NULL`).catch(() => { });
        const [rows] = await mysql.query(
            'SELECT COUNT(*) as total FROM users WHERE last_active >= NOW() - INTERVAL 15 MINUTE'
        );
        const [detail] = await mysql.query(
            'SELECT id, username, role, last_active FROM users WHERE last_active >= NOW() - INTERVAL 15 MINUTE ORDER BY last_active DESC'
        );
        res.json({ count: rows[0].total, users: detail });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const getAllUsers = async (req, res) => {
    try {
        await mysql.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS rate INT DEFAULT 800`).catch(() => { });
        await mysql.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS banned TINYINT(1) DEFAULT 0`).catch(() => { });
        const [rows] = await mysql.query(
            'SELECT id, username, balance, role, COALESCE(banned,0) as banned, COALESCE(rate, 800) as rate FROM users ORDER BY id ASC'
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const getUsersBalance = async (req, res) => {
    try {
        const [rows] = await mysql.query(`
            SELECT u.id, u.username, u.balance,
                   COUNT(c.id) as sent_count
            FROM users u
            LEFT JOIN contacts c ON c.user_id = u.id AND c.status = 'sent'
            GROUP BY u.id ORDER BY u.balance DESC
        `);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const updateUserRate = async (req, res) => {
    const { rate } = req.body;
    try {
        await mysql.query(`UPDATE users SET rate = ? WHERE id = ?`, [rate, req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const toggleBanUser = async (req, res) => {
    try {
        await mysql.query(`UPDATE users SET banned = NOT banned WHERE id = ?`, [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const resetUserBalance = async (req, res) => {
    try {
        await mysql.query(`UPDATE users SET balance = 0 WHERE id = ?`, [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const getAllSessions = async (req, res) => {
    try {
        const { sessionStats, sessions } = require('../services/whatsapp.service');
        const { activeBlasts } = require('./wa.controller');

        const [rows] = await mysql.query(`
            SELECT ws.*, u.username,
                (SELECT COUNT(*) FROM contacts c WHERE c.user_id = ws.user_id AND c.status = 'sent') as total_sent_db,
                (SELECT COUNT(*) FROM contacts c WHERE c.status = 'pending') as total_pending_db,
                (SELECT COUNT(*) FROM contacts c WHERE c.user_id = ws.user_id AND c.status = 'failed') as total_failed_db
            FROM wa_sessions ws
            JOIN users u ON ws.user_id = u.id
            ORDER BY ws.status DESC, ws.id DESC
        `);

        const enriched = rows.map(s => ({
            ...s,
            // Real-time stats dari memory (lebih akurat saat blast berlangsung)
            realtime_sent: sessionStats[s.session_id]?.sent ?? Number(s.sent_count) ?? 0,
            realtime_failed: sessionStats[s.session_id]?.failed ?? 0,
            realtime_pending: s.total_pending_db,
            is_blasting: activeBlasts.has(s.session_id),
            is_online: !!sessions[s.session_id]?._ready
        }));

        res.json(enriched);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const getSettings = async (req, res) => {
    try {
        const [rows] = await mysql.query("SELECT `key`, `value` FROM global_settings");
        const result = {};
        rows.forEach(r => result[r.key] = r.value);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const updateSettings = async (req, res) => {
    const { min_withdraw, price_per_msg, wa_support, maintenance_mode } = req.body;
    try {
        const updates = { min_withdraw, price_per_msg, wa_support, maintenance_mode };
        for (const [key, val] of Object.entries(updates)) {
            if (val !== undefined && val !== null) {
                await mysql.query(
                    'INSERT INTO global_settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?',
                    [key, String(val), String(val)]
                );
            }
        }
        res.json({ success: true, message: 'Pengaturan global berhasil disimpan!' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
};

module.exports = {
    getUsersOnline, getAllUsers, getUsersBalance, updateUserRate, toggleBanUser,
    resetUserBalance, getAllSessions, getSettings, updateSettings
};