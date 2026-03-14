require('dotenv').config();
const mysql = require('mysql2');

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    ssl: {
        rejectUnauthorized: false
    }
});

pool.getConnection((err, connection) => {
    if (err) {
        console.error('[DB] Gagal koneksi:', err.message);
    } else {
        console.log('[DB] Berhasil terhubung ke MySQL lokal!');
        connection.release();
    }
});

module.exports = pool.promise();