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
    try {
        const [rows] = await mysql.query(`SELECT * FROM contacts WHERE status = ? ORDER BY id DESC`, [status]);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const bulkImport = async (req, res) => {
    try {
        const { contacts } = req.body;
        if (!contacts || contacts.length === 0) return res.status(400).json({ message: 'Data kosong' });
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
            await mysql.query(`DELETE FROM contacts WHERE id IN (?) AND user_id = ? AND status = 'pending'`, [ids, req.user.id]);
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
        const [rows] = await mysql.query(`SELECT status, user_id FROM contacts WHERE id = ?`, [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'Tidak ditemukan' });
        if (rows[0].status === 'sent') return res.status(403).json({ success: false, message: 'Kontak yang sudah di-blast tidak dapat dihapus!' });
        if (req.user.role !== 'admin' && rows[0].user_id !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Tidak diizinkan!' });
        }
        await mysql.query(`DELETE FROM contacts WHERE id = ? AND status = 'pending'`, [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

module.exports = { addContact, getContacts, bulkImport, deleteMultiple, deleteAll, deleteOne };
