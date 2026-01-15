const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yauzl = require('yauzl');

/**
 * Merges file chunks into a single file using streaming writes to save memory
 */
const mergeChunks = async (chunksDir, uploadId, totalChunks, outputPath) => {
    const writeStream = fs.createWriteStream(outputPath);

    for (let i = 0; i < totalChunks; i++) {
        const chunkPath = path.join(chunksDir, `${uploadId}_${i}`);

        if (!fs.existsSync(chunkPath)) {
            throw new Error(`Chunk ${i} missing for upload ${uploadId}`);
        }

        const readStream = fs.createReadStream(chunkPath);

        await new Promise((resolve, reject) => {
            readStream.pipe(writeStream, { end: false });
            readStream.on('end', resolve);
            readStream.on('error', reject);
        });

        // Optional: Delete chunk after merging to save space
        // fs.unlinkSync(chunkPath);
    }

    writeStream.end();
    return new Promise((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
    });
};

/**
 * Calculates SHA-256 hash of a file using streaming
 */
const calculateFileHash = (filePath) => {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);

        stream.on('data', (data) => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
};

/**
 * Peeks inside a ZIP file and returns file list
 */
const peekZip = (filePath) => {
    return new Promise((resolve, reject) => {
        const files = [];
        yauzl.open(filePath, { lazyEntries: true }, (err, zipfile) => {
            if (err) return reject(err);

            zipfile.readEntry();
            zipfile.on('entry', (entry) => {
                files.push({
                    name: entry.fileName,
                    size: entry.uncompressedSize,
                    isDir: entry.fileName.endsWith('/')
                });
                zipfile.readEntry();
            });

            zipfile.on('end', () => resolve(files));
            zipfile.on('error', reject);
        });
    });
};

module.exports = {
    mergeChunks,
    calculateFileHash,
    peekZip
};
