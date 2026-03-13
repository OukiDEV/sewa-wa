require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();

// ── Middleware global ──────────────────────────────
app.use(cors());
app.use(express.json());
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
app.use('/api/admin', require('./routes/admin.routes'));

// ── Boot ──────────────────────────────────────────
const { restoreSessions } = require('./services/whatsapp.service');
const { initSettingsTable } = require('./services/settings.service');

initSettingsTable().catch(console.error);
restoreSessions();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Server] http://localhost:${PORT}`));