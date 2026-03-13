const mysql = require('../db');

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
    const limit = Math.min(500, parseInt(req.query.limit) || 100);
    const offset = (page - 1) * limit;
    try {
        const [[{ total }]] = await mysql.query(
            `SELECT COUNT(*) as total FROM contacts WHERE status = ?`, [status]
        );
        const [rows] = await mysql.query(
            `SELECT id, name, phone, status, sent_at FROM contacts WHERE status = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
            [status, limit, offset]
        );
        res.json({ data: rows, total, page, limit, pages: Math.ceil(total / limit) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const bulkImport = async (req, res) => {
    try {
        const { contacts } = req.body;
        if (!contacts || contacts.length === 0)
            return res.status(400).json({ message: 'Data kosong' });
        const values = contacts.map(c => [req.user.id, c.name, c.phone, req.user.role, 'pending']);
        await mysql.query(`INSERT INTO contacts (user_id, name, phone, role, status) VALUES ?`, [values]);
        res.json({ success: true, message: `${contacts.length} kontak berhasil diimpor.` });
    } catch (err) {
        res.status(500).json({ message: 'Gagal bulk import' });
    }
};

const deleteMultiple = async (req, res) => {
    try {
        const { ids } = req.body;
        if (!ids || ids.length === 0) return res.status(400).json({ message: 'Tidak ada ID' });
        if (req.user.role === 'admin') {
            await mysql.query(`DELETE FROM contacts WHERE id IN (?) AND status = 'pending'`, [ids]);
        } else {
            await mysql.query(
                `DELETE FROM contacts WHERE id IN (?) AND user_id = ? AND status = 'pending'`,
                [ids, req.user.id]
            );
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
            await mysql.query(
                `DELETE FROM contacts WHERE user_id = ? AND status = 'pending'`,
                [req.user.id]
            );
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false });
    }
};

const deleteOne = async (req, res) => {
    try {
        const [rows] = await mysql.query(`SELECT status, user_id FROM contacts WHERE id = ?`, [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'Tidak ditemukan' });
        if (rows[0].status === 'sent')
            return res.status(403).json({ success: false, message: 'Kontak yang sudah di-blast tidak dapat dihapus!' });
        if (req.user.role !== 'admin' && rows[0].user_id !== req.user.id)
            return res.status(403).json({ success: false, message: 'Tidak diizinkan!' });
        await mysql.query(`DELETE FROM contacts WHERE id = ? AND status = 'pending'`, [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

const clearSent = async (req, res) => {
    try {
        const [result] = await mysql.query(
            `DELETE FROM contacts WHERE status = 'sent'`
        );
        res.json({ success: true, deleted: result.affectedRows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

const exportThenDeletePending = async (req, res) => {
    try {
        // Ambil semua pending sekaligus - 1 query, langsung jadi file
        const [contacts] = await mysql.query(
            `SELECT phone FROM contacts WHERE status = 'pending' ORDER BY id ASC`
        );
        if (contacts.length === 0)
            return res.status(200).send('');

        const txt = contacts.map(c => c.phone).join('\n');

        // Hapus semua pending setelah export
        await mysql.query(`DELETE FROM contacts WHERE status = 'pending'`);

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="pending_${new Date().toISOString().slice(0, 10)}.txt"`);
        res.send(txt);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

module.exports = { addContact, getContacts, bulkImport, deleteMultiple, deleteAll, deleteOne, clearSent, exportThenDeletePending };