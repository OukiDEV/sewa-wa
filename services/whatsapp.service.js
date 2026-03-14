const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    generateWAMessageFromContent,
    prepareWAMessageMedia,
    proto,
    Browsers
} = require('@whiskeysockets/baileys');
const fs = require('fs');
const mysql = require('../db');

const sessions = {};
const sessionStats = {};
const imageCache = {}; // Cache image biar tidak baca disk tiap pesan

// Debounce helper — panggil fn max 1x per `wait` ms
function debounce(fn, wait) {
    let timer = null;
    return function (...args) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { fn.apply(this, args); timer = null; }, wait);
    };
}

async function startWhatsApp(userId, sessionId) {
    const sessionDir = `./sessions/${sessionId}`;
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
    if (!sessionStats[sessionId]) sessionStats[sessionId] = { sent: 0, failed: 0 };

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    // debounce saveCreds — max 1x per 10 detik
    const debouncedSaveCreds = debounce(saveCreds, 10000);

    try {
        const { version } = await fetchLatestBaileysVersion();
        const sock = makeWASocket({
            auth: state,
            version,
            browser: Browsers.ubuntu('Chrome'), // FIX: pakai browser standard bukan custom name
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
                    message.interactiveMessage
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

        sock.ev.on('creds.update', debouncedSaveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, qr, lastDisconnect } = update;
            if (qr) sessions[sessionId].qr = qr;

            if (connection === 'open') {
                const phone = sock.user.id.split(':')[0];
                sessions[sessionId].qr = null;
                sessions[sessionId]._ready = true;
                await mysql.query(
                    `UPDATE wa_sessions SET status = 'connected', phone_number = ? WHERE session_id = ?`,
                    [phone, sessionId]
                );
                console.log(`[✓] ${phone} terhubung`);
            }

            if (connection === 'close') {
                const err = lastDisconnect?.error;
                const statusCode = err?.output?.statusCode;

                // FIX: handle stream error 515 (restart required) — reconnect tanpa hapus session
                const isStreamRestart = err?.message?.includes('Stream Errored') ||
                    err?.message?.includes('restart required') ||
                    statusCode === 515;

                const isLoggedOut = statusCode === DisconnectReason.loggedOut;

                if (isLoggedOut) {
                    // WA logout manual — hapus session
                    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
                    await mysql.query(`DELETE FROM wa_sessions WHERE session_id = ?`, [sessionId]);
                    delete sessions[sessionId];
                    delete sessionStats[sessionId];
                    console.log(`[✗] ${sessionId}: Logged out, sesi dihapus`);
                } else if (isStreamRestart) {
                    // Stream error 515 — reconnect cepat tanpa hapus session
                    console.log(`[↺] ${sessionId}: Stream restart (515), reconnect dalam 3 detik...`);
                    delete sessions[sessionId];
                    setTimeout(() => startWhatsApp(userId, sessionId), 3000);
                } else {
                    // Error lain — reconnect normal
                    console.log(`[↺] ${sessionId}: Disconnect (${statusCode}), reconnect dalam 5 detik...`);
                    delete sessions[sessionId];
                    setTimeout(() => startWhatsApp(userId, sessionId), 5000);
                }
            }
        });
    } catch (err) {
        console.error('Baileys Error:', err);
        // Retry jika startWhatsApp sendiri crash
        setTimeout(() => startWhatsApp(userId, sessionId), 5000);
    }
}

async function sendInteractiveCarousel(sock, jid, { cards, bodyText = '', footerText = '' }) {
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

async function sendTemplateMessage(sock, jid, template, contactName) {
    const text = (template.content || '').replace(/\{nama\}/gi, contactName || '');
    const hasImage = template.image_url && template.image_url.trim() !== '';

    let imgSrc = null;
    if (hasImage) {
        const localPath = `./public${template.image_url.trim()}`;
        if (template.image_url.startsWith('/uploads/') && fs.existsSync(localPath)) {
            if (!imageCache[localPath]) {
                imageCache[localPath] = fs.readFileSync(localPath);
                console.log(`[Cache] Image cached: ${localPath}`);
            }
            imgSrc = imageCache[localPath];
        } else {
            imgSrc = { url: template.image_url.trim() };
        }
    }

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
                buttons: btns,
                image: imgSrc
            }];
            const result = await sendInteractiveCarousel(sock, jid, { cards, bodyText: template.title || ' ' });
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

async function restoreSessions() {
    try {
        const [rows] = await mysql.query(
            `SELECT user_id, session_id, COALESCE(sent_count, 0) as sent_count FROM wa_sessions WHERE status = 'connected'`
        );
        console.log(`[System] Memulihkan ${rows.length} sesi...`);
        for (const row of rows) {
            sessionStats[row.session_id] = { sent: Number(row.sent_count), failed: 0 };
            startWhatsApp(row.user_id, row.session_id);
        }
    } catch (err) {
        console.error('Gagal restore:', err);
    }
}

module.exports = { sessions, sessionStats, startWhatsApp, sendTemplateMessage, restoreSessions };