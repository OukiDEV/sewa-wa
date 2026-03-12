const express = require('express');
const mysql = require('./db');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    generateWAMessageFromContent,
    prepareWAMessageMedia,
    proto
} = require('@whiskeysockets/baileys');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const uploadDir = './public/uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, `tpl_${Date.now()}${path.extname(file.originalname).toLowerCase() || '.jpg'}`)
});
const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => cb(null, ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype))
});

const sessions = {};
const sessionStats = {};

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.sendStatus(401);
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        // Update last_active setiap request yang terautentikasi
        mysql.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active DATETIME DEFAULT NULL').catch(() => { });
        mysql.query('UPDATE users SET last_active = NOW() WHERE id = ?', [user.id]).catch(() => { });
        next();
    });
};

// API: hitung user online (aktif dalam 15 menit terakhir)
app.get('/api/admin/users-online', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' });
    try {
        await mysql.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active DATETIME DEFAULT NULL').catch(() => { });
        const [rows] = await mysql.query(
            'SELECT COUNT(*) as total FROM users WHERE last_active >= NOW() - INTERVAL 15 MINUTE'
        );
        const [detail] = await mysql.query(
            'SELECT id, username, role, last_active FROM users WHERE last_active >= NOW() - INTERVAL 15 MINUTE ORDER BY last_active DESC'
        );
        res.json({ count: rows[0].total, users: detail });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

async function startWhatsApp(userId, sessionId) {
    const sessionDir = `./sessions/${sessionId}`;
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
    if (!sessionStats[sessionId]) sessionStats[sessionId] = { sent: 0, failed: 0 };
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    try {
        const { version } = await fetchLatestBaileysVersion();
        const sock = makeWASocket({
            auth: state, version,
            browser: ['Sewa Badak', 'Chrome', '1.0.0'],
            printQRInTerminal: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 120000,
            keepAliveIntervalMs: 30000,
            syncFullHistory: false,
            generateHighQualityLinkPreview: false,
            markOnlineOnConnect: true,
            patchMessageBeforeSending: (message) => {
                const requiresPatch = !!(
                    message.buttonsMessage ||
                    message.templateMessage ||
                    message.listMessage ||
                    message.interactiveMessage   // <-- tambahkan ini
                );
                if (requiresPatch) {
                    message = {
                        viewOnceMessage: {
                            message: {
                                messageContextInfo: { deviceListMetadataVersion: 2, deviceListMetadata: {} },
                                ...message,
                            },
                        },
                    };
                }
                return message;
            }

        });
        sock._ready = false;
        sessions[sessionId] = sock;
        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', async (update) => {
            const { connection, qr, lastDisconnect } = update;
            if (qr) sessions[sessionId].qr = qr;
            if (connection === 'open') {
                const phone = sock.user.id.split(':')[0];
                sessions[sessionId].qr = null;
                sessions[sessionId]._ready = true;
                await mysql.query('UPDATE wa_sessions SET status = 'connected', phone_number = ? WHERE session_id = ?', [phone, sessionId]);
                console.log(`[✓] ${phone} terhubung`);
            }
            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) {
                    delete sessions[sessionId];
                    setTimeout(() => startWhatsApp(userId, sessionId), 5000);
                } else {
                    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
                    await mysql.query('DELETE FROM wa_sessions WHERE session_id = ?', [sessionId]);
                    delete sessions[sessionId];
                    delete sessionStats[sessionId];
                }
            }
        });
    } catch (err) { console.error('Baileys Error:', err); }
}

// ─────────────────────────────────────────────
// HELPER: Kirim interactive message
// Pakai sock.sendMessage — patchMessageBeforeSending handle wrapping otomatis
// ─────────────────────────────────────────────

async function sendInteractiveCarousel(sock, jid, { cards, bodyText = '', footerText = '' }) {
    // cards: [{ text, footer, image (Buffer|{url}), buttons:[{label,url}] atau buttonLabel/buttonUrl }]
    const carouselCards = await Promise.all(cards.map(async (c) => {
        let header = { hasMediaAttachment: false };
        if (c.image) {
            try {
                const m = await prepareWAMessageMedia({ image: c.image }, { upload: sock.waUploadToServer });
                header = { hasMediaAttachment: true, imageMessage: m.imageMessage };
            } catch (e) {
                console.warn('[Carousel] prepare media gagal:', e.message);
            }
        }
        // dukung buttons[] atau single buttonLabel/buttonUrl
        const rawBtns = (Array.isArray(c.buttons) && c.buttons.length)
            ? c.buttons.slice(0, 3)
            : (c.buttonLabel ? [{ label: c.buttonLabel, url: c.buttonUrl }] : []);
        const nativeFlowMessage = {
            buttons: rawBtns.map(b => ({
                name: 'cta_url',
                buttonParamsJson: JSON.stringify({
                    display_text: b.label || 'Open',
                    url: b.url || 'https://example.com'
                })
            }))
        };
        return {
            body: { text: c.text || ' ' },
            footer: { text: c.footer || '' },
            header,
            nativeFlowMessage
        };
    }));
    const msg = generateWAMessageFromContent(jid, {
        interactiveMessage: proto.Message.InteractiveMessage.create({
            body: { text: bodyText || ' ' },
            footer: { text: footerText || '' },
            carouselMessage: proto.Message.InteractiveMessage.CarouselMessage.create({
                cards: carouselCards
            })
        })
    }, {});
    await sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
    return msg;
}

// --- ubah sendTemplateMessage supaya pakai carousel ---
async function sendTemplateMessage(sock, jid, template, contactName) {
    const text = (template.content || '').replace(/\{nama\}/gi, contactName || '');
    const hasImage = template.image_url && template.image_url.trim() !== '';
    // Siapkan gambar
    let imgSrc = null;
    if (hasImage) {
        const localPath = `./public${template.image_url.trim()}`;
        imgSrc = (template.image_url.startsWith('/uploads/') && fs.existsSync(localPath))
            ? fs.readFileSync(localPath)
            : { url: template.image_url.trim() };
    }
    // Ambil daftar tombol: prioritas buttons_json, fallback ke button_label/url lama
    let btns = [];
    try {
        if (template.buttons_json) {
            const parsed = JSON.parse(template.buttons_json);
            if (Array.isArray(parsed)) btns = parsed.filter(b => b && b.label && b.url).slice(0, 3);
        }
    } catch { }
    if (btns.length === 0 && template.button_label && template.button_url) {
        btns = [{ label: template.button_label, url: template.button_url }];
    }
    if (btns.length > 0) {
        try {
            const cards = [{
                text,
                footer: template.title || '',
                buttons: btns, // kirim semua tombol (1–3)
                image: imgSrc
            }];
            const result = await sendInteractiveCarousel(sock, jid, {
                cards,
                bodyText: template.title || ' '
            });
            console.log(`[OK] Carousel terkirim, key: ${result?.key?.id}`);
            return;
        } catch (e) {
            console.error(`[Carousel GAGAL] ${e.message}`);
            console.error(e.stack);
        }
    }
    // Fallback teks
    const fallback = btns.length
        ? `${text}\n\n${btns.map(b => `*${b.label}*\n${b.url}`).join('\n\n')}`
        : text;
    if (hasImage && imgSrc) {
        await sock.sendMessage(jid, { image: imgSrc, caption: fallback, mimetype: 'image/jpeg' });
    } else {
        await sock.sendMessage(jid, { text: fallback });
    }
}



// AUTH
app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [existing] = await mysql.query('SELECT id FROM users WHERE username = ?', [username]);
        if (existing.length > 0) return res.status(400).json({ success: false, message: 'Username sudah dipakai!' });
        const hash = await bcrypt.hash(password, 10);
        await mysql.query('INSERT INTO users (username, password, balance, role) VALUES (?, ?, 0, 'user')', [username, hash]);
        res.json({ success: true, message: 'Berhasil daftar!' });
    } catch (err) { res.status(500).json({ success: false, message: 'Error: ' + err.code }); }
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [rows] = await mysql.query('SELECT * FROM users WHERE username = ?', [username]);
        const user = rows[0];
        if (!user) return res.status(404).json({ message: 'User tidak ditemukan' });
        if (!await bcrypt.compare(password, user.password)) return res.status(401).json({ message: 'Password salah!' });
        const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1d' });
        res.json({ success: true, token, role: user.role });
    } catch (err) { res.status(500).send('Login Error'); }
});

app.get('/api/user/profile', authenticateToken, async (req, res) => {
    const [rows] = await mysql.query('SELECT username, balance, role FROM users WHERE id = ?', [req.user.id]);
    res.json(rows[0]);
});

// WA ROUTES
app.get('/api/wa/connect', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    let sessionId = req.query.sid;
    if (!sessionId) {
        sessionId = `session_${userId}_${Date.now()}`;
        await mysql.query('INSERT INTO wa_sessions (user_id, session_id, status, sent_count) VALUES (?, ?, 'connecting', 0)', [userId, sessionId]);
        startWhatsApp(userId, sessionId);
    }
    res.json({ sessionId, qr: sessions[sessionId]?.qr || null, status: sessions[sessionId]?.user ? 'connected' : 'connecting' });
});

app.get('/api/wa/status', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        // DB pending & sent dari pool global (semua kontak)
        const [pendingRows] = await mysql.query('SELECT COUNT(*) as total FROM contacts WHERE status = 'pending'');
        const [sentContactRows] = await mysql.query('SELECT COUNT(*) as total FROM contacts WHERE status = 'sent'');
        const [sessionRows] = await mysql.query('SELECT session_id, phone_number, status, COALESCE(sent_count, 0) as sent_count FROM wa_sessions WHERE user_id = ?', [userId]);
        const connectedCount = sessionRows.filter(s => s.status === 'connected').length;
        const sessionsWithStats = sessionRows.map(s => ({ ...s, sent_count: sessionStats[s.session_id]?.sent ?? Number(s.sent_count) ?? 0 }));
        const totalSent = sessionsWithStats.reduce((sum, s) => sum + (s.sent_count || 0), 0);
        const [userRows] = await mysql.query('SELECT balance FROM users WHERE id = ?', [userId]);
        res.json({ sessions: sessionsWithStats, dbCount: pendingRows[0].total, sentCount: sentContactRows[0].total, totalSent, balance: userRows[0]?.balance || 0, totalConnected: connectedCount, status: connectedCount > 0 ? 'connected' : 'disconnected' });
    } catch (err) { res.status(500).json({ message: 'Error' }); }
});

app.post('/api/wa/logout', authenticateToken, async (req, res) => {
    const { sessionId } = req.body;
    const sessionDir = `./sessions/${sessionId}`;
    try {
        if (sessions[sessionId]) {
            try { await sessions[sessionId].logout(); sessions[sessionId].end(); } catch (e) { }
            delete sessions[sessionId];
        }
        delete sessionStats[sessionId];
        if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
        await mysql.query('DELETE FROM wa_sessions WHERE session_id = ?', [sessionId]);
        res.json({ success: true, message: 'Sesi berhasil dihapus' });
    } catch (err) { res.status(500).json({ success: false, message: 'Gagal memutus koneksi' }); }
});

// KONTAK — semua kontak adalah shared pool (global), bisa dilihat & di-blast semua user
app.post('/api/contacts', authenticateToken, async (req, res) => {
    const { name, phone } = req.body;
    try {
        await mysql.query('INSERT INTO contacts (user_id, name, phone, role, status) VALUES (?, ?, ?, ?, 'pending')', [req.user.id, name, phone, req.user.role]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, message: 'Gagal simpan' }); }
});

app.get('/api/contacts', authenticateToken, async (req, res) => {
    const status = req.query.status || 'pending';
    try {
        // Tampilkan semua kontak (shared pool) — tidak filter per user
        const [rows] = await mysql.query('SELECT * FROM contacts WHERE status = ? ORDER BY id DESC', [status]);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/contacts/bulk', authenticateToken, async (req, res) => {
    try {
        const { contacts } = req.body;
        if (!contacts || contacts.length === 0) return res.status(400).json({ message: 'Data kosong' });
        const values = contacts.map(c => [req.user.id, c.name, c.phone, req.user.role, 'pending']);
        await mysql.query('INSERT INTO contacts (user_id, name, phone, role, status) VALUES ?', [values]);
        res.json({ success: true, message: `${contacts.length} kontak berhasil diimpor.` });
    } catch (err) { res.status(500).json({ message: 'Gagal bulk import' }); }
});

app.post('/api/contacts/delete-multiple', authenticateToken, async (req, res) => {
    try {
        const { ids } = req.body;
        if (!ids || ids.length === 0) return res.status(400).json({ message: 'Tidak ada ID' });
        // Hanya admin yang bisa hapus kontak, atau hapus kontak milik sendiri
        if (req.user.role === 'admin') {
            await mysql.query('DELETE FROM contacts WHERE id IN (?) AND status = 'pending'', [ids]);
        } else {
            await mysql.query('DELETE FROM contacts WHERE id IN (?) AND user_id = ? AND status = 'pending'', [ids, req.user.id]);
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.delete('/api/contacts-all', authenticateToken, async (req, res) => {
    try {
        if (req.user.role === 'admin') {
            // Admin hapus semua kontak pending (global)
            await mysql.query('DELETE FROM contacts WHERE status = 'pending'');
        } else {
            await mysql.query('DELETE FROM contacts WHERE user_id = ? AND status = 'pending'', [req.user.id]);
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.delete('/api/contacts/:id', authenticateToken, async (req, res) => {
    try {
        const [rows] = await mysql.query('SELECT status, user_id FROM contacts WHERE id = ?', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'Tidak ditemukan' });
        if (rows[0].status === 'sent') return res.status(403).json({ success: false, message: 'Kontak yang sudah di-blast tidak dapat dihapus!' });
        // Admin bisa hapus kontak siapapun, user hanya milik sendiri
        if (req.user.role !== 'admin' && rows[0].user_id !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Tidak diizinkan!' });
        }
        await mysql.query('DELETE FROM contacts WHERE id = ? AND status = 'pending'', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// TEMPLATE
app.post('/api/upload/image', authenticateToken, upload.single('image'), (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Hanya admin!' });
    if (!req.file) return res.status(400).json({ success: false, message: 'File tidak valid atau terlalu besar (max 5MB)' });
    res.json({ success: true, imageUrl: `/uploads/${req.file.filename}` });
});

app.get('/api/templates', authenticateToken, async (req, res) => {
    try {
        const [rows] = await mysql.query('SELECT * FROM templates ORDER BY id DESC');
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/templates', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Hanya admin!' });
    const { title, content, imageUrl, buttonLabel, buttonUrl, buttons } = req.body;
    if (!title || !content) return res.status(400).json({ success: false, message: 'Judul dan isi pesan wajib!' });
    // buttons = [{label, url}, ...] dari frontend multi-button
    const buttonsJson = (buttons && buttons.length > 0) ? JSON.stringify(buttons) : null;
    const firstLabel = (buttons && buttons[0]?.label) || buttonLabel || null;
    const firstUrl = (buttons && buttons[0]?.url) || buttonUrl || null;
    try {
        // Auto-migrate: tambah kolom buttons_json jika belum ada
        await mysql.query('ALTER TABLE templates ADD COLUMN IF NOT EXISTS buttons_json TEXT').catch(() => { });
        const [result] = await mysql.query(
            'INSERT INTO templates (user_id, title, content, image_url, button_label, button_url, buttons_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [req.user.id, title, content, imageUrl || null, firstLabel, firstUrl, buttonsJson]
        );
        res.json({ success: true, id: result.insertId });
    } catch (err) {
        console.error('[Template] Gagal simpan:', err.message);
        res.status(500).json({ success: false, message: 'Gagal simpan template: ' + err.message });
    }
});

app.get('/api/templates/active', authenticateToken, async (req, res) => {
    try {
        const [rows] = await mysql.query('SELECT * FROM templates WHERE is_active = 1 LIMIT 1');
        if (rows.length === 0) return res.json(null);
        res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/templates/:id', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Hanya admin!' });
    await mysql.query('DELETE FROM templates WHERE id = ?', [req.params.id]);
    res.json({ success: true });
});

app.post('/api/templates/:id/activate', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Hanya admin!' });
    try {
        await mysql.query('UPDATE templates SET is_active = 0');
        await mysql.query('UPDATE templates SET is_active = 1 WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, message: 'Gagal aktifkan template' }); }
});

// BLAST
app.post('/api/wa/blast', authenticateToken, async (req, res) => {
    const { templateId, limit, delay } = req.body;
    const userId = req.user.id;
    try {
        const PRICE_PER_MSG = parseInt(await getSetting('price_per_msg', '800')) || 800;
        const maintenanceMode = await getSetting('maintenance_mode', '0');
        if (maintenanceMode === '1') return res.status(503).json({ success: false, message: 'Sistem sedang dalam Maintenance Mode. Hubungi admin.' });
        let template;
        if (!templateId) {
            const [activeRows] = await mysql.query('SELECT * FROM templates WHERE is_active = 1 LIMIT 1');
            if (activeRows.length === 0) return res.status(400).json({ success: false, message: 'Admin belum mengaktifkan template!' });
            template = activeRows[0];
        } else {
            const [tplRows] = await mysql.query('SELECT * FROM templates WHERE id = ?', [templateId]);
            if (tplRows.length === 0) return res.status(400).json({ success: false, message: 'Template tidak ditemukan!' });
            template = tplRows[0];
        }
        const [activeSessions] = await mysql.query('SELECT session_id FROM wa_sessions WHERE user_id = ? AND status = 'connected' LIMIT 1', [userId]);
        if (activeSessions.length === 0) return res.status(400).json({ success: false, message: 'Hubungkan WhatsApp dulu!' });
        const sessionId = activeSessions[0].session_id;
        const sock = sessions[sessionId];
        if (!sock) return res.status(400).json({ success: false, message: 'Sesi WA tidak aktif. Restart server.' });
        if (!sock._ready) {
            console.log('[Blast] Menunggu koneksi WA ready...');
            for (let i = 0; i < 15; i++) {
                await new Promise(r => setTimeout(r, 1000));
                if (sessions[sessionId]?._ready) break;
            }
            if (!sessions[sessionId]?._ready) {
                return res.status(400).json({ success: false, message: 'WA belum terhubung sepenuhnya. Coba lagi dalam beberapa detik.' });
            }
        }
        // Ambil semua kontak pending dari pool global — limit diterapkan di loop
        const [contacts] = await mysql.query(
            'SELECT id, phone, name FROM contacts WHERE status = 'pending' ORDER BY id ASC'
        );
        if (contacts.length === 0) return res.status(400).json({ success: false, message: 'Tidak ada kontak pending!' });

        // Tentukan batas kirim: 0 / kosong = blast sampai WA disconnect
        const blastLimit = (limit && !isNaN(limit) && parseInt(limit) > 0) ? parseInt(limit) : null;
        const targetCount = blastLimit ? Math.min(blastLimit, contacts.length) : contacts.length;

        res.json({ success: true, message: `Blast dimulai ke ${targetCount} nomor dengan template "${template.title}".`, total: targetCount });
        if (!sessionStats[sessionId]) sessionStats[sessionId] = { sent: 0, failed: 0 };
        console.log(`[Blast] Target: ${targetCount} (limit: ${blastLimit || 'sampai disconnect'})`);

        let sentCount = 0;
        for (const contact of contacts) {
            // Cek apakah sudah mencapai limit
            if (blastLimit && sentCount >= blastLimit) {
                console.log(`[Blast] Limit ${blastLimit} tercapai, berhenti.`);
                break;
            }
            // Cek apakah WA masih terhubung sebelum tiap pesan
            if (!sessions[sessionId]?._ready) {
                console.log(`[Blast] WA disconnect saat iterasi ke-${sentCount + 1}, blast dihentikan otomatis.`);
                break;
            }
            try {
                let target = contact.phone.replace(/\D/g, '');
                if (target.startsWith('0')) target = '62' + target.slice(1);
                if (!target.startsWith('62')) target = '62' + target;
                const jid = `${target}@s.whatsapp.net`;
                await Promise.race([
                    sendTemplateMessage(sessions[sessionId], jid, template, contact.name),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 45000))
                ]);
                console.log(`[✓] → ${target} (${contact.name})`);
                await mysql.query('UPDATE contacts SET status = 'sent', sent_at = NOW() WHERE id = ?', [contact.id]);
                sessionStats[sessionId].sent += 1;
                sentCount += 1;
                await mysql.query('UPDATE wa_sessions SET sent_count = sent_count + 1 WHERE session_id = ?', [sessionId]);
                await mysql.query('UPDATE users SET balance = balance + ? WHERE id = ?', [PRICE_PER_MSG, userId]);
            } catch (err) {
                console.error(`[✗] ${contact.phone}: ${err.message}`);
                sessionStats[sessionId].failed += 1;
                const isInvalid = err.message?.includes('not-authorized') || err.message?.includes('bad jid') || err.message?.includes('not on whatsapp');
                if (isInvalid) await mysql.query('UPDATE contacts SET status = 'failed' WHERE id = ?', [contact.id]);
            }
            await new Promise(r => setTimeout(r, parseInt(delay) || 3000));
        }
        console.log(`[Done] Sent: ${sentCount}, Failed: ${sessionStats[sessionId].failed}`);
    } catch (err) { console.error('Blast Error:', err); }
});

// ─────────────────────────────────────────────
// WITHDRAWAL ROUTES
// ─────────────────────────────────────────────

// User: ajukan withdrawal
app.post('/api/withdrawal/request', authenticateToken, async (req, res) => {
    const { amount, bank_name, account_number, account_name } = req.body;
    const userId = req.user.id;
    try {
        const MIN_WITHDRAW = parseInt(await getSetting('min_withdraw', '10000')) || 10000;
        if (!amount || !bank_name || !account_number || !account_name)
            return res.status(400).json({ success: false, message: 'Semua field wajib diisi!' });
        if (amount < MIN_WITHDRAW)
            return res.status(400).json({ success: false, message: `Minimal withdrawal Rp ${MIN_WITHDRAW.toLocaleString('id-ID')}!` });

        // Cek saldo user
        const [userRows] = await mysql.query('SELECT balance FROM users WHERE id = ?', [userId]);
        if (!userRows[0] || userRows[0].balance < amount)
            return res.status(400).json({ success: false, message: 'Saldo tidak mencukupi!' });

        // Cek apakah ada withdrawal pending
        const [pendingRows] = await mysql.query(
            'SELECT id FROM withdrawals WHERE user_id = ? AND status = 'pending'', [userId]
        );
        if (pendingRows.length > 0)
            return res.status(400).json({ success: false, message: 'Kamu masih punya withdrawal yang belum diproses!' });

        // Auto-create table if not exists
        await mysql.query(`
            CREATE TABLE IF NOT EXISTS withdrawals (
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
            )
        `);

        // Kurangi saldo, buat record withdrawal
        await mysql.query('UPDATE users SET balance = balance - ? WHERE id = ?', [amount, userId]);
        const [result] = await mysql.query(
            'INSERT INTO withdrawals (user_id, amount, bank_name, account_number, account_name) VALUES (?, ?, ?, ?, ?)',
            [userId, amount, bank_name, account_number, account_name]
        );
        res.json({ success: true, message: 'Permintaan withdrawal berhasil dikirim!', id: result.insertId });
    } catch (err) {
        console.error('[Withdrawal] Error:', err);
        res.status(500).json({ success: false, message: 'Gagal mengajukan withdrawal' });
    }
});

// User: riwayat withdrawal milik sendiri
app.get('/api/withdrawal/history', authenticateToken, async (req, res) => {
    try {
        await mysql.query(`
            CREATE TABLE IF NOT EXISTS withdrawals (
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
            )
        `);
        const [rows] = await mysql.query(
            'SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC',
            [req.user.id]
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: semua withdrawal
app.get('/api/admin/withdrawals', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' });
    const status = req.query.status || 'all';
    try {
        await mysql.query(`
            CREATE TABLE IF NOT EXISTS withdrawals (
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
            )
        `);
        let rows;
        if (status !== 'all') {
            [rows] = await mysql.query(
                'SELECT w.*, u.username FROM withdrawals w JOIN users u ON w.user_id = u.id WHERE w.status = ? ORDER BY w.created_at DESC',
                [status]
            );
        } else {
            [rows] = await mysql.query(
                'SELECT w.*, u.username FROM withdrawals w JOIN users u ON w.user_id = u.id ORDER BY w.created_at DESC'
            );
        }
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: approve withdrawal
app.post('/api/admin/withdrawals/:id/approve', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' });
    const { admin_note } = req.body;
    try {
        const [rows] = await mysql.query('SELECT * FROM withdrawals WHERE id = ?', [req.params.id]);
        if (!rows[0]) return res.status(404).json({ success: false, message: 'Tidak ditemukan' });
        if (rows[0].status !== 'pending') return res.status(400).json({ success: false, message: 'Sudah diproses!' });
        await mysql.query(
            'UPDATE withdrawals SET status = 'approved', admin_note = ? WHERE id = ?',
            [admin_note || null, req.params.id]
        );
        res.json({ success: true, message: 'Withdrawal disetujui!' });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Admin: reject withdrawal (kembalikan saldo)
app.post('/api/admin/withdrawals/:id/reject', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' });
    const { admin_note } = req.body;
    try {
        const [rows] = await mysql.query('SELECT * FROM withdrawals WHERE id = ?', [req.params.id]);
        if (!rows[0]) return res.status(404).json({ success: false, message: 'Tidak ditemukan' });
        if (rows[0].status !== 'pending') return res.status(400).json({ success: false, message: 'Sudah diproses!' });
        // Kembalikan saldo
        await mysql.query('UPDATE users SET balance = balance + ? WHERE id = ?', [rows[0].amount, rows[0].user_id]);
        await mysql.query(
            'UPDATE withdrawals SET status = 'rejected', admin_note = ? WHERE id = ?',
            [admin_note || null, req.params.id]
        );
        res.json({ success: true, message: 'Withdrawal ditolak & saldo dikembalikan!' });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Admin: stats withdrawal
app.get('/api/admin/withdrawals/stats', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' });
    try {
        const [pending] = await mysql.query('SELECT COUNT(*) as c, COALESCE(SUM(amount),0) as total FROM withdrawals WHERE status='pending'');
        const [approved] = await mysql.query('SELECT COUNT(*) as c, COALESCE(SUM(amount),0) as total FROM withdrawals WHERE status='approved'');
        const [rejected] = await mysql.query('SELECT COUNT(*) as c FROM withdrawals WHERE status='rejected'');
        res.json({
            pending: { count: pending[0].c, total: pending[0].total },
            approved: { count: approved[0].c, total: approved[0].total },
            rejected: { count: rejected[0].c }
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});


// ─────────────────────────────────────────────
// GLOBAL SETTINGS ROUTES
// ─────────────────────────────────────────────

async function initSettingsTable() {
    await mysql.query(`
        CREATE TABLE IF NOT EXISTS global_settings (
            \`key\` VARCHAR(100) PRIMARY KEY,
            \`value\` TEXT NOT NULL,
            updated_at DATETIME DEFAULT NOW() ON UPDATE NOW()
        )
    `);
    await mysql.query(`INSERT IGNORE INTO global_settings (\`key\`, \`value\`) VALUES ('min_withdraw', '10000')`);
    await mysql.query(`INSERT IGNORE INTO global_settings (\`key\`, \`value\`) VALUES ('price_per_msg', '800')`);
    await mysql.query(`INSERT IGNORE INTO global_settings (\`key\`, \`value\`) VALUES ('wa_support', '')`);
    await mysql.query(`INSERT IGNORE INTO global_settings (\`key\`, \`value\`) VALUES ('maintenance_mode', '0')`);
}
initSettingsTable().catch(console.error);

async function getSetting(key, defaultVal = null) {
    try {
        const [rows] = await mysql.query('SELECT `value` FROM global_settings WHERE `key` = ?', [key]);
        return rows[0] ? rows[0].value : defaultVal;
    } catch { return defaultVal; }
}

app.get('/api/admin/settings', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' });
    try {
        const [rows] = await mysql.query('SELECT `key`, `value` FROM global_settings');
        const result = {};
        rows.forEach(r => result[r.key] = r.value);
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/settings', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' });
    const { min_withdraw, price_per_msg, wa_support, maintenance_mode } = req.body;
    try {
        const updates = { min_withdraw, price_per_msg, wa_support, maintenance_mode };
        for (const [key, val] of Object.entries(updates)) {
            if (val !== undefined && val !== null) {
                await mysql.query(
                    'INSERT INTO global_settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?',
                    [key, String(val), String(val)]
                );
            }
        }
        res.json({ success: true, message: 'Pengaturan global berhasil disimpan!' });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─────────────────────────────────────────────
// ADMIN SUPER ROUTES
// ─────────────────────────────────────────────

// Admin: semua user dengan saldo & rate
app.get('/api/admin/users', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' });
    try {
        // Auto-migrate kolom rate & banned jika belum ada
        await mysql.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS rate INT DEFAULT 800').catch(() => { });
        await mysql.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS banned TINYINT(1) DEFAULT 0').catch(() => { });
        const [rows] = await mysql.query(
            'SELECT id, username, balance, role, COALESCE(banned,0) as banned, COALESCE(rate, 800) as rate FROM users ORDER BY id ASC'
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: user balance list untuk keuangan
app.get('/api/admin/users-balance', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' });
    try {
        const [rows] = await mysql.query(`
            SELECT u.id, u.username, u.balance,
                   COUNT(c.id) as sent_count
            FROM users u
            LEFT JOIN contacts c ON c.user_id = u.id AND c.status = 'sent'
            GROUP BY u.id ORDER BY u.balance DESC
        `);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: update rate user
app.post('/api/admin/users/:id/rate', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' });
    const { rate } = req.body;
    try {
        await mysql.query('UPDATE users SET rate = ? WHERE id = ?', [rate, req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: ban/unban user
app.post('/api/admin/users/:id/ban', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' });
    try {
        await mysql.query('UPDATE users SET banned = NOT banned WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: reset saldo user
app.post('/api/admin/users/:id/reset-balance', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' });
    try {
        await mysql.query('UPDATE users SET balance = 0 WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: semua sessions dari semua user
app.get('/api/admin/all-sessions', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' });
    try {
        const [rows] = await mysql.query(`
            SELECT ws.*, u.username
            FROM wa_sessions ws
            JOIN users u ON ws.user_id = u.id
            ORDER BY ws.status DESC, ws.id DESC
        `);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

async function restoreSessions() {
    try {
        const [rows] = await mysql.query('SELECT user_id, session_id, COALESCE(sent_count, 0) as sent_count FROM wa_sessions WHERE status = 'connected'');
        console.log(`[System] Memulihkan ${rows.length} sesi...`);
        for (const row of rows) {
            sessionStats[row.session_id] = { sent: Number(row.sent_count), failed: 0 };
            startWhatsApp(row.user_id, row.session_id);
        }
    } catch (err) { console.error('Gagal restore:', err); }
}

restoreSessions();
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Server] http://localhost:${PORT}`));