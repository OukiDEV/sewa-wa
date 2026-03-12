const mysql = require('../db');

const getAllTemplates = async (req, res) => {
    try {
        const [rows] = await mysql.query(`SELECT * FROM templates ORDER BY id DESC`);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const getActiveTemplate = async (req, res) => {
    try {
        const [rows] = await mysql.query(`SELECT * FROM templates WHERE is_active = 1 LIMIT 1`);
        if (rows.length === 0) return res.json(null);
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const createTemplate = async (req, res) => {
    const { title, content, imageUrl, buttonLabel, buttonUrl, buttons } = req.body;
    if (!title || !content) return res.status(400).json({ success: false, message: 'Judul dan isi pesan wajib!' });
    const buttonsJson = (buttons && buttons.length > 0) ? JSON.stringify(buttons) : null;
    const firstLabel = (buttons && buttons[0]?.label) || buttonLabel || null;
    const firstUrl = (buttons && buttons[0]?.url) || buttonUrl || null;
    try {
        await mysql.query(`ALTER TABLE templates ADD COLUMN IF NOT EXISTS buttons_json TEXT`).catch(() => {});
        const [result] = await mysql.query(
            'INSERT INTO templates (user_id, title, content, image_url, button_label, button_url, buttons_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [req.user.id, title, content, imageUrl || null, firstLabel, firstUrl, buttonsJson]
        );
        res.json({ success: true, id: result.insertId });
    } catch (err) {
        console.error('[Template] Gagal simpan:', err.message);
        res.status(500).json({ success: false, message: 'Gagal simpan template: ' + err.message });
    }
};

const deleteTemplate = async (req, res) => {
    await mysql.query(`DELETE FROM templates WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
};

const activateTemplate = async (req, res) => {
    try {
        await mysql.query(`UPDATE templates SET is_active = 0`);
        await mysql.query(`UPDATE templates SET is_active = 1 WHERE id = ?`, [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Gagal aktifkan template' });
    }
};

module.exports = { getAllTemplates, getActiveTemplate, createTemplate, deleteTemplate, activateTemplate };
