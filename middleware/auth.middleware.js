const jwt = require('jsonwebtoken');
const mysql = require('../db');

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.sendStatus(401);

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        // Update last_active setiap request terautentikasi
        mysql.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active DATETIME DEFAULT NULL`).catch(() => { });
        mysql.query(`UPDATE users SET last_active = NOW() WHERE id = ?`, [user.id]).catch(() => { });
        next();
    });
};

const requireAdmin = (req, res, next) => {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' });
    next();
};

module.exports = { authenticateToken, requireAdmin };