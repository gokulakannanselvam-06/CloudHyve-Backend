const express = require('express');
const router = express.Router();
const multer = require('multer');
const fileController = require('../controllers/fileController');

const fs = require('fs');
const path = require('path');

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = 'tmp/';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname}`);
    }
});
const upload = multer({ storage });

router.get('/list', fileController.listFiles);
router.post('/upload', upload.single('file'), fileController.uploadFile);
router.delete('/delete', fileController.deleteFile);
router.get('/view/:fileId', fileController.getFile);
router.get('/stats', fileController.getDashboardStats);

module.exports = router;
