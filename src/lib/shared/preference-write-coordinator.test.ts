// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { withPreferenceWriteLock } from './preference-write-coordinator';

function indexedDbRuntime() {
    let requestCount = 0;
    let aborted = false;
    let pending = 0;
    const close = vi.fn();
    const tx = {
        onabort: null as (() => void) | null,
        onerror: null,
        oncomplete: null as (() => void) | null,
        abort: vi.fn(() => {
            aborted = true;
            tx.onabort?.();
        }),
        objectStore: () => ({
            get: () => {
                pending++;
                requestCount++;
                const request = { onsuccess: null as (() => void) | null, onerror: null };
                setTimeout(() => {
                    pending--;
                    if (aborted) return;
                    request.onsuccess?.();
                    if (!pending)
                        setTimeout(() => {
                            if (!aborted) tx.oncomplete?.();
                        }, 0);
                }, 0);
                return request;
            },
        }),
    };
    const database = {
        close,
        onversionchange: null as (() => void) | null,
        objectStoreNames: { contains: () => true },
        transaction: () => tx,
    };
    const factory = {
        open: () => {
            const request = {
                result: database,
                onupgradeneeded: null,
                onsuccess: null as (() => void) | null,
                onerror: null,
            };
            setTimeout(() => request.onsuccess?.(), 0);
            return request;
        },
    } as unknown as IDBFactory;
    return {
        runtime: { indexedDB: factory },
        close,
        tx,
        database,
        get requestCount() {
            return requestCount;
        },
    };
}

// Model IDB scheduling across connections: readonly transactions may overlap,
// while readwrite transactions exclude every other transaction on the store.
function scheduledIndexedDbRuntime() {
    type Request = { onsuccess: (() => void) | null; onerror: (() => void) | null };
    type TransactionMode = 'readonly' | 'readwrite';
    interface Transaction {
        mode: TransactionMode;
        active: boolean;
        ended: boolean;
        pending: number;
        operations: Array<() => void>;
        onabort: (() => void) | null;
        onerror: (() => void) | null;
        oncomplete: (() => void) | null;
        abort(): void;
        objectStore(): { get(): Request };
    }
    const transactions: Transaction[] = [];
    const schedule = (): void => {
        for (const tx of transactions) {
            if (tx.ended) continue;
            if (!tx.active) {
                const earlier = transactions.slice(0, transactions.indexOf(tx));
                if (
                    earlier.some(
                        (other) =>
                            !other.ended && (other.mode === 'readwrite' || tx.mode === 'readwrite'),
                    )
                )
                    continue;
                tx.active = true;
            }
            for (const operation of tx.operations.splice(0)) setTimeout(operation, 0);
        }
    };
    const finish = (tx: Transaction, aborted = false): void => {
        if (tx.ended) return;
        tx.ended = true;
        if (aborted) tx.onabort?.();
        else tx.oncomplete?.();
        schedule();
    };
    const factory = {
        open: () => {
            const database = {
                close: vi.fn(),
                onversionchange: null,
                objectStoreNames: { contains: () => true },
                transaction: (_name: string, mode: TransactionMode = 'readonly') => {
                    const tx: Transaction = {
                        mode,
                        active: false,
                        ended: false,
                        pending: 0,
                        operations: [],
                        onabort: null,
                        onerror: null,
                        oncomplete: null,
                        abort: () => finish(tx, true),
                        objectStore: () => ({
                            get: () => {
                                const request: Request = { onsuccess: null, onerror: null };
                                tx.pending++;
                                tx.operations.push(() => {
                                    if (tx.ended) return;
                                    tx.pending--;
                                    request.onsuccess?.();
                                    if (!tx.pending)
                                        setTimeout(() => {
                                            if (!tx.pending) finish(tx);
                                        }, 0);
                                });
                                schedule();
                                return request;
                            },
                        }),
                    };
                    transactions.push(tx);
                    return tx;
                },
            };
            const request = { result: database, onsuccess: null as (() => void) | null };
            setTimeout(() => request.onsuccess?.(), 0);
            return request;
        },
    } as unknown as IDBFactory;
    return { runtime: { indexedDB: factory, locks: null }, transactions };
}

describe('origin preference write coordination', () => {
    it('serializes two fallback HTTP writes across database connections', async () => {
        const idb = scheduledIndexedDbRuntime();
        const committed: string[] = [];
        let completeFirst!: () => void;
        const firstHttp = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    completeFirst = () => {
                        committed.push('de');
                        resolve();
                    };
                }),
        );
        const secondHttp = vi.fn(async () => {
            committed.push('ja');
        });
        const first = withPreferenceWriteLock(
            'account',
            firstHttp,
            new AbortController().signal,
            idb.runtime,
        );
        await vi.waitFor(() => expect(firstHttp).toHaveBeenCalledOnce());
        const second = withPreferenceWriteLock(
            'account',
            secondHttp,
            new AbortController().signal,
            idb.runtime,
        );
        await vi.waitFor(() => expect(idb.transactions).toHaveLength(2));
        // Both initial IDB reads have had an event-loop turn. A readonly
        // mutation would dispatch the second HTTP request during this window.
        await new Promise((resolve) => setTimeout(resolve, 20));
        try {
            expect(secondHttp).not.toHaveBeenCalled();
            expect(committed).toEqual([]);
        } finally {
            completeFirst();
            await Promise.all([first, second]);
        }
        expect(committed).toEqual(['de', 'ja']);
        expect(secondHttp).toHaveBeenCalledOnce();
    });
    it('retains work without dispatch when both coordination APIs are unavailable', async () => {
        const task = vi.fn();
        await expect(
            withPreferenceWriteLock('account', task, new AbortController().signal, {}),
        ).rejects.toThrow('unavailable');
        expect(task).not.toHaveBeenCalled();
    });
    it('holds the IDB transaction until the network task finishes and then closes it', async () => {
        const idb = indexedDbRuntime();
        let finish!: (value: number) => void;
        const task = vi.fn<(signal?: AbortSignal) => Promise<number>>(
            () =>
                new Promise<number>((resolve) => {
                    finish = resolve;
                }),
        );
        const pending = withPreferenceWriteLock(
            'account',
            task,
            new AbortController().signal,
            idb.runtime,
        );
        await vi.waitFor(() => expect(task).toHaveBeenCalledOnce());
        expect(task.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
        expect(idb.close).not.toHaveBeenCalled();
        finish(42);
        await expect(pending).resolves.toBe(42);
        expect(idb.close).toHaveBeenCalledOnce();
        expect(idb.requestCount).toBeLessThan(20_001);
    });
    it.each(['cleanup', 'versionchange'] as const)(
        'aborts the IDB task and closes its transaction on %s',
        async (kind) => {
            const idb = indexedDbRuntime();
            const external = new AbortController();
            let networkSignal: AbortSignal | undefined;
            const task = vi.fn((signal?: AbortSignal) => {
                networkSignal = signal;
                return new Promise<number>(() => {});
            });
            const pending = withPreferenceWriteLock('account', task, external.signal, idb.runtime);
            const rejected = expect(pending).rejects.toThrow();
            await vi.waitFor(() => expect(task).toHaveBeenCalledOnce());
            if (kind === 'cleanup') external.abort();
            else idb.database.onversionchange?.();
            await rejected;
            expect(networkSignal?.aborted).toBe(true);
            expect(idb.tx.abort).toHaveBeenCalledOnce();
            expect(idb.close).toHaveBeenCalledOnce();
        },
    );
});
