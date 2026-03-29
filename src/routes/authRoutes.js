const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

router.get('/google', authController.googleLogin);
router.post('/verify-token', authController.verifyToken);
router.get('/link', authController.getLinkUrl);
router.get('/link/callback', authController.linkCallback);
router.get('/health/master', authController.checkMasterHealth);

module.exports = router;
