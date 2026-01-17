/**
 * Generates a unique identifier for a file based on its head, tail, and size.
 * Used for session resumption without hashing the entire file upfront.
 */
export const getQuickHash = async (file) => {
    const head = file.slice(0, 1024 * 1024);
    const tail = file.slice(file.size - 1024 * 1024, file.size);

    const headBuffer = await head.arrayBuffer();
    const tailBuffer = await tail.arrayBuffer();

    const combined = new Uint8Array(headBuffer.byteLength + tailBuffer.byteLength);
    combined.set(new Uint8Array(headBuffer), 0);
    combined.set(new Uint8Array(tailBuffer), headBuffer.byteLength);

    const hashBuffer = await window.crypto.subtle.digest('SHA-256', combined);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    return `${hashHex}-${file.size}`;
};

