// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * THE one poller for all admin chrome (admin IA redesign, spec §5).
 *
 * Every admin surface that shows a status, a verdict, an attention item or a
 * counter reads this store — the bell, Home, Health findings and nav dots can
 * never disagree because they render the same object.
 *
 * Live updates PATCH, never replace (spec §5): a fresh payload is merged into
 * the existing one keeping array item identity by `id`, so keyed `{#each}`
 * blocks keep their DOM nodes and no list rebuilds under the user's cursor.
 */

import { browser } from '$app/environment';
import { getAdminStatusPayload, ackAttentionItem, snoozeAttentionItem } from '$lib/api/admin.js';
import type { AdminStatusPayload } from '$lib/schemas/api-admin-status-payload.js';
import { classifyError, type ClassifiedError } from '$lib/utils/admin/error-contract.js';

const POLL_INTERVAL_MS = 30_000;

/** Identity-preserving element merge: reuse the previous object when the same
 *  keyed element is (deep-)unchanged, so Svelte keyed each-blocks keep DOM. */
function mergeArrayById<T>(
    prev: readonly T[] | undefined,
    next: readonly T[] | undefined,
    keyOf: (item: T) => string,
): T[] | undefined {
    if (!next) return undefined;
    if (!prev || prev.length === 0) return [...next];
    const prevByKey = new Map(prev.map((p) => [keyOf(p), p]));
    let allSame = prev.length === next.length;
    const merged = next.map((n, i) => {
        const p = prevByKey.get(keyOf(n));
        if (p !== undefined && JSON.stringify(p) === JSON.stringify(n)) {
            if (allSame && prev[i] !== p) allSame = false;
            return p;
        }
        allSame = false;
        return n;
    });
    // Whole array unchanged → keep the previous ARRAY reference too, so
    // downstream $derived over the array doesn't recompute.
    return allSame ? (prev as T[]) : merged;
}

/**
 * Merge a freshly fetched payload into the previous one, preserving object
 * identity for unchanged array items (keyed by `id`). Exported for unit tests.
 */
export function mergePayload(
    prev: AdminStatusPayload | null,
    next: AdminStatusPayload,
): AdminStatusPayload {
    if (!prev) return next;
    return {
        ...next,
        attention: {
            ...next.attention,
            items:
                mergeArrayById(prev.attention.items, next.attention.items, (i) => i.id) ??
                next.attention.items,
            recentlyAdded: mergeArrayById(
                prev.attention.recentlyAdded,
                next.attention.recentlyAdded,
                (i) => i.id,
            ),
            resolvedHistory: mergeArrayById(
                prev.attention.resolvedHistory,
                next.attention.resolvedHistory,
                (i) => i.id,
            ),
        },
        sessions: {
            ...next.sessions,
            preview:
                mergeArrayById(prev.sessions.preview, next.sessions.preview, (s) => s.sessionId) ??
                next.sessions.preview,
        },
    };
}

class AdminStatusStore {
    #payload = $state<AdminStatusPayload | null>(null);
    #error = $state<ClassifiedError | null>(null);
    #loading = $state(true);
    #refreshing = $state(false);
    #lastUpdatedAt = $state<Date | null>(null);

    #refCount = 0;
    #timer: ReturnType<typeof setInterval> | null = null;
    #inFlight = false;
    #onVisibility = (): void => {
        if (!document.hidden) void this.refresh();
    };

    /** The canonical payload; null before the first successful fetch. */
    get payload(): AdminStatusPayload | null {
        return this.#payload;
    }

    /**
     * Last fetch error, classified (spec §7 error contract) — `class`
     * distinguishes network/auth/server/data so a dead network can never
     * render as "session expired", or null when the last fetch succeeded.
     */
    get error(): ClassifiedError | null {
        return this.#error;
    }

    /** True only before the first payload has arrived. */
    get loading(): boolean {
        return this.#loading;
    }

    /** True while a refresh is in flight (initial or subsequent). */
    get refreshing(): boolean {
        return this.#refreshing;
    }

    get lastUpdatedAt(): Date | null {
        return this.#lastUpdatedAt;
    }

    /**
     * Ref-counted start: the first caller begins the 30 s poll loop (paused
     * while the tab is hidden). Call from any admin chrome component; pair
     * with stop() on destroy.
     */
    start(): void {
        if (!browser) return;
        this.#refCount += 1;
        if (this.#refCount > 1) return;
        void this.refresh();
        this.#timer = setInterval(() => {
            if (document.hidden) return; // pause polling while hidden
            void this.refresh();
        }, POLL_INTERVAL_MS);
        document.addEventListener('visibilitychange', this.#onVisibility);
    }

    stop(): void {
        if (!browser) return;
        this.#refCount = Math.max(0, this.#refCount - 1);
        if (this.#refCount > 0) return;
        if (this.#timer) {
            clearInterval(this.#timer);
            this.#timer = null;
        }
        document.removeEventListener('visibilitychange', this.#onVisibility);
    }

    /** Fetch the payload now and merge it in place. Concurrent calls coalesce. */
    async refresh(): Promise<void> {
        if (this.#inFlight) return;
        this.#inFlight = true;
        this.#refreshing = true;
        try {
            const { data, error, status } = await getAdminStatusPayload();
            if (error || !data) {
                // `status` is 0 for network/timeout failures and the real HTTP
                // code otherwise (`$lib/api/client.ts`) — classifyError's
                // invariant (spec §7) guarantees status 0 is NEVER 'auth'.
                this.#error = classifyError(new Error(error ?? 'Unknown error'), { status });
                return;
            }
            this.#payload = mergePayload(this.#payload, data);
            this.#error = null;
            this.#lastUpdatedAt = new Date();
        } finally {
            this.#inFlight = false;
            this.#refreshing = false;
            this.#loading = false;
        }
    }

    /**
     * Acknowledge one attention item: optimistic in-place patch (the item
     * greys out everywhere at once), then POST, then a refresh for the
     * canonical verdict/sectionStatus. A failed POST also refreshes — the
     * server state simply wins back.
     */
    async ack(id: string): Promise<void> {
        const item = this.#payload?.attention.items.find((i) => i.id === id);
        // Already acked (double click, or two surfaces): a second decrement would
        // push the bell count below the real number until the next refresh.
        if (!item || item.acked || !this.#payload) return;
        const fingerprint = item.fingerprint;
        // Optimistic patch, keeping every other item's identity.
        this.#payload = {
            ...this.#payload,
            attention: {
                ...this.#payload.attention,
                items: this.#payload.attention.items.map((i) =>
                    i.id === id ? { ...i, acked: true } : i,
                ),
                unreadCount: Math.max(0, this.#payload.attention.unreadCount - 1),
            },
        };
        await ackAttentionItem({ id, fingerprint });
        await this.forceRefresh();
    }

    /** Snooze one attention item until `untilIso` (time-boxed suppression). */
    async snooze(id: string, untilIso: string): Promise<void> {
        const item = this.#payload?.attention.items.find((i) => i.id === id);
        if (!item || !this.#payload) return;
        const durationMs = Math.max(1, new Date(untilIso).getTime() - Date.now());
        this.#payload = {
            ...this.#payload,
            attention: {
                ...this.#payload.attention,
                items: this.#payload.attention.items.map((i) =>
                    i.id === id ? { ...i, snoozed: true, snoozedUntil: untilIso } : i,
                ),
            },
        };
        await snoozeAttentionItem({ id, fingerprint: item.fingerprint, durationMs });
        await this.forceRefresh();
    }

    /** Refresh even if a poll is mid-flight (used after mutations). */
    async forceRefresh(): Promise<void> {
        // Wait out any in-flight poll, then fetch fresh.
        while (this.#inFlight) {
            await new Promise((r) => setTimeout(r, 50));
        }
        await this.refresh();
    }
}

/** The one admin status store instance (spec §5: one source of truth). */
export const adminStatus = new AdminStatusStore();
