require('dotenv').config();
const mysql = require('mysql2');
const fs = require('fs');

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { ca: fs.readFileSync('ca.pem'), rejectUnauthorized: false }
});

const db = pool.promise();

async function fix() {
    try {
        await db.query("ALTER TABLE wa_sessions MODIFY status VARCHAR(50) DEFAULT 'connecting'");
        console.log('✅ Fix wa_sessions berhasil!');

        // Tambahan fix untuk lalu lintas pesan
        await db.query("ALTER TABLE contacts ADD COLUMN IF NOT EXISTS sent_at DATETIME DEFAULT NULL");
        console.log('✅ Fix kolom sent_at berhasil!');

    } catch (err) {
        console.error('❌ Error:', err.message);
    }
    process.exit(0);
}

fix();