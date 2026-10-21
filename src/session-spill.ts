// 大会话内容溢写：localStorage 配额约 5MB，>1MB 的未保存内容无法写入，
// 强制退出时这些修改会丢失（W10）。此处用 IndexedDB 保存「大且脏」的标签内容，
// 启动恢复时优先回读；其余状态仍走 localStorage，避免同步读写大字符串卡主线程。

export interface SpillRecord {
  path: string;
  content: string;
  saved: string;
  dirty: boolean;
  cursor: number | null;
  ts: number;
}

const DB_NAME = "litemd-session-spill";
const STORE = "tabs";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") {
        resolve(null);
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "path" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function finish(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

/** 写入/覆盖一条溢写记录；IndexedDB 不可用或配额不足时静默失败（仍会提示） */
export async function putSpill(rec: SpillRecord): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(rec);
    await finish(tx);
  } catch {
    /* 配额/隐私模式：放弃本次溢写，下次编辑会再次尝试 */
  }
}

/** 删除若干路径的溢写记录（标签已保存/关闭/不再是大脏文档） */
export async function deleteSpills(paths: string[]): Promise<void> {
  if (!paths.length) return;
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const p of paths) store.delete(p);
    await finish(tx);
  } catch {
    /* ignore */
  }
}

/** 读取指定路径的溢写记录（启动恢复用，只取当前会话涉及的路径） */
export async function getSpills(paths: string[]): Promise<Map<string, SpillRecord>> {
  const out = new Map<string, SpillRecord>();
  if (!paths.length) return out;
  const db = await openDb();
  if (!db) return out;
  try {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    await Promise.all(
      paths.map(
        (p) =>
          new Promise<void>((resolve) => {
            const req = store.get(p);
            req.onsuccess = () => {
              const v = req.result as SpillRecord | undefined;
              if (v && typeof v.content === "string" && v.dirty) out.set(p, v);
              resolve();
            };
            req.onerror = () => resolve();
          })
      )
    );
    await finish(tx);
  } catch {
    /* ignore */
  }
  return out;
}
