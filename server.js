const express = require('express');
const cors = require('cors');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Pastikan folder uploads ada
const uploadDir = './public/uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Services init
const { initSettingsTable } = require('./services/settings.service');
const { restoreSessions } = require('./services/whatsapp.service');

// Routes
app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/user', require('./routes/user.routes'));
app.use('/api/wa', require('./routes/wa.routes'));
app.use('/api/contacts', require('./routes/contact.routes'));
app.use('/api/templates', require('./routes/template.routes'));
app.use('/api/upload', require('./routes/upload.routes'));
app.use('/api/withdrawal', require('./routes/withdrawal.routes'));
app.use('/api/admin', require('./routes/admin.routes'));
app.use('/api/settings', require('./routes/settings.routes'));

// Init DB settings & restore sessions WA
initSettingsTable().catch(console.error);
restoreSessions();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Server] http://localhost:${PORT}`));