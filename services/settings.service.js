const mysql = require('../db');

async function initSettingsTable() {
    await mysql.query(`
        CREATE TABLE IF NOT EXISTS global_settings (
            \`key\` VARCHAR(100) PRIMARY KEY,
            \`value\` TEXT NOT NULL,
            updated_at DATETIME DEFAULT NOW() ON UPDATE NOW()
        )
    `);
    await mysql.query("INSERT IGNORE INTO global_settings (`key`, `value`) VALUES ('min_withdraw', '10000')");
    await mysql.query("INSERT IGNORE INTO global_settings (`key`, `value`) VALUES ('price_per_msg', '800')");
    await mysql.query("INSERT IGNORE INTO global_settings (`key`, `value`) VALUES ('wa_support', '')");
    await mysql.query("INSERT IGNORE INTO global_settings (`key`, `value`) VALUES ('maintenance_mode', '0')");
}

async function getSetting(key, defaultVal = null) {
    try {
        const [rows] = await mysql.query("SELECT `value` FROM global_settings WHERE `key` = ?", [key]);
        return rows[0] ? rows[0].value : defaultVal;
    } catch {
        return defaultVal;
    }
}

module.exports = { initSettingsTable, getSetting };