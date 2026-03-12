const router = require('express').Router();
const { authenticateToken, requireAdmin } = require('../middleware/auth.middleware');
const {
    getAllTemplates, getActiveTemplate,
    createTemplate, deleteTemplate, activateTemplate
} = require('../controllers/template.controller');

router.get('/',            authenticateToken, getAllTemplates);
router.get('/active',      authenticateToken, getActiveTemplate);
router.post('/',           authenticateToken, requireAdmin, createTemplate);
router.delete('/:id',      authenticateToken, requireAdmin, deleteTemplate);
router.post('/:id/activate', authenticateToken, requireAdmin, activateTemplate);

module.exports = router;
