require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();

// ── Middleware global ──────────────────────────────
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.static('public'));

// ── Upload dir init ───────────────────────────────
const uploadDir = './public/uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// ── Routes ────────────────────────────────────────
app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/user', require('./routes/user.routes'));
app.use('/api/wa', require('./routes/wa.routes'));
app.use('/api/contacts', require('./routes/contact.routes'));
app.use('/api/contacts-all', require('./routes/contact.routes')); // alias DELETE / → deleteAll
app.use('/api/templates', require('./routes/template.routes'));
app.use('/api/upload', require('./routes/upload.routes'));
app.use('/api/withdrawal', require('./routes/withdrawal.routes'));
app.use('/api/settings', require('./routes/settings.routes'));  // public settings untuk user
app.use('/api/admin', require('./routes/admin.routes'));

// ── Boot ──────────────────────────────────────────
const mysql = require('./db');
const { restoreSessions } = require('./services/whatsapp.service');
const { initSettingsTable } = require('./services/settings.service');

initSettingsTable().catch(console.error);

// Auto release semua lock saat server start — jaga-jaga kalau restart saat blast
mysql.query(`UPDATE contacts SET locked_by = NULL WHERE status = 'pending' AND locked_by IS NOT NULL`)
    .then(() => console.log('[DB] Lock contacts direset'))
    .catch(console.error);

restoreSessions();

// Auto flush PM2 logs setiap 2000 baris log
const { execSync } = require('child_process');
let logLineCount = 0;
const origLog = console.log;
const origError = console.error;
function checkFlush() {
    logLineCount++;
    if (logLineCount >= 2000) {
        try { execSync('pm2 flush sewa-wa'); } catch (e) { }
        logLineCount = 0;
        origLog('[Log] Auto flush — log direset (2000 baris)');
    }
}
console.log = function (...args) { origLog(...args); checkFlush(); };
console.error = function (...args) { origError(...args); checkFlush(); };

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Server] http://localhost:${PORT}`));