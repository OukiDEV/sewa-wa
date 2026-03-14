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

        // Total semua pending (untuk header DB Pending)
        const [pendingRows] = await mysql.query(`SELECT COUNT(*) as total FROM contacts WHERE status = 'pending'`);
        const [sentContactRows] = await mysql.query(`SELECT COUNT(*) as total FROM contacts WHERE status = 'sent'`);
        const [sessionRows] = await mysql.query(
            `SELECT session_id, phone_number, status, is_blasting, COALESCE(sent_count, 0) as sent_count FROM wa_sessions WHERE user_id = ?`,
            [userId]
        );

        // Pending per session (untuk card WA — kontak yang dikunci device ini)
        const [sessionPendingRows] = await mysql.query(
            `SELECT locked_by, COUNT(*) as total FROM contacts WHERE status = 'pending' AND locked_by IS NOT NULL AND locked_by != '' GROUP BY locked_by`
        );
        const sessionPendingMap = {};
        sessionPendingRows.forEach(r => { sessionPendingMap[r.locked_by] = Number(r.total); });

        const connectedCount = sessionRows.filter(s => s.status === 'connected').length;
        const sessionsWithStats = sessionRows.map(s => ({
            ...s,
            sent_count: sessionStats[s.session_id]?.sent ?? Number(s.sent_count) ?? 0,
            blasting: sessionStats[s.session_id]?.blasting || s.is_blasting === 1 || false,
            pendingCount: sessionPendingMap[s.session_id] || 0
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
        // Release any locked contacts for this session
        await mysql.query(`UPDATE contacts SET locked_by = NULL WHERE locked_by = ? AND status = 'pending'`, [sessionId]);

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
    const { templateId, limit, delay, sessionId: reqSessionId } = req.body;
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

        // Gunakan sessionId dari request (per device), atau fallback ke session pertama
        let sessionId = reqSessionId;
        if (!sessionId) {
            const [activeSessions] = await mysql.query(
                `SELECT session_id FROM wa_sessions WHERE user_id = ? AND status = 'connected' LIMIT 1`,
                [userId]
            );
            if (activeSessions.length === 0)
                return res.status(400).json({ success: false, message: 'Hubungkan WhatsApp dulu!' });
            sessionId = activeSessions[0].session_id;
        }

        // Validasi session milik user ini
        const [sessionCheck] = await mysql.query(
            `SELECT session_id FROM wa_sessions WHERE session_id = ? AND user_id = ?`,
            [sessionId, userId]
        );
        if (sessionCheck.length === 0)
            return res.status(403).json({ success: false, message: 'Session tidak valid.' });

        const sock = sessions[sessionId];
        if (!sock) return res.status(400).json({ success: false, message: 'Sesi WA tidak aktif. Restart server.' });

        // Cek blasting dari memory ATAU dari DB
        const [[sessionBlastRow]] = await mysql.query(`SELECT is_blasting FROM wa_sessions WHERE session_id = ?`, [sessionId]);
        if (sessionStats[sessionId]?.blasting || sessionBlastRow?.is_blasting === 1)
            return res.status(400).json({ success: false, message: 'Session ini sedang blast!' });

        if (!sock._ready) {
            for (let i = 0; i < 15; i++) {
                await new Promise(r => setTimeout(r, 1000));
                if (sessions[sessionId]?._ready) break;
            }
            if (!sessions[sessionId]?._ready)
                return res.status(400).json({ success: false, message: 'WA belum terhubung sepenuhnya. Coba lagi.' });
        }

        const blastLimit = (limit && !isNaN(limit) && parseInt(limit) > 0) ? parseInt(limit) : null;

        // LOCK kontak untuk session ini — ambil pending yang belum dikunci siapapun
        const lockCount = blastLimit || 999999;
        await mysql.query(
            `UPDATE contacts SET locked_by = ? WHERE status = 'pending' AND (locked_by IS NULL OR locked_by = '') ORDER BY id ASC LIMIT ?`,
            [sessionId, lockCount]
        );

        // Hitung berapa yang berhasil dikunci
        const [[{ lockedCount }]] = await mysql.query(
            `SELECT COUNT(*) as lockedCount FROM contacts WHERE locked_by = ? AND status = 'pending'`,
            [sessionId]
        );

        if (lockedCount === 0)
            return res.status(400).json({ success: false, message: 'Tidak ada kontak pending yang tersedia!' });

        res.json({ success: true, message: `Blast dimulai ke ${lockedCount} nomor dengan template "${template.title}".`, total: lockedCount });

        if (!sessionStats[sessionId]) sessionStats[sessionId] = { sent: 0, failed: 0 };
        sessionStats[sessionId].blasting = true;
        await mysql.query(`UPDATE wa_sessions SET is_blasting = 1 WHERE session_id = ?`, [sessionId]);
        console.log(`[Blast] Session: ${sessionId}, Target: ${lockedCount}`);

        // Parse mode: paralel atau sequential
        const isParallel = delay === 'turbo3' || delay === 'extreme5';
        const parallelSize = delay === 'extreme5' ? 5 : delay === 'turbo3' ? 3 : 1;
        const delayMs = isParallel ? 0 : (parseInt(delay) || 0);

        const BATCH_SIZE = 100;
        let sentCount = 0;
        let lastId = 0;
        let running = true;

        // Helper kirim 1 kontak
        const sendOne = async (contact) => {
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
                await mysql.query(`UPDATE contacts SET status = 'sent', sent_at = NOW(), locked_by = NULL WHERE id = ?`, [contact.id]);
                sessionStats[sessionId].sent += 1;
                sentCount += 1;
                await mysql.query(`UPDATE wa_sessions SET sent_count = sent_count + 1 WHERE session_id = ?`, [sessionId]);
                await mysql.query(`UPDATE users SET balance = balance + ? WHERE id = ?`, [PRICE_PER_MSG, userId]);
            } catch (err) {
                const isRateLimit = err.message?.includes('rate-overlimit') || err.message?.includes('rate_overlimit');
                const isInvalid = err.message?.includes('not-authorized') ||
                    err.message?.includes('bad jid') ||
                    err.message?.includes('not on whatsapp');
                if (isRateLimit) {
                    console.log(`[⏳] Rate limit — kontak dikembalikan ke pending, tunggu 5 detik...`);
                    await mysql.query(`UPDATE contacts SET locked_by = NULL WHERE id = ?`, [contact.id]);
                    await new Promise(r => setTimeout(r, 5000));
                } else if (isInvalid) {
                    console.error(`[✗] ${contact.phone}: ${err.message}`);
                    sessionStats[sessionId].failed += 1;
                    await mysql.query(`UPDATE contacts SET status = 'failed', locked_by = NULL WHERE id = ?`, [contact.id]);
                } else {
                    console.error(`[✗] ${contact.phone}: ${err.message}`);
                    sessionStats[sessionId].failed += 1;
                    await mysql.query(`UPDATE contacts SET locked_by = NULL WHERE id = ?`, [contact.id]);
                }
            }
        };

        while (running) {
            if (!sessions[sessionId]?._ready) {
                console.log(`[Blast] WA disconnect, blast dihentikan.`);
                break;
            }
            if (global.blastStop?.[sessionId]) {
                console.log('[Blast] Dihentikan oleh user.');
                global.blastStop[sessionId] = false;
                break;
            }

            const [batch] = await mysql.query(
                `SELECT id, phone, name FROM contacts WHERE locked_by = ? AND status = 'pending' AND id > ? ORDER BY id ASC LIMIT ?`,
                [sessionId, lastId, BATCH_SIZE]
            );
            if (batch.length === 0) break;

            if (isParallel) {
                // Mode paralel — kirim beberapa sekaligus
                for (let i = 0; i < batch.length; i += parallelSize) {
                    if (!sessions[sessionId]?._ready || global.blastStop?.[sessionId]) { running = false; break; }
                    const chunk = batch.slice(i, i + parallelSize);
                    await Promise.allSettled(chunk.map(c => sendOne(c)));
                    lastId = chunk[chunk.length - 1].id;
                }
            } else {
                // Mode sequential
                for (const contact of batch) {
                    if (!sessions[sessionId]?._ready) { running = false; break; }
                    if (global.blastStop?.[sessionId]) { global.blastStop[sessionId] = false; running = false; break; }
                    await sendOne(contact);
                    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
                    lastId = contact.id;
                }
            }
        }

        // Release sisa kontak yang terkunci tapi belum terkirim
        await mysql.query(`UPDATE contacts SET locked_by = NULL WHERE locked_by = ? AND status = 'pending'`, [sessionId]);

        console.log(`[Done] Session: ${sessionId}, Sent: ${sentCount}, Failed: ${sessionStats[sessionId].failed}`);
        if (sessionStats[sessionId]) sessionStats[sessionId].blasting = false;
        await mysql.query(`UPDATE wa_sessions SET is_blasting = 0 WHERE session_id = ?`, [sessionId]);
    } catch (err) {
        console.error('Blast Error:', err);
        if (req.body.sessionId || true) {
            const sid = req.body.sessionId;
            if (sid) await mysql.query(`UPDATE contacts SET locked_by = NULL WHERE locked_by = ? AND status = 'pending'`, [sid]);
            if (sessionStats[sid]) sessionStats[sid].blasting = false;
        }
    }
};

const getPairingCode = async (req, res) => {
    const { sessionId, phone } = req.body;
    if (!sessionId || !phone) return res.status(400).json({ success: false, message: 'sessionId dan phone wajib diisi' });
    try {
        const sock = sessions[sessionId];
        if (!sock) return res.status(400).json({ success: false, message: 'Sesi tidak ditemukan, coba refresh halaman' });
        const code = await sock.requestPairingCode(phone);
        res.json({ success: true, code });
    } catch (err) {
        console.error('[PairingCode] Error:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
};

const stopBlast = async (req, res) => {
    const { sessionId } = req.body;
    const userId = req.user.id;
    if (!global.blastStop) global.blastStop = {};

    if (sessionId) {
        global.blastStop[sessionId] = true;
        await mysql.query(`UPDATE wa_sessions SET is_blasting = 0 WHERE session_id = ?`, [sessionId]);
    } else {
        const [userSessions] = await mysql.query(
            `SELECT session_id FROM wa_sessions WHERE user_id = ?`, [userId]
        );
        for (const s of userSessions) {
            global.blastStop[s.session_id] = true;
            await mysql.query(`UPDATE wa_sessions SET is_blasting = 0 WHERE session_id = ?`, [s.session_id]);
        }
    }
    res.json({ success: true, message: 'Blast dihentikan.' });
};

module.exports = { connect, getStatus, logout, blast, getPairingCode, stopBlast };