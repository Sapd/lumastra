// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { runSSEBus } from '$lib/stores/run-sse-bus.js';

/** Reconcile canonical domain data after a lost event and while the tab is visible. */
export function startVisibleRefresh(refresh: () => Promise<void>, intervalMs = 15_000): () => void {
    let destroyed = false;
    let running = false;
    let again = false;
    let connected = runSSEBus.connected;
    async function reconcile(): Promise<void> {
        if (destroyed || document.hidden) return;
        if (running) {
            again = true;
            return;
        }
        running = true;
        try {
            await refresh();
        } catch {
            /* The owner retains and labels its prior data. */
        } finally {
            running = false;
            if (again && !destroyed) {
                again = false;
                void reconcile();
            }
        }
    }
    const wake = (): void => {
        void reconcile();
    };
    const unsubscribe = runSSEBus.onAnyChange(() => {
        const next = runSSEBus.connected;
        if (next && !connected) wake();
        connected = next;
    });
    const timer = setInterval(wake, intervalMs);
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    window.addEventListener('pageshow', wake);
    window.addEventListener('online', wake);
    return () => {
        destroyed = true;
        clearInterval(timer);
        unsubscribe();
        document.removeEventListener('visibilitychange', wake);
        window.removeEventListener('focus', wake);
        window.removeEventListener('pageshow', wake);
        window.removeEventListener('online', wake);
    };
}
