// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { WatcherLeader, WATCHER_NATIVE_BACKLOG_LIMIT } from './watcher.js';
import { WatcherRescanCoalescer } from './watcher-rescan.js';
import type { AsyncSemaphore } from '../../../../../../utils/async-semaphore.js';

interface Internals {
    pendingDebounces: Map<string, ReturnType<typeof setTimeout>>;
    ingestLimiter: AsyncSemaphore;
    rescan: WatcherRescanCoalescer;
    scheduleProcess(path: string): void;
    dispatchWatcherEvent(event: 'add' | 'change' | 'unlink', path: string): void;
    handleUnlink(path: string): Promise<void>;
}

describe('native watcher Node admission bound', () => {
    it('bounds pending timers and requests reconciliation for dropped detail', () => {
        const watcher = new WatcherLeader(vi.fn());
        const internal = watcher as unknown as Internals;
        internal.rescan = new WatcherRescanCoalescer(vi.fn(), vi.fn());
        const rescan = vi.spyOn(internal.rescan, 'request');
        const timer = setTimeout(() => {}, 60_000);
        try {
            for (let i = 0; i < WATCHER_NATIVE_BACKLOG_LIMIT; i++)
                internal.pendingDebounces.set(`/media/${i}.mkv`, timer);
            internal.scheduleProcess('/media/overflow.mkv');
            expect(internal.pendingDebounces.size).toBe(WATCHER_NATIVE_BACKLOG_LIMIT);
            expect(rescan).toHaveBeenCalledOnce();
            const remove = vi.spyOn(internal, 'handleUnlink');
            internal.dispatchWatcherEvent('unlink', '/media/removed.mkv');
            expect(remove).not.toHaveBeenCalled();
            expect(rescan).toHaveBeenCalledTimes(2);
        } finally {
            clearTimeout(timer);
            internal.pendingDebounces.clear();
            internal.rescan.stop();
        }
    });
    it('includes semaphore waiters after their debounce timers have fired', () => {
        const internal = new WatcherLeader(vi.fn()) as unknown as Internals;
        internal.rescan = new WatcherRescanCoalescer(vi.fn(), vi.fn());
        const rescan = vi.spyOn(internal.rescan, 'request');
        const waiting = vi
            .spyOn(internal.ingestLimiter, 'waiting', 'get')
            .mockReturnValue(WATCHER_NATIVE_BACKLOG_LIMIT);
        try {
            internal.scheduleProcess('/media/overflow.mkv');
            expect(internal.pendingDebounces.size).toBe(0);
            expect(rescan).toHaveBeenCalledOnce();
        } finally {
            waiting.mockRestore();
            internal.rescan.stop();
        }
    });
});
