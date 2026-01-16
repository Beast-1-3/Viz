# StreamUpload: Resumable Chunked File Upload System

A high-performance, memory-efficient system designed to handle large file uploads (>1GB) with full resumability, visual status tracking, and file integrity verification.

## 🚀 Key Features
- **Zero-Merge Chunking**: Writes chunks directly at specific file offsets.
- **Persistent Resume**: Survives page refreshes using IndexedDB.
- **Visual Matrix**: Real-time grid showing status of every individual chunk.
- **Streaming Integrity**: SHA-256 calculation without loading files into RAM.
- **ZIP Intelligence**: Instant "peek" inside archives without unzipping.
- **Fault Tolerant**: Exponential backoff retries and atomic state transitions.

---

## 🛠 Tech Stack
- **Frontend**: React, Axios, Tailwind CSS, IndexedDB (idb)
- **Backend**: Node.js, Express, MongoDB (Mongoose)
- **Utilities**: `yauzl` (ZIP), `node-cron` (Cleanup), `multer` (Uploads)

---

## 🧠 Core Logic

### 1. Chunking Logic (Offset-based)
Unlike traditional systems that save many small files and merge them at the end, StreamUpload uses **Direct Offset Writing**:
- **Client**: Slices the file into 5MB `Blob` objects.
- **Server**: Initializes a zero-byte placeholder file.
- **Writing**: Each chunk is written using `fs.createWriteStream` with the `flags: 'r+'` and `start: chunkIndex * CHUNK_SIZE` parameters.
- **Benefit**: Zero disk I/O overhead at the end of the upload; the "Finalize" step is just a file rename.

### 2. Resume Logic
Resumability is handled via a dual-layered approach:
- **Server-side**: Every successful chunk is recorded in MongoDB. The `GET /upload/status` endpoint allows the client to see which chunks are already on the server.
- **Client-side**: Active `uploadId`s and file metadata are stored in **IndexedDB**. On page refresh, the app re-identifies the file using its hash and offers a "Resume" option.
- **Reconciliation**: If the server's placeholder file is missing (e.g., after a cleanup), the system automatically resets the DB state and restarts the transfer to ensure consistency.

### 3. Hashing Logic
- **Quick Hash (Frontend)**: To identify files for resumption *instantly*, we hash the first 1MB and last 1MB of the file plus its size/name. This provides a unique fingerprint without waiting minutes to hash a 5GB file.
- **SHA-256 (Backend)**: Once the upload is finalized, the server runs a full SHA-256 integrity check using a **ReadStream**. This ensures the uploaded file is byte-perfect compared to the original.

### 4. ZIP Peek Logic
- Uses the `yauzl` library to read the ZIP's central directory.
- **Lazy Entries**: It does not scan the whole file; it only reads the metadata entries, making it extremely fast even for multi-gigabyte archives.
- Results are stored in the `Upload` document in MongoDB for instant retrieval.

---

## ⚖️ Trade-offs
- **Memory vs Speed**: We chose a 5MB chunk size to balance memory consumption on the server and the number of HTTP requests.
- **Concurrency**: Capped at 3 parallel uploads. Higher concurrency increases speed but can lead to browser thread blocking and server socket exhaustion.
- **Storage**: We use local filesystem storage for simplicity. For production scaling, this would require a shared volume or S3-compatible storage with `MultipartUpload`.

---

## 🔮 Future Improvements
- **Dynamic Chunk Sizing**: Automatically adjust chunk size based on network speed.
- **Cloud Storage**: Implement S3-backed binary storage while maintaining the chunking logic.
- **Checksum Verification**: Implement per-chunk checksums (MD5) for even higher reliability in extremely noisy networks.
- **Progressive ZIP Extraction**: Allow users to download single files from within a large ZIP without downloading the whole archive.

---

### Docker Deployment (Recommended)
You can deploy the entire stack (Frontend, Backend, and MongoDB) using a single command:

1. **Pre-requisite**: Ensure Docker and Docker Compose are installed.
2. **Build and Start**:
   ```bash
   docker-compose up --build
   ```
3. **Access**:
   - Frontend: `http://localhost:80`
   - Backend API: `http://localhost:5001`

The files will be saved in `./backend/CloudConnect-Vault` inside the repository folder.

---

### Manual Installation
1. **Backend**:
   ```bash
   cd backend
   npm install
   # Create .env with MONGODB_URI and PORT
   npm run dev
   ```
2. **Frontend**:
   ```bash
   cd frontend
   npm install
   npm run dev
   ```

3. Open `http://localhost:5173` and upload something massive!

