const DB_NAME = 'mxd-monitor-db'
const DB_VERSION = 1
const STORE = 'files'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法打开 IndexedDB'))
    // 必须处理 onblocked：被其他标签页/窗口的旧连接占住时，浏览器只发这个事件，
    // onsuccess 和 onerror 都不会来。不 reject 的话这个 promise 永远挂着，
    // 上层 await 会一直等下去——调用方看到的就是「点了没反应」而不是任何报错。
    request.onblocked = () =>
      reject(new Error('数据库被其他窗口占用，请关掉本应用的其它标签页后重试'))
  })
}

/**
 * 读写的公共尾巴：跑完必须 db.close()。
 *
 * 之前每次 putFile/getFile/deleteFile 都新建一个连接且从不关闭，连接会一直累积。
 * 累积的连接各自持有版本锁，一旦后续有版本升级需求就会被自己的旧连接挡住，
 * 触发 onblocked——而那时 openDb 还没处理它，整个功能就永久卡死了。
 */
function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
  fallback: string,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode)
        const request = run(tx.objectStore(STORE))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error(fallback))
        tx.oncomplete = () => db.close()
        tx.onerror = () => {
          db.close()
          reject(tx.error ?? new Error(fallback))
        }
        tx.onabort = () => {
          db.close()
          reject(tx.error ?? new Error(fallback))
        }
      }),
  )
}

/** 保存自定义报警音频（用于跨会话持久化） */
export async function putFile(key: string, blob: Blob): Promise<void> {
  await withStore(
    'readwrite',
    (store) => store.put(blob, key),
    '保存失败（浏览器存储空间可能已满）',
  )
}

export async function getFile(key: string): Promise<Blob | null> {
  const value = await withStore<Blob | undefined>('readonly', (store) => store.get(key), '读取失败')
  return value instanceof Blob ? value : null
}

export async function deleteFile(key: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(key), '删除失败')
}