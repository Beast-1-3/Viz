const mongoose = require('mongoose');

const UploadSchema = new mongoose.Schema({
    filename: {
        type: String,
        required: true,
    },
    fileHash: {
        type: String,
        required: true,
        unique: true, // Used for identifying the file to resume
    },
    totalSize: {
        type: Number,
        required: true,
    },
    totalChunks: {
        type: Number,
        required: true,
    },
    status: {
        type: String,
        enum: ['UPLOADING', 'PROCESSING', 'COMPLETED', 'FAILED'],
        default: 'UPLOADING',
    },
    finalHash: {
        type: String, // SHA-256 calculated after reassembly
    },
    zipContents: {
        type: Array, // Store list of files if it's a ZIP
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

module.exports = mongoose.model('Upload', UploadSchema);
