import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { getQuickHash } from './utils/hash';
import { saveUploadState, getUploadState, deleteUploadState, saveHistory, getHistory, clearHistory } from './utils/db';

const API_BASE = 'http://localhost:5001/api/upload';
const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB

function App() {
  const [file, setFile] = useState(null);
  const [status, setStatus] = useState('IDLE'); // IDLE, HASHING, UPLOADING, PROCESSING, COMPLETED, FAILED
  const [progress, setProgress] = useState(0);
  const [uploadStats, setUploadStats] = useState({ uploaded: 0, total: 0 });
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [pendingResume, setPendingResume] = useState(null);
  const [history, setHistory] = useState([]);
  const [isDragging, setIsDragging] = useState(false);

  // Advanced UI Stats
  const [chunkStates, setChunkStates] = useState({}); // { index: 'pending' | 'uploading' | 'success' | 'error' }
  const [speed, setSpeed] = useState(0);
  const [eta, setEta] = useState(null);
  const [chaosMode, setChaosMode] = useState(false);

  const uploadStartTime = useRef(null);
  const bytesUploadedRef = useRef(0);
  const speedIntervalRef = useRef(null);

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

  const uploadChunkWithRetry = async (chunk, uploadId, chunkIndex, retryCount = 0) => {
    setChunkStates(prev => ({ ...prev, [chunkIndex]: 'uploading' }));

    const formData = new FormData();
    formData.append('chunk', chunk);
    formData.append('uploadId', uploadId);
    formData.append('chunkIndex', chunkIndex.toString());

    try {
      await axios.post(`${API_BASE}/chunk`, formData, {
        headers: { 'x-chaos-mode': chaosMode.toString() }
      });
      setChunkStates(prev => ({ ...prev, [chunkIndex]: 'success' }));
      bytesUploadedRef.current += chunk.size;
    } catch (err) {
      if (retryCount < 3) {
        setChunkStates(prev => ({ ...prev, [chunkIndex]: 'error' }));
        const delay = Math.pow(2, retryCount) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
        return uploadChunkWithRetry(chunk, uploadId, chunkIndex, retryCount + 1);
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
        const remainingBytes = totalSize - bytesUploadedRef.current;
        setEta(Math.ceil(remainingBytes / currentSpeed));
      }
    }, 1000);
  };

  const stopSpeedTracker = () => {
    if (speedIntervalRef.current) {
      clearInterval(speedIntervalRef.current);
      speedIntervalRef.current = null;
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
        }, {
          headers: { 'x-chaos-mode': chaosMode.toString() }
        });
        uploadId = initRes.data.uploadId;

        if (initRes.data.status === 'COMPLETED') {
          setStatus('COMPLETED');
          setProgress(100);
          await deleteUploadState(fileHash);
          saveToHistory(file.name, file.size, 'SUCCESS', fileHash);
          return;
        }
      }

      await saveUploadState(fileHash, { uploadId, filename: file.name, status: 'UPLOADING' });

      const statusRes = await axios.get(`${API_BASE}/status`, {
        params: { fileHash },
        headers: { 'x-chaos-mode': chaosMode.toString() }
      });
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

      const MAX_CONCURRENT = 3;
      const queue = [...missingChunks];

      const uploadPool = async () => {
        const workers = [];
        const runWorker = async () => {
          while (queue.length > 0) {
            const chunkIndex = queue.shift();
            const start = chunkIndex * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, file.size);
            const chunk = file.slice(start, end);

            await uploadChunkWithRetry(chunk, uploadId, chunkIndex);

            uploadedCount++;
            setUploadStats({ uploaded: uploadedCount, total: totalChunks });
            setProgress(Math.floor((uploadedCount / totalChunks) * 100));
          }
        };

        for (let i = 0; i < Math.min(MAX_CONCURRENT, queue.length); i++) {
          workers.push(runWorker());
        }
        await Promise.all(workers);
      };

      if (queue.length > 0) {
        await uploadPool();
      }

      stopSpeedTracker();
      setStatus('PROCESSING');
      const finalizeRes = await axios.post(`${API_BASE}/finalize`, { uploadId }, {
        headers: { 'x-chaos-mode': chaosMode.toString() }
      });

      setResult(finalizeRes.data);
      setStatus('COMPLETED');
      setProgress(100);

      await deleteUploadState(fileHash);
      saveToHistory(file.name, file.size, 'SUCCESS', fileHash);
      setPendingResume(null);

    } catch (err) {
      stopSpeedTracker();
      console.error(err);
      setError(err.response?.data?.error || err.message);
      setStatus('FAILED');
      if (file) {
        const fileHash = await getQuickHash(file);
        saveToHistory(file.name, file.size, 'FAILED', fileHash);
      }
    }
  };

  const saveToHistory = async (name, size, resultStatus, fileHash) => {
    const historyItem = {
      filename: name,
      size,
      status: resultStatus,
      timestamp: Date.now(),
      fileHash
    };
    await saveHistory(historyItem);
    loadHistory();
  };

  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setIsDragging(true);
    } else if (e.type === "dragleave") {
      setIsDragging(false);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    handleFileChange(e);
  };

  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatSpeed = (bytesPerSec) => {
    if (bytesPerSec === 0) return '0 B/s';
    const k = 1024;
    const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    const i = Math.floor(Math.log(bytesPerSec) / Math.log(k));
    return parseFloat((bytesPerSec / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatEta = (seconds) => {
    if (!seconds || !isFinite(seconds)) return '--';
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    return `${mins}m ${seconds % 60}s`;
  };

  const formatTime = (ts) => {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="min-h-screen bg-slate-950 px-4 py-8 md:p-12">
      <div className="max-w-4xl mx-auto space-y-10">

        {/* Header */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div>
            <h1 className="text-5xl font-extrabold gradient-text tracking-tight">StreamUpload</h1>
            <p className="text-slate-400 mt-2 font-medium">Enterprise-grade large file delivery</p>
          </div>

          <div className="flex items-center gap-4 bg-slate-900/50 p-2 rounded-2xl border border-white/5">
            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest px-2">Chaos Laboratory</span>
            <label className="relative inline-flex items-center cursor-pointer">
              <input type="checkbox" checked={chaosMode} onChange={() => setChaosMode(!chaosMode)} className="sr-only peer" />
              <div className="w-11 h-6 bg-slate-800 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-red-500"></div>
            </label>
          </div>
        </header>

        {/* Main Upload Zone */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">

          <div className="lg:col-span-12">
            <div
              className={`upload-area relative glass rounded-[2.5rem] p-12 text-center overflow-hidden h-80 flex flex-col items-center justify-center gap-4 ${isDragging ? 'dragging' : ''}`}
              onDragEnter={handleDrag}
              onDragOver={handleDrag}
              onDragleave={handleDrag}
              onDrop={handleDrop}
            >
              <input type="file" onChange={handleFileChange} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" />

              <div className="w-24 h-24 bg-indigo-500/10 rounded-3xl flex items-center justify-center text-indigo-400 border border-indigo-500/20 group-hover:scale-110 transition-transform">
                <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>
              </div>

              <div className="space-y-1">
                <h3 className="text-2xl font-bold">Drag or Drop file(s) here</h3>
                <p className="text-slate-500 font-medium">Support large files up to 10GB • CHUNKED</p>
              </div>

              <button className="bg-slate-900 text-white px-8 py-3 rounded-2xl font-bold border border-white/5 hover:bg-slate-800 transition-colors pointer-events-none">
                Browse file(s)
              </button>

              {isDragging && <div className="absolute inset-0 bg-indigo-500/10 backdrop-blur-sm pointer-events-none border-4 border-indigo-500 rounded-[2.5rem]" />}
            </div>
          </div>

          {/* Active Upload Card */}
          {file && (
            <div className="lg:col-span-12 animate-in slide-in-from-bottom-6 duration-500">
              <div className="glass-card rounded-[2rem] p-8 space-y-8">
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
                  <div className="flex items-center gap-5">
                    <div className="w-14 h-14 bg-indigo-500/20 rounded-2xl flex items-center justify-center text-indigo-300 border border-indigo-500/10">
                      <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                    </div>
                    <div>
                      <h4 className="font-bold text-xl truncate max-w-[200px] md:max-w-md">{file.name}</h4>
                      <p className="text-slate-500 text-sm font-medium">{formatBytes(file.size)} • {Math.ceil(file.size / CHUNK_SIZE)} chunks</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    {pendingResume && status === 'IDLE' && (
                      <button onClick={uploadFile} className="bg-amber-500 hover:bg-amber-400 text-white px-6 py-3 rounded-2xl font-bold transition-all flex items-center gap-2 shadow-lg shadow-amber-500/20">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                        Resume
                      </button>
                    )}
                    <button
                      onClick={uploadFile}
                      disabled={status === 'UPLOADING' || status === 'PROCESSING' || status === 'HASHING'}
                      className="bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-500 px-8 py-3 rounded-2xl font-bold transition-all shadow-lg shadow-indigo-500/20"
                    >
                      {status === 'IDLE' ? 'Start Upload' : status === 'COMPLETED' ? 'Upload New' : status}
                    </button>
                  </div>
                </div>

                {/* Progress Visuals */}
                {status !== 'IDLE' && (
                  <div className="space-y-6">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      <div className="bg-slate-900/40 p-4 rounded-2xl border border-white/5">
                        <p className="text-[10px] text-slate-500 uppercase font-bold tracking-widest">Progress</p>
                        <p className="text-2xl font-mono font-bold mt-1 text-indigo-400">{progress}%</p>
                      </div>
                      <div className="bg-slate-900/40 p-4 rounded-2xl border border-white/5">
                        <p className="text-[10px] text-slate-500 uppercase font-bold tracking-widest">Speed</p>
                        <p className="text-2xl font-mono font-bold mt-1 text-indigo-400">{formatSpeed(speed)}</p>
                      </div>
                      <div className="bg-slate-900/40 p-4 rounded-2xl border border-white/5">
                        <p className="text-[10px] text-slate-500 uppercase font-bold tracking-widest">ETA</p>
                        <p className="text-2xl font-mono font-bold mt-1 text-indigo-400">{formatEta(eta)}</p>
                      </div>
                      <div className="bg-slate-900/40 p-4 rounded-2xl border border-white/5">
                        <p className="text-[10px] text-slate-500 uppercase font-bold tracking-widest">Chunks</p>
                        <p className="text-2xl font-mono font-bold mt-1 text-indigo-400">{uploadStats.uploaded}/{uploadStats.total}</p>
                      </div>
                    </div>

                    <div className="space-y-3">
                      <div className="h-3 w-full bg-slate-900 rounded-full overflow-hidden">
                        <div className="h-full bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 transition-all duration-500 shadow-[0_0_20px_rgba(99,102,241,0.5)]" style={{ width: `${progress}%` }} />
                      </div>

                      {/* Matrix Grid */}
                      <div className="flex flex-wrap gap-1 p-4 bg-slate-900/60 rounded-[1.5rem] border border-white/5 max-h-40 overflow-y-auto custom-scrollbar">
                        {Object.entries(chunkStates).map(([index, state]) => (
                          <div key={index} className={`w-3 h-3 rounded-sm transition-all duration-300 ${state === 'pending' ? 'bg-slate-800' : state === 'uploading' ? 'bg-indigo-500 shadow-[0_0_10px_rgba(99,102,241,0.6)] animate-pulse' : state === 'success' ? 'bg-emerald-500' : 'bg-red-500'}`} />
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Results Area */}
          {result && (
            <div className="lg:col-span-12 animate-in fade-in zoom-in duration-500">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="glass-card p-6 rounded-[2rem] border-emerald-500/20 bg-emerald-500/5">
                  <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-[0.2em]">Authenticity Verified</span>
                  <p className="text-xs font-mono text-emerald-200/60 mt-2 break-all">{result.finalHash}</p>
                </div>
                {result.zipContent && (
                  <div className="glass-card p-6 rounded-[2rem] space-y-4">
                    <h5 className="font-bold text-sm uppercase tracking-widest text-slate-400">Archive Manifest</h5>
                    <div className="max-h-32 overflow-y-auto space-y-2 custom-scrollbar pr-2">
                      {result.zipContent.map((item, idx) => (
                        <div key={idx} className="flex justify-between items-center text-xs p-2 hover:bg-white/5 rounded-xl transition-colors">
                          <span className="truncate pr-4">{item.name}</span>
                          <span className="text-slate-500 shrink-0">{(item.size / 1024).toFixed(1)} KB</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* History Sidebar/Section */}
          <div className="lg:col-span-12 space-y-6 mt-6">
            <div className="flex items-center justify-between border-b border-white/5 pb-4">
              <h3 className="text-2xl font-bold flex items-center gap-2">
                Recent Uploads
                <span className="text-xs font-medium text-slate-500 bg-slate-900 px-3 py-1 rounded-full">{history.length}</span>
              </h3>
              {history.length > 0 && (
                <button onClick={async () => { await clearHistory(); loadHistory(); }} className="text-xs font-bold text-slate-500 hover:text-red-400 transition-colors uppercase tracking-widest">Clear Index</button>
              )}
            </div>

            <div className="grid grid-cols-1 gap-4">
              {history.length === 0 ? (
                <div className="text-center py-20 bg-slate-900/30 rounded-[3rem] border border-dashed border-slate-800">
                  <p className="text-slate-500 font-medium italic">No transfer records found in storage.</p>
                </div>
              ) : (
                history.map((item, idx) => (
                  <div key={idx} className="glass-card p-5 rounded-[2rem] flex items-center justify-between group">
                    <div className="flex items-center gap-5">
                      <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${item.status === 'SUCCESS' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                        {item.status === 'SUCCESS' ? (
                          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" /></svg>
                        ) : (
                          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
                        )}
                      </div>
                      <div>
                        <h5 className="font-bold text-sm truncate max-w-[150px] md:max-w-md">{item.filename}</h5>
                        <p className="text-[10px] text-slate-500 font-bold uppercase tracking-tight">{formatBytes(item.size)} • {formatTime(item.timestamp)}</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-4">
                      <span className={`text-[10px] font-bold uppercase tracking-widest px-3 py-1.5 rounded-full ${item.status === 'SUCCESS' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                        {item.status === 'SUCCESS' ? 'Success' : 'Failed'}
                      </span>
                      <button className="opacity-0 group-hover:opacity-100 transition-opacity p-2 hover:bg-white/5 rounded-xl text-slate-500 hover:text-white">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a2 2 0 002 2h12a2 2 0 002-2v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* System Error Notification */}
        {error && (
          <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-bottom-12 duration-500 max-w-sm w-full">
            <div className="bg-red-500 text-white p-4 rounded-3xl shadow-2xl flex items-center gap-4 border border-red-400/50">
              <div className="bg-white/20 p-2 rounded-xl">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
              </div>
              <p className="text-sm font-bold flex-1">{error}</p>
              <button onClick={() => setError(null)} className="hover:bg-white/10 p-1 rounded-lg">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

export default App;
