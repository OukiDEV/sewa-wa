require('dotenv').config();
const mysql = require('mysql2');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { ca: fs.readFileSync(path.join(__dirname, 'ca.pem')), rejectUnauthorized: false }
}).promise();

async function createAdmin() {
    const hash = await bcrypt.hash('admin123', 10);
    await pool.query(
        "INSERT INTO users (username, password, role) VALUES (?, ?, 'admin') ON DUPLICATE KEY UPDATE role='admin', password=?",
        ['admin', hash, hash]
    );
    console.log('✅ Admin dibuat! user: admin | pass: admin123');
    process.exit(0);
}

createAdmin().catch(err => { console.error('❌', err.message); process.exit(1); });
