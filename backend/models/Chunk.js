const mongoose = require('mongoose');

const ChunkSchema = new mongoose.Schema({
    uploadId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Upload',
        required: true,
    },
    chunkIndex: {
        type: Number,
        required: true,
    },
    status: {
        type: String,
        enum: ['PENDING', 'RECEIVED', 'FAILED'],
        default: 'PENDING',
    },
    receivedAt: {
        type: Date,
        default: Date.now,
    },
});

// Compound index to quickly find if a specific chunk exists for an upload
ChunkSchema.index({ uploadId: 1, chunkIndex: 1 }, { unique: true });

module.exports = mongoose.model('Chunk', ChunkSchema);
