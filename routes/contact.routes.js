const router = require('express').Router();
const { authenticateToken } = require('../middleware/auth.middleware');
const {
    addContact, getContacts, bulkImport,
    deleteMultiple, deleteAll, deleteOne
} = require('../controllers/contact.controller');

router.get('/', authenticateToken, getContacts);
router.post('/', authenticateToken, addContact);
router.post('/bulk', authenticateToken, bulkImport);
router.post('/delete-multiple', authenticateToken, deleteMultiple);

// DELETE /api/contacts-all → mount alias di server.js, handler deleteAll dipanggil via DELETE /
// DELETE /api/contacts/:id → deleteOne
router.delete('/', authenticateToken, deleteAll);  // untuk alias /api/contacts-all
router.delete('/:id', authenticateToken, deleteOne);

module.exports = router;