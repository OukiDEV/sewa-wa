const mysql = require('../db');

const getProfile = async (req, res) => {
    const [rows] = await mysql.query(`SELECT username, balance, role FROM users WHERE id = ?`, [req.user.id]);
    res.json(rows[0]);
};

module.exports = { getProfile };
