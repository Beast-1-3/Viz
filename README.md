# 🌐 CloudConnect: Enterprise Resumable Uploader

CloudConnect is a resilient, enterprise-grade file upload system designed to handle large datasets (>1GB) with surgical precision. It implements distributed state management, memory-efficient streaming I/O, and a battle-hardened UI that survives network crashes.

---

## 🚀 Deployment (Quick Start)

### 🐳 Docker Deployment (Recommended)
Launch the entire stack (Frontend, Backend, MongoDB) with one command:
```bash
docker-compose up --build
```
- **UI**: `http://localhost:5173`
- **API**: `http://localhost:5001`

---

## 🛠️ Implementation Details

### 1. File Integrity (Hashing)
- **Quick Fingerprinting**: Before uploading, the frontend generates a "Quick Hash" based on the file's name, size, and the first/last 1MB of data. This allows for instant identification without reading a 2GB file into memory.
- **Final SHA-256**: Upon reassembly, the backend streams the entire file through `crypto.createHash('sha256')`. This hash is compared against future requests to ensure zero corruption during the merge.

### 2. Pause/Resume Logic
- **Front-end Persistence**: Active upload states (UploadID, Progress, FileHash) are stored in the browser's **IndexedDB**. 
- **Graceful Interruption**: Uses `AbortController` to instantly terminate pending network requests when the user clicks Pause.
- **The Handshake**: On resume, the client sends a `GET /status` request. The backend returns a bit-map of `receivedChunks`. The client then filters its upload queue to only send the missing indices.

### 3. Handling the "Bonus Cases"
1. **The Double-Finalize**: Handled via **Atomic State Transitions** in MongoDB. The `finalize` route uses `findOneAndUpdate` with a condition `{ status: 'UPLOADING' }`. Only the first request succeeds; subsequent near-simultaneous calls are ignored.
2. **Network Flapping**: Uses **Exponential Backoff**. Failed chunks are retried 3 times with delays of $2^n$ seconds. We also include a `chaos.js` middleware to simulate a 30% failure rate for testing.
3. **Out-of-Order Delivery**: Solved using **Direct Offset Writing**. Chunks are written to the file using `fs.createWriteStream` with specific `start` offsets (`index * 5MB`). This allows Chunk 10 to be written before Chunk 1.
4. **Server Crash**: The system is **Stateless**. The database tracks chunk indices, and the file sits on disk. If the server restarts, the next "Handshake" from the client restores the exact state from where it left off.

---

## 📊 Technical Requirements Coverage

| Requirement | Implementation Detail | Status |
| :--- | :--- | :--- |
| **Chunking** | Splitting via `Blob.slice()` at 5MB intervals | ✅ |
| **Concurrency** | Managed via worker pool limited to 3 concurrent XHRs | ✅ |
| **Streaming I/O** | `fs.createWriteStream` with offsets (Zero memory bloat) | ✅ |
| **ZIP Peek** | Selective header streaming via `yauzl` (no extraction) | ✅ |
| **Database** | MongoDB used for resilient document state | ✅ |
| **Cleanup** | Hourly Cron job removes orphans > 24hrs old | ✅ |

---

## ⚖️ Trade-offs & Implementation Notes

- **Database Choice**: Section 6 suggested MySQL, while Section C suggested MongoDB/Postgres. I chose **MongoDB** because its flexible schema is superior for handling dynamic bit-maps of successful chunks and nested ZIP content metadata.
- **Download Removal**: As per the latest security hardening request, the **Download** route and UI were removed to ensure "Write-Only" protection of the server's Vault.
- **Browser Memory**: For files > 5GB, reading the entire file into a Buffer for hashing would crash the tab. I used **Streaming Blob Slicing** to keep RAM usage under 50MB regardless of file size.

---

## 📈 Future Enhancements

1. **S3/Cloud Object Storage Integration**: Swapping local `fs` writes for S3 Multipart Uploads for infinite scaling.
2. **End-to-End Encryption (E2EE)**: Encrypting chunks on the client side before they ever touch the network.
3. **P2P Acceleration**: Using WebRTC to allow peer-assisted chunk delivery for users on the same local network.
4. **Socket.io Progress**: Moving away from polling to real-time WebSockets for sub-millisecond progress updates.

---

## 📸 Demo Verification
*A video demo and screenshots are available in the repository's `/assets` folder, showing a 1GB file surviving a manual network cut.*
