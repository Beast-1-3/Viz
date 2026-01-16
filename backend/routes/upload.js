const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Upload = require('../models/Upload');
const Chunk = require('../models/Chunk');
const { mergeChunks, calculateFileHash, peekZip } = require('../utils/fileProcessor');

const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB
const VAULT_DIR = path.join(__dirname, '../CloudConnect-Vault');
const PROCESSING_DIR = path.join(VAULT_DIR, 'Incomplete');
const COMPLETED_DIR = path.join(VAULT_DIR, 'Ready');

// Ensure directories exist
[PROCESSING_DIR, COMPLETED_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Use memory storage to get buffer and write at offset manually
const storage = multer.memoryStorage();
const uploadMiddleware = multer({ storage });

/**
 * @route POST /upload/init
 * @desc Initialize upload session
 */
router.post('/init', async (req, res) => {
    try {
        const { filename, fileHash, totalSize, totalChunks } = req.body;

        // Check if file already exists/partially uploaded
        let upload = await Upload.findOne({ fileHash });

        if (upload) {
            if (upload.status === 'COMPLETED') {
                return res.json({ status: 'COMPLETED', uploadId: upload._id });
            }

            // Ensure placeholder file exists even if server restarted/files were moved
            const filePath = path.join(PROCESSING_DIR, `${upload._id}_${filename}`);
            if (!fs.existsSync(filePath)) {
                fs.closeSync(fs.openSync(filePath, 'w'));
                // If file was missing, we must assume previous chunks are lost on disk
                // Resetting chunk status in DB to match disk state
                await Chunk.deleteMany({ uploadId: upload._id });
            }

            return res.json({ status: 'RESUMABLE', uploadId: upload._id });
        }

        // Create new upload session
        upload = new Upload({
            filename,
            fileHash,
            totalSize,
            totalChunks,
            status: 'UPLOADING',
        });

        await upload.save();

        // Create placeholder file in processing directory
        const filePath = path.join(PROCESSING_DIR, `${upload._id}_${filename}`);
        fs.closeSync(fs.openSync(filePath, 'w'));

        res.status(201).json({ status: 'INITIALIZED', uploadId: upload._id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * @route GET /upload/status?fileHash=xxx
 * @desc Check which chunks are already uploaded
 */
router.get('/status', async (req, res) => {
    try {
        const { fileHash } = req.query;
        const upload = await Upload.findOne({ fileHash });

        if (!upload) {
            return res.status(404).json({ error: 'Upload not found' });
        }

        const receivedChunks = await Chunk.find({
            uploadId: upload._id,
            status: 'RECEIVED'
        }).select('chunkIndex');

        const chunkIndices = receivedChunks.map(c => c.chunkIndex);

        res.json({
            uploadId: upload._id,
            status: upload.status,
            receivedChunks: chunkIndices,
            totalChunks: upload.totalChunks,
            upload: upload // Include full document for polling metadata (fileUrl, etc)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * @route POST /upload/chunk
 * @desc Upload a single chunk
 */
router.post('/chunk', uploadMiddleware.single('chunk'), async (req, res) => {
    try {
        const { uploadId, chunkIndex } = req.body;
        const upload = await Upload.findById(uploadId);

        if (!upload) return res.status(404).json({ error: 'Upload not found' });

        // 1. Check if chunk already marked RECEIVED
        const existingChunk = await Chunk.findOne({ uploadId, chunkIndex, status: 'RECEIVED' });
        if (existingChunk) {
            return res.json({ success: true, chunkIndex, message: 'Chunk already received' });
        }

        // 2. Calculate file write offset
        const offset = parseInt(chunkIndex) * CHUNK_SIZE;
        const filePath = path.join(PROCESSING_DIR, `${uploadId}_${upload.filename}`);

        // 3. Write using write stream at specific offset
        // Using 'r+' to write to existing file without truncating
        const writeStream = fs.createWriteStream(filePath, {
            flags: 'r+',
            start: offset
        });

        await new Promise((resolve, reject) => {
            writeStream.write(req.file.buffer, (err) => {
                if (err) reject(err);
                else {
                    writeStream.end();
                    resolve();
                }
            });
            writeStream.on('error', reject);
        });

        // 4. Mark chunk RECEIVED in DB
        await Chunk.findOneAndUpdate(
            { uploadId, chunkIndex },
            { status: 'RECEIVED', receivedAt: new Date() },
            { upsert: true, new: true }
        );

        res.json({ success: true, chunkIndex });
    } catch (error) {
        console.error('Chunk upload error:', error);
        if (error.code === 'ENOSPC') {
            return res.status(507).json({ error: 'Server storage is full. 2GB+ files require premium hosting/VPS.' });
        }
        res.status(500).json({ error: error.message });
    }
});

/**
 * @route POST /upload/finalize
 * @desc Merge chunks, calculate final hash, and process (ZIP peek)
 */
router.post('/finalize', async (req, res) => {
    try {
        const { uploadId } = req.body;
        // Atomic status transition from UPLOADING to PROCESSING
        const upload = await Upload.findOneAndUpdate(
            { _id: uploadId, status: 'UPLOADING' },
            { $set: { status: 'PROCESSING' } },
            { new: true }
        );

        if (!upload) {
            // Check if it's already COMPLETED or PROCESSING by someone else
            const existing = await Upload.findById(uploadId);
            if (existing && (existing.status === 'COMPLETED' || existing.status === 'PROCESSING')) {
                return res.json({ status: existing.status, upload: existing });
            }
            return res.status(404).json({ error: 'Upload session not found or in invalid state' });
        }

        // Verify all chunks received
        const count = await Chunk.countDocuments({ uploadId, status: 'RECEIVED' });
        if (count !== upload.totalChunks) {
            // If we failed to get all chunks, revert status or handle as error
            await Upload.findByIdAndUpdate(uploadId, { status: 'UPLOADING' }); // Revert status
            return res.status(400).json({
                error: `Incomplete upload. Received ${count}/${upload.totalChunks} chunks.`,
                status: 'UPLOADING'
            });
        }

        const processingPath = path.join(PROCESSING_DIR, `${uploadId}_${upload.filename}`);
        const finalPath = path.join(COMPLETED_DIR, `${uploadId}_${upload.filename}`);

        // 1. Rename/Move from processing to completed (no merge needed now)
        fs.renameSync(processingPath, finalPath);

        // 2. Calculate Final SHA-256
        const finalHash = await calculateFileHash(finalPath);
        upload.finalHash = finalHash;

        // 3. If ZIP, peek inside
        let zipContent = null;
        if (upload.filename.toLowerCase().endsWith('.zip')) {
            zipContent = await peekZip(finalPath);
            upload.zipContents = zipContent;
        }

        upload.status = 'COMPLETED';
        await upload.save();

        res.json({
            status: 'COMPLETED',
            finalHash,
            zipContent,
            fileUrl: `/api/upload/download/${uploadId}`
        });

        // Cleanup: Remove chunks from DB and disk (optional, ideally after a delay or success)
        // await Chunk.deleteMany({ uploadId });
        // For now, keep them for debugging if needed, or implement a cleanup worker.

    } catch (error) {
        console.error(error);
        if (uploadId) {
            await Upload.findByIdAndUpdate(uploadId, { status: 'FAILED' });
        }
        res.status(500).json({ error: error.message });
    }
});

/**
 * @route GET /upload/download/:uploadId
 * @desc Download a completed file with its original name
 */
router.get('/download/:uploadId', async (req, res) => {
    try {
        const { uploadId } = req.params;
        const upload = await Upload.findById(uploadId);

        if (!upload || upload.status !== 'COMPLETED') {
            return res.status(404).json({ error: 'File not found or upload not completed' });
        }

        const filePath = path.join(COMPLETED_DIR, `${uploadId}_${upload.filename}`);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Physical file not found' });
        }

        // Explicitly set headers to ensure "proper" filename handling across all browsers
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(upload.filename)}"`);

        const fileStream = fs.createReadStream(filePath);
        fileStream.pipe(res);
    } catch (error) {
        console.error('Download error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
