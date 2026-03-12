require('dotenv').config();
const mysql = require('mysql2');
const fs = require('fs');
const path = require('path');

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: {
        ca: fs.existsSync(path.join(__dirname, 'ca.pem'))
            ? fs.readFileSync(path.join(__dirname, 'ca.pem'))
            : undefined,
        rejectUnauthorized: true
    },
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Test koneksi saat startup
pool.getConnection((err, connection) => {
    if (err) {
        console.error('[DB] Gagal koneksi ke Aiven MySQL:', err.message);
    } else {
        console.log('[DB] Berhasil terhubung ke Aiven MySQL!');
        connection.release();
    }
});

module.exports = pool.promise();