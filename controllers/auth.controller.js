const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const mysql = require('../db');

const register = async (req, res) => {
    const { username, password } = req.body;
    try {
        const [existing] = await mysql.query(`SELECT id FROM users WHERE username = ?`, [username]);
        if (existing.length > 0) return res.status(400).json({ success: false, message: 'Username sudah dipakai!' });
        const hash = await bcrypt.hash(password, 10);
        await mysql.query(`INSERT INTO users (username, password, balance, role) VALUES (?, ?, 0, 'user')`, [username, hash]);
        res.json({ success: true, message: 'Berhasil daftar!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Error: ' + err.code });
    }
};

const login = async (req, res) => {
    const { username, password } = req.body;
    try {
        const [rows] = await mysql.query(`SELECT * FROM users WHERE username = ?`, [username]);
        const user = rows[0];
        if (!user) return res.status(404).json({ message: 'User tidak ditemukan' });
        if (!await bcrypt.compare(password, user.password)) return res.status(401).json({ message: 'Password salah!' });
        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '1d' }
        );
        res.json({ success: true, token, role: user.role });
    } catch (err) {
        res.status(500).send('Login Error');
    }
};

module.exports = { register, login };
