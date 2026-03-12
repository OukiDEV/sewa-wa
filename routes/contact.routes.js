const router = require('express').Router();
const { authenticateToken } = require('../middleware/auth.middleware');
const {
    addContact, getContacts, bulkImport,
    deleteMultiple, deleteAll, deleteOne
} = require('../controllers/contact.controller');

router.get('/',                   authenticateToken, getContacts);
router.post('/',                  authenticateToken, addContact);
router.post('/bulk',              authenticateToken, bulkImport);
router.post('/delete-multiple',   authenticateToken, deleteMultiple);
router.delete('/all',             authenticateToken, deleteAll);   // mapped as /api/contacts-all in original → adjusted here
router.delete('/:id',             authenticateToken, deleteOne);

module.exports = router;
