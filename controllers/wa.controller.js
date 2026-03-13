const mysql = require('../db');
const fs = require('fs');
const { sessions, sessionStats, startWhatsApp, sendTemplateMessage } = require('../services/whatsapp.service');
const { getSetting } = require('../services/settings.service');

const connect = async (req, res) => {
    const userId = req.user.id;
    let sessionId = req.query.sid;
    if (!sessionId) {
        sessionId = `session_${userId}_${Date.now()}`;
        await mysql.query(
            `INSERT INTO wa_sessions (user_id, session_id, status, sent_count) VALUES (?, ?, 'connecting', 0)`,
            [userId, sessionId]
        );
        startWhatsApp(userId, sessionId);
    }
    res.json({
        sessionId,
        qr: sessions[sessionId]?.qr || null,
        status: sessions[sessionId]?.user ? 'connected' : 'connecting'
    });
};

const getStatus = async (req, res) => {
    try {
        const userId = req.user.id;
        const [pendingRows] = await mysql.query(`SELECT COUNT(*) as total FROM contacts WHERE status = 'pending'`);
        const [sentContactRows] = await mysql.query(`SELECT COUNT(*) as total FROM contacts WHERE status = 'sent'`);
        const [sessionRows] = await mysql.query(
            `SELECT session_id, phone_number, status, COALESCE(sent_count, 0) as sent_count FROM wa_sessions WHERE user_id = ?`,
            [userId]
        );
        const connectedCount = sessionRows.filter(s => s.status === 'connected').length;
        const sessionsWithStats = sessionRows.map(s => ({
            ...s,
            sent_count: sessionStats[s.session_id]?.sent ?? Number(s.sent_count) ?? 0
        }));
        const totalSent = sessionsWithStats.reduce((sum, s) => sum + (s.sent_count || 0), 0);
        const [userRows] = await mysql.query(`SELECT balance FROM users WHERE id = ?`, [userId]);
        res.json({
            sessions: sessionsWithStats,
            dbCount: pendingRows[0].total,
            sentCount: sentContactRows[0].total,
            totalSent,
            balance: userRows[0]?.balance || 0,
            totalConnected: connectedCount,
            status: connectedCount > 0 ? 'connected' : 'disconnected'
        });
    } catch (err) {
        res.status(500).json({ message: 'Error' });
    }
};

const logout = async (req, res) => {
    const { sessionId } = req.body;
    const sessionDir = `./sessions/${sessionId}`;
    try {
        if (sessions[sessionId]) {
            try { await sessions[sessionId].logout(); sessions[sessionId].end(); } catch (e) { }
            delete sessions[sessionId];
        }
        delete sessionStats[sessionId];
        if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
        await mysql.query(`DELETE FROM wa_sessions WHERE session_id = ?`, [sessionId]);
        res.json({ success: true, message: 'Sesi berhasil dihapus' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Gagal memutus koneksi' });
    }
};

const blast = async (req, res) => {
    const { templateId, limit, delay } = req.body;
    const userId = req.user.id;
    try {
        const PRICE_PER_MSG = parseInt(await getSetting('price_per_msg', '800')) || 800;
        const maintenanceMode = await getSetting('maintenance_mode', '0');
        if (maintenanceMode === '1')
            return res.status(503).json({ success: false, message: 'Sistem sedang dalam Maintenance Mode. Hubungi admin.' });

        let template;
        if (!templateId) {
            const [activeRows] = await mysql.query(`SELECT * FROM templates WHERE is_active = 1 LIMIT 1`);
            if (activeRows.length === 0)
                return res.status(400).json({ success: false, message: 'Admin belum mengaktifkan template!' });
            template = activeRows[0];
        } else {
            const [tplRows] = await mysql.query(`SELECT * FROM templates WHERE id = ?`, [templateId]);
            if (tplRows.length === 0)
                return res.status(400).json({ success: false, message: 'Template tidak ditemukan!' });
            template = tplRows[0];
        }

        const [activeSessions] = await mysql.query(
            `SELECT session_id FROM wa_sessions WHERE user_id = ? AND status = 'connected' LIMIT 1`,
            [userId]
        );
        if (activeSessions.length === 0)
            return res.status(400).json({ success: false, message: 'Hubungkan WhatsApp dulu!' });

        const sessionId = activeSessions[0].session_id;
        const sock = sessions[sessionId];
        if (!sock) return res.status(400).json({ success: false, message: 'Sesi WA tidak aktif. Restart server.' });

        if (!sock._ready) {
            console.log('[Blast] Menunggu koneksi WA ready...');
            for (let i = 0; i < 15; i++) {
                await new Promise(r => setTimeout(r, 1000));
                if (sessions[sessionId]?._ready) break;
            }
            if (!sessions[sessionId]?._ready)
                return res.status(400).json({ success: false, message: 'WA belum terhubung sepenuhnya. Coba lagi.' });
        }

        // Hitung total pending dulu (tanpa load semua ke RAM)
        const [[{ totalPending }]] = await mysql.query(
            `SELECT COUNT(*) as totalPending FROM contacts WHERE status = 'pending'`
        );
        if (totalPending === 0)
            return res.status(400).json({ success: false, message: 'Tidak ada kontak pending!' });

        const blastLimit = (limit && !isNaN(limit) && parseInt(limit) > 0) ? parseInt(limit) : null;
        const targetCount = blastLimit ? Math.min(blastLimit, totalPending) : totalPending;

        res.json({ success: true, message: `Blast dimulai ke ${targetCount} nomor dengan template "${template.title}".`, total: targetCount });
        if (!sessionStats[sessionId]) sessionStats[sessionId] = { sent: 0, failed: 0 };
        console.log(`[Blast] Target: ${targetCount} (limit: ${blastLimit || 'sampai disconnect'})`);

        // Ambil kontak per batch 100 — hemat RAM, tidak load 300k sekaligus
        const BATCH_SIZE = 100;
        let sentCount = 0;
        let lastId = 0;
        let running = true;

        while (running) {
            if (blastLimit && sentCount >= blastLimit) {
                console.log(`[Blast] Limit ${blastLimit} tercapai, berhenti.`);
                break;
            }
            if (!sessions[sessionId]?._ready) {
                console.log(`[Blast] WA disconnect saat iterasi ke-${sentCount + 1}, blast dihentikan.`);
                break;
            }

            // Ambil batch berikutnya menggunakan cursor (id > lastId)
            const fetchLimit = blastLimit ? Math.min(BATCH_SIZE, blastLimit - sentCount) : BATCH_SIZE;
            const [batch] = await mysql.query(
                `SELECT id, phone, name FROM contacts WHERE status = 'pending' AND id > ? ORDER BY id ASC LIMIT ?`,
                [lastId, fetchLimit]
            );
            if (batch.length === 0) break; // semua sudah terkirim

            for (const contact of batch) {
                if (blastLimit && sentCount >= blastLimit) { running = false; break; }
                if (!sessions[sessionId]?._ready) { running = false; break; }
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
                    await mysql.query(`UPDATE contacts SET status = 'sent', sent_at = NOW() WHERE id = ?`, [contact.id]);
                    sessionStats[sessionId].sent += 1;
                    sentCount += 1;
                    await mysql.query(`UPDATE wa_sessions SET sent_count = sent_count + 1 WHERE session_id = ?`, [sessionId]);
                    await mysql.query(`UPDATE users SET balance = balance + ? WHERE id = ?`, [PRICE_PER_MSG, userId]);
                } catch (err) {
                    console.error(`[✗] ${contact.phone}: ${err.message}`);
                    sessionStats[sessionId].failed += 1;
                    const isInvalid = err.message?.includes('not-authorized') ||
                        err.message?.includes('bad jid') ||
                        err.message?.includes('not on whatsapp');
                    if (isInvalid)
                        await mysql.query(`UPDATE contacts SET status = 'failed' WHERE id = ?`, [contact.id]);
                }
                const d = parseInt(delay); if (d > 0) await new Promise(r => setTimeout(r, d));
                lastId = contact.id; // cursor untuk batch berikutnya
            }
        }
        console.log(`[Done] Sent: ${sentCount}, Failed: ${sessionStats[sessionId].failed}`);
    } catch (err) {
        console.error('Blast Error:', err);
    }
};



const getPairingCode = async (req, res) => {
    const { sessionId, phone } = req.body;
    if (!sessionId || !phone) return res.status(400).json({ success: false, message: 'sessionId dan phone wajib diisi' });
    try {
        const sock = sessions[sessionId];
        if (!sock) return res.status(400).json({ success: false, message: 'Sesi tidak ditemukan, coba refresh halaman' });
        // Baileys: requestPairingCode hanya bisa dipanggil saat belum connected
        const code = await sock.requestPairingCode(phone);
        res.json({ success: true, code });
    } catch (err) {
        console.error('[PairingCode] Error:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
};

module.exports = { connect, getStatus, logout, blast, getPairingCode };