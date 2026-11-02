// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

export interface PreferenceWriteRuntime {
    locks?: Pick<LockManager, 'request'> | null;
    indexedDB?: IDBFactory;
}
const WAIT_LIMIT_MS = 31_000;
const KEEPALIVE_LIMIT = 20_000;

/** Serialize live preference PATCHes across the origin, not only within one tab. */
export async function withPreferenceWriteLock<T>(
    epoch: string,
    task: (signal?: AbortSignal) => Promise<T>,
    signal: AbortSignal,
    runtime: PreferenceWriteRuntime = {
        locks: globalThis.navigator?.locks,
        indexedDB: globalThis.indexedDB,
    },
): Promise<T> {
    if (signal.aborted) throw new Error('Preference context retired');
    if (runtime.locks?.request) {
        return runtime.locks.request(`lumastra:preferences:${epoch}`, { signal }, async () => {
            if (signal.aborted) throw new Error('Preference context retired');
            return task();
        });
    }
    if (!runtime.indexedDB) throw new Error('Preference write coordination unavailable');
    return withIndexedDbLock(runtime.indexedDB, task, signal);
}

/** IDB read/write transactions are origin-wide mutexes. No account data is stored here. */
function withIndexedDbLock<T>(
    factory: IDBFactory,
    task: (signal?: AbortSignal) => Promise<T>,
    external: AbortSignal,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const controller = new AbortController();
        let database: IDBDatabase | undefined;
        let transaction: IDBTransaction | undefined;
        let settled = false;
        let started = false;
        let finished = false;
        let result: T;
        let requests = 0;
        const finish = (error?: unknown): void => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            external.removeEventListener('abort', cancel);
            database?.close();
            if (error) reject(error);
            else resolve(result);
        };
        const cancel = (): void => {
            controller.abort();
            try {
                transaction?.abort();
            } catch {
                /* already committed/aborted */
            }
            finish(new Error('Preference write coordination cancelled'));
        };
        const deadline = setTimeout(cancel, WAIT_LIMIT_MS);
        external.addEventListener('abort', cancel, { once: true });
        const open = factory.open('lumastra-preference-writes', 1);
        open.onupgradeneeded = () => {
            if (!open.result.objectStoreNames.contains('mutex'))
                open.result.createObjectStore('mutex');
        };
        open.onerror = () => finish(open.error ?? new Error('Preference coordinator unavailable'));
        open.onsuccess = () => {
            database = open.result;
            if (settled || external.aborted) {
                database.close();
                cancel();
                return;
            }
            database.onversionchange = cancel;
            try {
                transaction = database.transaction('mutex', 'readwrite');
                transaction.onabort = () =>
                    finish(transaction?.error ?? new Error('Preference coordinator aborted'));
                transaction.onerror = () => cancel();
                transaction.oncomplete = () =>
                    finished ? finish() : finish(new Error('Preference coordinator ended early'));
                const store = transaction.objectStore('mutex');
                const keepAlive = (): void => {
                    if (settled || finished) return;
                    if (++requests > KEEPALIVE_LIMIT) {
                        cancel();
                        return;
                    }
                    const request = store.get(0);
                    request.onerror = cancel;
                    request.onsuccess = () => {
                        if (settled) return;
                        if (!started) {
                            started = true;
                            void Promise.resolve()
                                .then(() => task(controller.signal))
                                .then(
                                    (value) => {
                                        result = value;
                                        finished = true;
                                    },
                                    (error: unknown) => {
                                        cancel();
                                        finish(error);
                                    },
                                );
                        }
                        // Bound both elapsed time and request count. Each IDB event yields
                        // to the browser; stop issuing reads as soon as the PATCH settles.
                        keepAlive();
                    };
                };
                keepAlive();
            } catch (error) {
                controller.abort();
                finish(error);
            }
        };
    });
}
