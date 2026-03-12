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
const mysql = require('../db');

const sessions = {};
const sessionStats = {};

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
        sock.ev.on('creds.update', saveCreds);

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
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) {
                    delete sessions[sessionId];
                    setTimeout(() => startWhatsApp(userId, sessionId), 5000);
                } else {
                    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
                    await mysql.query(`DELETE FROM wa_sessions WHERE session_id = ?`, [sessionId]);
                    delete sessions[sessionId];
                    delete sessionStats[sessionId];
                }
            }
        });
    } catch (err) {
        console.error('Baileys Error:', err);
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
        imgSrc = (template.image_url.startsWith('/uploads/') && fs.existsSync(localPath))
            ? fs.readFileSync(localPath)
            : { url: template.image_url.trim() };
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