const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const Upload = require('../models/Upload');
const Chunk = require('../models/Chunk');

const EXPIRATION_HOURS = 24; // Cleanup files older than 24 hours
const PROCESSING_DIR = path.join(__dirname, '../CloudConnect-Vault/Incomplete');

const startCleanupJob = () => {
    // Run every hour at minute 0
    cron.schedule('0 * * * *', async () => {
        console.log('🧹 Running cleanup job...');

        try {
            const expirationDate = new Date();
            expirationDate.setHours(expirationDate.getHours() - EXPIRATION_HOURS);

            // Find incomplete uploads older than expiration
            const expiredUploads = await Upload.find({
                status: { $ne: 'COMPLETED' },
                createdAt: { $lt: expirationDate }
            });

            console.log(`🔍 Found ${expiredUploads.length} expired incomplete uploads.`);

            for (const upload of expiredUploads) {
                const filePath = path.join(PROCESSING_DIR, `${upload._id}_${upload.filename}`);

                // 1. Delete file if exists
                if (fs.existsSync(filePath)) {
                    try {
                        fs.unlinkSync(filePath);
                        console.log(`🗑️ Deleted file: ${filePath}`);
                    } catch (err) {
                        console.error(`❌ Error deleting file ${filePath}:`, err.message);
                    }
                }

                // 2. Remove chunks from DB
                const chunkDeleteResult = await Chunk.deleteMany({ uploadId: upload._id });
                console.log(`✅ Removed ${chunkDeleteResult.deletedCount} chunks from DB for upload ${upload._id}`);

                // 3. Remove upload from DB
                await Upload.findByIdAndDelete(upload._id);
                console.log(`✅ Removed upload ${upload._id} from DB.`);
            }

            console.log('✨ Cleanup job finished.');
        } catch (error) {
            console.error('❌ Cleanup job failed:', error);
        }
    });
};

module.exports = startCleanupJob;
