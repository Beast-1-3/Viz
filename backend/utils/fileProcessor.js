const fs = require('fs');
const crypto = require('crypto');
const yauzl = require('yauzl');

/**
 * Calculates SHA-256 hash of a file using streaming to ensure efficiency for large files.
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
 * Lists the top-level contents of a ZIP record for verification.
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
    calculateFileHash,
    peekZip
};

