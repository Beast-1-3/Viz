import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { getQuickHash } from './utils/hash';
import { saveUploadState, getUploadState, deleteUploadState, saveHistory, getHistory, clearHistory, deleteHistoryItem } from './utils/db';
import logo from './assets/logo.png';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:5001/api/upload';
const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB

function App() {
  const [file, setFile] = useState(null);
  const [status, setStatus] = useState('IDLE');
  const [progress, setProgress] = useState(0);
  const [uploadStats, setUploadStats] = useState({ uploaded: 0, total: 0 });
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [pendingResume, setPendingResume] = useState(null);
  const [history, setHistory] = useState([]);
  const [isDragging, setIsDragging] = useState(false);

  const [chunkStates, setChunkStates] = useState({});
  const [speed, setSpeed] = useState(0);
  const [eta, setEta] = useState(null);
  const [chaosMode, setChaosMode] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  const isPausedRef = useRef(false);

  const uploadStartTime = useRef(null);
  const bytesUploadedRef = useRef(0);
  const speedIntervalRef = useRef(null);
  const abortControllerRef = useRef(null);

  useEffect(() => {
    loadHistory();
  }, []);

  const loadHistory = async () => {
    const data = await getHistory();
    setHistory(data.sort((a, b) => b.timestamp - a.timestamp));
  };

  const handleFileChange = (e) => {
    const selectedFile = e.target.files?.[0] || e.dataTransfer?.files?.[0];
    if (!selectedFile) return;

    setFile(selectedFile);
    setError(null);
    setResult(null);
    setProgress(0);
    setStatus('IDLE');
    setChunkStates({});
    setSpeed(0);
    setEta(null);

    const totalChunks = Math.ceil(selectedFile.size / CHUNK_SIZE);
    const initialStates = {};
    for (let i = 0; i < totalChunks; i++) initialStates[i] = 'pending';
    setChunkStates(initialStates);

    checkResumeState(selectedFile);
  };

  const checkResumeState = async (selectedFile) => {
    try {
      const fileHash = await getQuickHash(selectedFile);
      const savedState = await getUploadState(fileHash);
      if (savedState && savedState.status !== 'COMPLETED') {
        setPendingResume(savedState);
      } else {
        setPendingResume(null);
      }
    } catch (err) {
      console.error('Error checking resume state:', err);
    }
  };

  const uploadFile = async () => {
    if (!file) return;

    try {
      setStatus('HASHING');
      const fileHash = await getQuickHash(file);
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

      let uploadId;
      const savedState = await getUploadState(fileHash);

      if (savedState && savedState.status !== 'COMPLETED') {
        uploadId = savedState.uploadId;
        setStatus('RESUMING');
      } else {
        setStatus('INITIALIZING');
        const initRes = await axios.post(`${API_BASE}/init`, {
          filename: file.name,
          fileHash,
          totalSize: file.size,
          totalChunks
        });
        uploadId = initRes.data.uploadId;
      }

      await saveUploadState(fileHash, { uploadId, filename: file.name, status: 'UPLOADING' });
      const statusRes = await axios.get(`${API_BASE}/status`, { params: { fileHash } });
      const receivedChunks = statusRes.data.receivedChunks || [];

      setChunkStates(prev => {
        const next = { ...prev };
        receivedChunks.forEach(idx => { next[idx] = 'success'; });
        return next;
      });

      const missingChunks = [];
      for (let i = 0; i < totalChunks; i++) {
        if (!receivedChunks.includes(i)) missingChunks.push(i);
      }

      setStatus('UPLOADING');
      let uploadedCount = receivedChunks.length;
      setUploadStats({ uploaded: uploadedCount, total: totalChunks });
      setProgress(Math.floor((uploadedCount / totalChunks) * 100));

      startSpeedTracker(file.size, uploadedCount * CHUNK_SIZE);

      // Initialize AbortController for this session
      abortControllerRef.current = new AbortController();

      const MAX_CONCURRENT = 3;
      const queue = [...missingChunks];

      const uploadPool = async () => {
        const workers = [];
        const runWorker = async () => {
          while (queue.length > 0) {
            if (isPausedRef.current) break;

            const chunkIndex = queue.shift();
            if (chunkIndex === undefined) continue;

            const start = chunkIndex * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, file.size);
            const chunk = file.slice(start, end);

            try {
              await uploadChunkWithRetry(chunk, uploadId, chunkIndex, 0, abortControllerRef.current.signal);
              uploadedCount++;
              setUploadStats({ uploaded: uploadedCount, total: totalChunks });
              setProgress(Math.floor((uploadedCount / totalChunks) * 100));
            } catch (err) {
              if (err.name === 'CanceledError') {
                // Re-queue the chunk for next time
                queue.push(chunkIndex);
                break;
              }
              throw err;
            }
          }
        };

        for (let i = 0; i < Math.min(MAX_CONCURRENT, queue.length); i++) {
          workers.push(runWorker());
        }
        await Promise.all(workers);
      };

      if (queue.length > 0) await uploadPool();

      // If we finished because of pause, just return and don't finalize
      if (isPausedRef.current) return;

      stopSpeedTracker();
      setStatus('PROCESSING');
      const finalizeRes = await axios.post(`${API_BASE}/finalize`, { uploadId });

      setResult(finalizeRes.data);
      setStatus('COMPLETED');
      setProgress(100);

      await deleteUploadState(fileHash);
      saveToHistory(file.name, file.size, 'SUCCESS', fileHash, finalizeRes.data.fileUrl, finalizeRes.data.finalHash);
      setPendingResume(null);

      // Clear the active selection after 2 seconds to avoid duplicate look
      setTimeout(() => {
        setFile(null);
        setStatus('IDLE');
        setResult(null);
      }, 2000);

    } catch (err) {
      stopSpeedTracker();
      setError(err.message);
      setStatus('FAILED');
    }
  };

  const handleTogglePause = () => {
    const nextState = !isPaused;
    setIsPaused(nextState);
    isPausedRef.current = nextState;
    if (!nextState) {
      uploadFile();
    } else {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      stopSpeedTracker();
    }
  };


  const uploadChunkWithRetry = async (chunk, uploadId, chunkIndex, retryCount = 0, signal = null) => {
    setChunkStates(prev => ({ ...prev, [chunkIndex]: 'uploading' }));
    const formData = new FormData();
    formData.append('chunk', chunk);
    formData.append('uploadId', uploadId);
    formData.append('chunkIndex', chunkIndex.toString());

    try {
      await axios.post(`${API_BASE}/chunk`, formData, { signal });
      setChunkStates(prev => ({ ...prev, [chunkIndex]: 'success' }));
      bytesUploadedRef.current += chunk.size;
    } catch (err) {
      if (axios.isCancel(err)) {
        setChunkStates(prev => ({ ...prev, [chunkIndex]: 'pending' }));
        const error = new Error('Upload canceled');
        error.name = 'CanceledError';
        throw error;
      }
      if (retryCount < 3) {
        setChunkStates(prev => ({ ...prev, [chunkIndex]: 'error' }));
        const delay = Math.pow(2, retryCount) * 1000;
        await new Promise(r => setTimeout(r, delay));
        return uploadChunkWithRetry(chunk, uploadId, chunkIndex, retryCount + 1, signal);
      }
      setChunkStates(prev => ({ ...prev, [chunkIndex]: 'error' }));
      throw err;
    }
  };

  const startSpeedTracker = (totalSize, alreadyUploadedBytes) => {
    uploadStartTime.current = Date.now();
    bytesUploadedRef.current = alreadyUploadedBytes;
    speedIntervalRef.current = setInterval(() => {
      const timeElapsed = (Date.now() - uploadStartTime.current) / 1000;
      const bytesSinceStart = bytesUploadedRef.current - alreadyUploadedBytes;
      const currentSpeed = bytesSinceStart / (timeElapsed || 1);
      setSpeed(currentSpeed);
      if (currentSpeed > 0) {
        setEta(Math.ceil((totalSize - bytesUploadedRef.current) / currentSpeed));
      }
    }, 1000);
  };

  const stopSpeedTracker = () => {
    if (speedIntervalRef.current) clearInterval(speedIntervalRef.current);
  };

  const saveToHistory = async (name, size, resultStatus, fileHash, fileUrl = null, finalHash = null) => {
    await saveHistory({
      filename: name,
      size,
      status: resultStatus,
      timestamp: Date.now(),
      fileHash,
      fileUrl,
      finalHash
    });
    loadHistory();
  };

  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatSpeed = (bps) => bps > 0 ? `${(bps / 1024 / 1024).toFixed(2)} MB/s` : '0 MB/s';
  const formatEta = (secs) => secs ? `${Math.floor(secs / 60)}m ${secs % 60}s` : '--';

  return (
    <div className="min-h-screen p-4 md:p-12 lg:p-24 flex items-center justify-center">
      <div className="max-w-4xl w-full space-y-12">

        {/* Header with Logo */}
        <header className="flex flex-col items-center justify-center space-y-2">
          <img src={logo} alt="CloudConnect Logo" className="h-16 md:h-24 w-auto object-contain" />
        </header>

        {/* Upload Container */}
        <div className="white-card p-8 md:p-16 space-y-8 relative overflow-hidden">
          <div
            className={`upload-zone h-64 border-2 border-dashed flex flex-col items-center justify-center gap-6 cursor-pointer relative group ${isDragging ? 'border-blue-400 bg-blue-50' : 'border-slate-300'}`}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => { e.preventDefault(); setIsDragging(false); handleFileChange(e); }}
          >
            <input type="file" className="absolute inset-0 opacity-0 cursor-pointer" onChange={handleFileChange} />

            <div className="w-20 h-20 flex items-center justify-center">
              <svg className="w-16 h-16 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
            </div>

            <div className="text-center space-y-1">
              <p className="font-bold text-slate-700 text-lg">Drag or Drop file(s) here</p>
              <p className="text-slate-400 text-sm">or</p>
              <button className="bg-slate-900 text-white px-6 py-2 rounded-lg font-bold text-sm">Browse file(s)</button>
            </div>
          </div>

          {/* Active Upload & History List */}
          <div className="space-y-4">
            {/* Current Upload Item */}
            {file && (
              <div className="history-item p-4 flex items-center justify-between group shadow-sm animate-in fade-in duration-500">
                <div className="flex-1 flex flex-col gap-1">
                  <div className="flex items-center gap-4">
                    <span className="font-bold text-slate-700 truncate max-w-[200px]">{file.name}</span>
                    <div className="hidden md:flex items-center gap-4 text-xs text-slate-500 font-medium">
                      <span>{formatEta(eta)}</span>
                      <span className="opacity-40">|</span>
                      <span>{formatBytes(file.size)}</span>
                    </div>
                  </div>
                  {status === 'UPLOADING' && (
                    <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden mt-1">
                      <div
                        className={`h-full bg-amber-500 transition-all duration-300 ${!isPaused ? 'streaming-bar' : ''}`}
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-4">
                  {status === 'IDLE' ? (
                    <button onClick={uploadFile} className="flex items-center gap-2 group/btn">
                      <span className="text-xs font-bold text-slate-500 uppercase tracking-widest">file upload</span>
                      <div className="w-8 h-8 rounded-full bg-slate-900 flex items-center justify-center text-white">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 10l7-7m0 0l7 7m-7-7v18" /></svg>
                      </div>
                    </button>
                  ) : (
                    <div className="flex items-center gap-3">
                      {status === 'UPLOADING' && (
                        <button
                          onClick={handleTogglePause}
                          className="w-10 h-10 rounded-full flex items-center justify-center border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
                          title={isPaused ? "Resume Upload" : "Pause Upload"}
                        >
                          {isPaused ? (
                            <svg className="w-4 h-4 ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                          ) : (
                            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h4z" /></svg>
                          )}
                        </button>
                      )}

                      <div className={`status-badge ${status === 'COMPLETED' ? 'status-success' : status === 'FAILED' ? 'status-failed' : isPaused ? 'status-uploading opacity-60' : 'status-uploading'}`}>
                        {status === 'COMPLETED' ? (
                          <><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" /></svg> Success</>
                        ) : status === 'FAILED' ? (
                          <><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg> Failed</>
                        ) : (
                          <span className="flex items-center gap-2">
                            <div className={`w-2 h-2 rounded-full bg-amber-500 ${!isPaused ? 'animate-ping' : ''}`} />
                            {status === 'UPLOADING' ? (isPaused ? 'Paused' : 'Uploading') : status}
                            {status === 'UPLOADING' && !isPaused && <span className="ml-1 text-[10px] font-bold">{progress}%</span>}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Matrix & Stats tray for current upload (subtle) */}
            {status !== 'IDLE' && status !== 'COMPLETED' && file && (
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 flex flex-col md:flex-row items-center gap-6">
                <div className="flex-1 w-full flex flex-wrap gap-1">
                  {Object.entries(chunkStates).map(([idx, s]) => (
                    <div key={idx} className={`w-2 h-2 rounded-sm ${s === 'success' ? 'bg-green-400' : s === 'uploading' ? 'bg-amber-400 animate-pulse' : s === 'error' ? 'bg-red-400' : 'bg-slate-200'}`} />
                  ))}
                </div>
                <div className="flex gap-4 text-[10px] font-bold uppercase tracking-widest text-slate-400 shrink-0">
                  <span>{formatSpeed(speed)}</span>
                  <span>{uploadStats.uploaded}/{uploadStats.total} Pieces</span>
                </div>
              </div>
            )}

            {/* History Items */}
            {history.map((item, idx) => (
              <div key={idx} className="history-item p-4 flex items-center justify-between group shadow-sm opacity-80 hover:opacity-100 transition-opacity">
                <div className="flex-1 flex flex-col">
                  <span className="font-bold text-slate-700 truncate max-w-[200px]">{item.filename}</span>
                  <div className="flex items-center gap-4 text-[10px] text-slate-400 font-medium">
                    <span>{new Date(item.timestamp).toLocaleDateString()}</span>
                    <span className="opacity-40">|</span>
                    <span>{formatBytes(item.size)}</span>
                    {item.finalHash && (
                      <>
                        <span className="opacity-40">|</span>
                        <span className="font-mono text-[9px] truncate max-w-[100px]" title={item.finalHash}>SHA: {item.finalHash.substring(0, 8)}...</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  {item.status === 'SUCCESS' && item.fileUrl && (
                    <a
                      href={`http://localhost:5001${item.fileUrl}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs font-bold text-blue-600 hover:text-blue-700 bg-blue-50 px-3 py-1.5 rounded-full flex items-center gap-1 transition-colors"
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a2 2 0 002 2h12a2 2 0 002-2v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                      Download
                    </a>
                  )}
                  <div className={`status-badge ${item.status === 'SUCCESS' ? 'status-success' : 'status-failed'}`}>
                    {item.status === 'SUCCESS' ? (
                      <><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" /></svg> Success</>
                    ) : (
                      <><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg> Failed</>
                    )}
                  </div>
                  <button onClick={async () => { await deleteHistoryItem(item.fileHash); loadHistory(); }} className="text-slate-300 hover:text-red-400 p-1">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer info from photo */}
        <div className="text-center">
          <p className="text-slate-400 text-sm font-medium">CloudConnect • Future in Cloud</p>
        </div>

      </div>
    </div>
  );
}

export default App;
