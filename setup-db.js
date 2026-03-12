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
        ca: fs.readFileSync(path.join(__dirname, 'ca.pem')),
        rejectUnauthorized: false
    }
});

const db = pool.promise();

async function setupDatabase() {
    console.log('🔧 Membuat tabel...');

    await db.query(`CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        balance BIGINT DEFAULT 0,
        role ENUM('admin','user') DEFAULT 'user',
        rate INT DEFAULT 800,
        banned TINYINT(1) DEFAULT 0,
        last_active DATETIME DEFAULT NULL,
        created_at DATETIME DEFAULT NOW()
    )`);
    console.log('✅ Tabel users');

    await db.query(`CREATE TABLE IF NOT EXISTS wa_sessions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        session_id VARCHAR(255) NOT NULL,
        phone_number VARCHAR(50),
        status VARCHAR(50) DEFAULT 'connecting',
        sent_count INT DEFAULT 0,
        created_at DATETIME DEFAULT NOW()
    )`);
    console.log('✅ Tabel wa_sessions');

    await db.query(`CREATE TABLE IF NOT EXISTS contacts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        name VARCHAR(255),
        phone VARCHAR(50),
        role VARCHAR(50),
        status ENUM('pending','sent','failed') DEFAULT 'pending',
        session_used VARCHAR(255),
        sent_at DATETIME,
        created_at DATETIME DEFAULT NOW()
    )`);
    console.log('✅ Tabel contacts');

    await db.query(`CREATE TABLE IF NOT EXISTS templates (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT,
        title VARCHAR(255),
        content TEXT,
        image_url VARCHAR(500),
        button_label VARCHAR(255),
        button_url VARCHAR(500),
        buttons_json TEXT,
        is_active TINYINT(1) DEFAULT 0,
        created_at DATETIME DEFAULT NOW()
    )`);
    console.log('✅ Tabel templates');

    await db.query(`CREATE TABLE IF NOT EXISTS withdrawals (
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
    )`);
    console.log('✅ Tabel withdrawals');

    await db.query(`CREATE TABLE IF NOT EXISTS global_settings (
        \`key\` VARCHAR(100) PRIMARY KEY,
        \`value\` TEXT NOT NULL,
        updated_at DATETIME DEFAULT NOW() ON UPDATE NOW()
    )`);
    console.log('✅ Tabel global_settings');

    // Index untuk performa
    await db.query(`ALTER TABLE contacts ADD INDEX IF NOT EXISTS idx_status (status)`).catch(() => { });
    await db.query(`ALTER TABLE contacts ADD INDEX IF NOT EXISTS idx_user_id (user_id)`).catch(() => { });
    console.log('✅ Index contacts');

    console.log('\n🎉 Semua tabel berhasil dibuat!');
    process.exit(0);
}

setupDatabase().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});