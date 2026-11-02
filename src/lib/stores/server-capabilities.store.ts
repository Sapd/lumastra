// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/lib/stores/server-capabilities.store.ts
import { writable, type Readable } from 'svelte/store';
import type { ServerCapabilities } from '$lib/schemas/server-info.js';
import { getServerInfo } from '$lib/api/server.js';

interface CapabilitiesState {
    data: ServerCapabilities | null;
    loading: boolean;
    unauthenticated: boolean;
    error: string | null;
}

function createCapabilitiesStore(): Readable<CapabilitiesState> & {
    fetch(): Promise<void>;
} {
    const { subscribe, set, update } = writable<CapabilitiesState>({
        data: null,
        loading: false,
        unauthenticated: false,
        error: null,
    });

    let fetchPromise: Promise<void> | null = null;
    let retryAfter = 0;

    async function doFetch(): Promise<void> {
        update((s) => ({ ...s, loading: true, error: null }));
        try {
            const { data, error } = await getServerInfo();
            if (!error && data?.caller === null) {
                set({ data: null, loading: false, error: null, unauthenticated: true });
                return; // Cache anonymous discovery for this browser session too.
            }
            if (error || !data || !('capabilities' in data)) {
                retryAfter = Date.now() + 5_000;
                set({
                    data: null,
                    loading: false,
                    unauthenticated: false,
                    error: error ?? 'Failed to load capabilities',
                });
                fetchPromise = null; // Allow retry on next call
                return;
            }
            set({ data: data.capabilities, loading: false, error: null, unauthenticated: false });
        } catch (err) {
            retryAfter = Date.now() + 5_000;
            fetchPromise = null; // Allow retry on next call
            const message = err instanceof Error ? err.message : 'Failed to load capabilities';
            set({ data: null, loading: false, error: message, unauthenticated: false });
        }
    }

    return {
        subscribe,
        fetch(): Promise<void> {
            // Only fetch once; reuse in-flight promise
            if (Date.now() < retryAfter) return Promise.resolve();
            if (!fetchPromise) {
                fetchPromise = doFetch();
            }
            return fetchPromise;
        },
    };
}

export const serverCapabilities = createCapabilitiesStore();
