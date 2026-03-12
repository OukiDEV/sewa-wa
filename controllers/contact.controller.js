const mysql = require('../db');

// Pastikan index ada — dipanggil sekali saat startup
async function ensureIndexes() {
    await mysql.query(`ALTER TABLE contacts ADD INDEX IF NOT EXISTS idx_status (status)`).catch(() => { });
    await mysql.query(`ALTER TABLE contacts ADD INDEX IF NOT EXISTS idx_user_status (user_id, status)`).catch(() => { });
}
ensureIndexes();

const addContact = async (req, res) => {
    const { name, phone } = req.body;
    try {
        await mysql.query(
            `INSERT INTO contacts (user_id, name, phone, role, status) VALUES (?, ?, ?, ?, 'pending')`,
            [req.user.id, name, phone, req.user.role]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Gagal simpan' });
    }
};

const getContacts = async (req, res) => {
    const status = req.query.status || 'pending';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 100));
    const offset = (page - 1) * limit;
    try {
        const [[{ total }]] = await mysql.query(
            `SELECT COUNT(*) as total FROM contacts WHERE status = ?`, [status]
        );
        const [rows] = await mysql.query(
            `SELECT id, name, phone, status, sent_at FROM contacts WHERE status = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
            [status, limit, offset]
        );
        res.json({ data: rows, total, page, limit, totalPages: Math.ceil(total / limit) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const bulkImport = async (req, res) => {
    try {
        const { contacts } = req.body;
        if (!contacts || contacts.length === 0) return res.status(400).json({ message: 'Data kosong' });

        const CHUNK = 1000;
        let totalInserted = 0;
        for (let i = 0; i < contacts.length; i += CHUNK) {
            const chunk = contacts.slice(i, i + CHUNK);
            const values = chunk.map(c => [req.user.id, c.name, c.phone, req.user.role, 'pending']);
            await mysql.query(`INSERT INTO contacts (user_id, name, phone, role, status) VALUES ?`, [values]);
            totalInserted += chunk.length;
        }
        res.json({ success: true, message: `${totalInserted} kontak berhasil diimpor.` });
    } catch (err) {
        console.error('[BulkImport] Error:', err.message);
        res.status(500).json({ message: 'Gagal bulk import: ' + err.message });
    }
};

const deleteMultiple = async (req, res) => {
    try {
        const { ids } = req.body;
        if (!ids || ids.length === 0) return res.status(400).json({ message: 'Tidak ada ID' });
        const safeIds = ids.map(id => parseInt(id)).filter(id => !isNaN(id));
        if (safeIds.length === 0) return res.status(400).json({ message: 'ID tidak valid' });
        if (req.user.role === 'admin') {
            await mysql.query(`DELETE FROM contacts WHERE id IN (?) AND status = 'pending'`, [safeIds]);
        } else {
            await mysql.query(`DELETE FROM contacts WHERE id IN (?) AND user_id = ? AND status = 'pending'`, [safeIds, req.user.id]);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false });
    }
};

const deleteAll = async (req, res) => {
    try {
        if (req.user.role === 'admin') {
            await mysql.query(`DELETE FROM contacts WHERE status = 'pending'`);
        } else {
            await mysql.query(`DELETE FROM contacts WHERE user_id = ? AND status = 'pending'`, [req.user.id]);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false });
    }
};

const deleteOne = async (req, res) => {
    try {
        const contactId = parseInt(req.params.id);
        if (!contactId) return res.status(400).json({ success: false, message: 'ID tidak valid' });
        const [rows] = await mysql.query(`SELECT status, user_id FROM contacts WHERE id = ?`, [contactId]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'Tidak ditemukan' });
        if (rows[0].status === 'sent') return res.status(403).json({ success: false, message: 'Kontak yang sudah di-blast tidak dapat dihapus!' });
        if (req.user.role !== 'admin' && rows[0].user_id !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Tidak diizinkan!' });
        }
        await mysql.query(`DELETE FROM contacts WHERE id = ? AND status = 'pending'`, [contactId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

module.exports = { addContact, getContacts, bulkImport, deleteMultiple, deleteAll, deleteOne };