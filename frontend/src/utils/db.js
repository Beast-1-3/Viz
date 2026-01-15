import { openDB } from 'idb';

const DB_NAME = 'UploadDB';
const STORE_NAME = 'uploads';
const HISTORY_STORE = 'history';

const dbPromise = openDB(DB_NAME, 2, {
    upgrade(db, oldVersion) {
        if (oldVersion < 1) {
            db.createObjectStore(STORE_NAME);
        }
        if (oldVersion < 2) {
            db.createObjectStore(HISTORY_STORE, { keyPath: 'fileHash' });
        }
    },
});

export const saveUploadState = async (fileHash, state) => {
    const db = await dbPromise;
    await db.put(STORE_NAME, state, fileHash);
};

export const getUploadState = async (fileHash) => {
    const db = await dbPromise;
    return await db.get(STORE_NAME, fileHash);
};

export const deleteUploadState = async (fileHash) => {
    const db = await dbPromise;
    await db.delete(STORE_NAME, fileHash);
};

export const saveHistory = async (historyItem) => {
    const db = await dbPromise;
    await db.put(HISTORY_STORE, historyItem);
};

export const getHistory = async () => {
    const db = await dbPromise;
    return await db.getAll(HISTORY_STORE);
};

export const clearHistory = async () => {
    const db = await dbPromise;
    await db.clear(HISTORY_STORE);
};

export const deleteHistoryItem = async (fileHash) => {
    const db = await dbPromise;
    await db.delete(HISTORY_STORE, fileHash);
};

