# CloudConnect Vault - Resumable Large File Upload System

A robust, premium file upload system designed to handle large file transfers (tested up to 2.4GB+) with resumability, integrity verification, and a sleek modern interface.

## 🚀 Key Features
- **Resumable Uploads**: Pause and resume uploads at any time, even after page refreshes or network failures.
- **Concurrent Chunking**: Uploads files in 5MB pieces with multiple parallel workers (default 3) for maximum speed.
- **File Integrity**: Dual-stage hashing (Quick-hash for session identification and full SHA-256 for verification).
- **Graceful Recovery**: Automatically detects partially uploaded files and resumes from the exact byte where it left off.
- **Premium UI/UX**: Real-time progress tracking, speed calculation, ETA estimation, and a visual "matrix" of chunk states.
- **ZIP Peek**: Automatically explores the top-level contents of uploaded ZIP archives.

---

## 🛠 Technical Implementation

### 1. File Integrity (Hashing)
We use a two-step hashing strategy to balance performance and security:
- **Client-Side (Quick Hash)**: To avoid freezing the main thread while hashing a 2GB+ file, we generate a unique identifier by hashing the **first 1MB**, the **last 1MB**, and the **total file size**. This provides a collision-resistant "fingerprint" used to reconnect to previous upload sessions.
- **Server-Side (Full SHA-256)**: Once all chunks are received and reassembled, the backend performs a streaming SHA-256 calculation over the entire file. This ensures that the final file on disk is bit-for-bit identical to the source.

### 2. Pause/Resume Logic
The system manages high-volume transfers through a "Sparse Writing" strategy:
- **Initialization**: When an upload starts, the server creates a placeholder file.
- **Offset Writing**: Each 5MB chunk is sent with its `chunkIndex`. The server uses `fs.createWriteStream` with the `start` option to write the chunk directly to its correct byte-offset in the target file.
- **State Persistence**:
    - **Frontend**: Stores the `uploadId` and `fileHash` in **IndexedDB**. 
    - **Backend**: Records receive status for every chunk in a **MongoDB** collection.
- **Resumption**: When a file is re-selected, the client queries the backend for missing chunk indices. It only queues chunks that the server hasn't "seen" yet, minimizing redundant data transfer.

### 3. Known Trade-offs
- **Disk I/O Wait**: Writing to specific offsets is highly efficient for reassembly but can lead to fragmented disk writes if many uploads happen simultaneously.
- **Polling for Large Files**: Calculating SHA-256 for a 2.4GB file can take 30+ seconds. We implemented a polling mechanism on the frontend to handle potential HTTP timeouts during this verification phase.
- **Memory Buffer**: Chunks are temporarily buffered in memory (`multer.memoryStorage`) before being written to disk. While 5MB is safe, extreme concurrency could spike memory usage.

---

## 🔮 Further Enhancements
- **Dynamic Chunk Sizing**: Automatically scale chunk size (e.g., 2MB to 20MB) based on real-time network throughput.
- **Byte-Range Resumption**: Move beyond fixed-size chunks to support standard HTTP `Range` requests for even better compatibility.
- **Direct Cloud Streaming**: Pipe chunks directly to AWS S3 or Google Cloud Storage using "Multipart Upload" APIs to save local disk space.
- **Worker Threads**: Offload hashing and ZIP processing to Node.js worker threads to prevent blocking the event loop on the backend.
- **Client-side Encryption**: Implementation of AES-GCM encryption on chunks before they leave the browser for zero-knowledge storage.

---

## 💻 Getting Started

### Prerequisites
- Node.js v16+
- MongoDB

### Installation
1. Clone the repository.
2. Install dependencies for both folders:
   ```bash
   cd backend && npm install
   cd ../frontend && npm install
   ```
3. Start the backend:
   ```bash
   npm run dev
   ```
4. Start the frontend:
   ```bash
   npm run dev
   ```

Built with ❤️ by [Your Name/Team]
