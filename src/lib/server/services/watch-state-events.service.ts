// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/lib/server/services/watch-state-events.service.ts

import type { UserId } from '$lib/shared/user-id.js';
import { Logger } from '../utils/logger.js';

const logger = Logger.for('WatchStateEvents');

// ---------------------------------------------------------------------------
// Event type definitions
//
// Two channels, coalesced server-side per user:
//
//   • watch_state_set_changed — fires only when CW / new-episodes /
//     watch-status set membership could have changed (mark / clear /
//     auto-complete / sync). NOT a heartbeat. Consumed by ForYou + browse to
//     refetch their watching strips.
//
//   • session_changed — fires on session lifecycle transitions for ALL
//     sources: Lumastra (start, pause↔active, stop, crash) AND external
//     (Jellyfin / ABS / LiveTV / music — first sighting, status flip,
//     vanish). Consumed by ForYou (CW refetch) and admin/sessions.
//
// Watch changes also publish through the cross-pod user hub in one-second
// windows, including the final chunk of a burst. Session changes stay local.
// Coalescing key is the user only — set membership consumers refetch the
// whole CW strip and don't care which mediaId triggered the bump.
// ---------------------------------------------------------------------------

type WatchStateSetChangedEvent = {
    type: 'watch_state_set_changed';
    mediaId: string;
    reason: string;
    at: number;
};

type SessionChangedEvent = {
    type: 'session_changed';
    sessionId: string;
    status: string;
    mediaId: string;
    at: number;
};

type WatchStateEvent = WatchStateSetChangedEvent | SessionChangedEvent;

type Listener = (event: WatchStateEvent) => void;

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

const COALESCE_WINDOW_MS = 1_000;

/** Event types that are coalesced to at most one emit per username per window. */
type CoalescedEventType = WatchStateEvent['type'];

class WatchStateEventEmitter {
    private listeners = new Map<UserId, Set<Listener>>();
    private lastEmitAt = new Map<string, number>();
    private pendingWatchChanges = new Map<UserId, ReturnType<typeof setTimeout>>();

    /**
     * A worker has no local SSE listeners. Publish through the shared user hub
     * after cache eviction so web replicas refetch committed, fresh state.
     * Fixed windows bound the work during long imports and retain the final
     * chunk of a burst (dropping coalesced events would lose that last update).
     */
    private queueWatchChange(userId: UserId, event: Omit<WatchStateSetChangedEvent, 'at'>): void {
        if (this.pendingWatchChanges.has(userId)) return;
        const timer = setTimeout(() => {
            this.pendingWatchChanges.delete(userId);
            void (async () => {
                const { invalidateAllWatchedCaches } = await import('./watched-cache.service.js');
                await invalidateAllWatchedCaches(userId);
                const { publishUserEvent } = await import('./notification-events.service.js');
                await publishUserEvent({
                    userId,
                    kind: event.type,
                    data: { ...event, at: Date.now() },
                    persist: false,
                    replay: false,
                });
            })().catch((error: unknown) => {
                logger.warn('Failed to publish watch change', { userId, error });
            });
        }, COALESCE_WINDOW_MS);
        timer.unref?.();
        this.pendingWatchChanges.set(userId, timer);
    }

    subscribe(userId: UserId, listener: Listener): () => void {
        let set = this.listeners.get(userId);
        if (!set) {
            set = new Set();
            this.listeners.set(userId, set);
        }
        set.add(listener);
        return () => {
            set?.delete(listener);
            if (set && set.size === 0) this.listeners.delete(userId);
        };
    }

    emit(userId: UserId, event: Omit<WatchStateSetChangedEvent, 'at'>): void;
    emit(userId: UserId, event: Omit<SessionChangedEvent, 'at'>): void;
    emit(
        userId: UserId,
        event: Omit<WatchStateSetChangedEvent, 'at'> | Omit<SessionChangedEvent, 'at'>,
    ): void {
        if (event.type === 'watch_state_set_changed') this.queueWatchChange(userId, event);

        // Check for listeners before updating the coalescing map so that a
        // no-listener emit does not burn the window for a subscriber that
        // connects 100ms later.
        const set = this.listeners.get(userId);
        if (!set) return;

        // Coalesce: max 1 emit per (username, eventType) per window.
        // First event in a window wins; subsequent events in the same window
        // are dropped. Set membership refetches don't care which mediaId
        // changed, so per-username keying is sufficient.
        if (this.shouldDropAsCoalesced(userId, event.type)) return;

        const payload: WatchStateEvent = {
            ...event,
            at: Date.now(),
        };
        for (const listener of set) {
            try {
                listener(payload);
            } catch {
                /* swallow */
            }
        }
    }

    private shouldDropAsCoalesced(userId: UserId, type: CoalescedEventType): boolean {
        const key = `${userId}\x00${type}`;
        const now = Date.now();
        const last = this.lastEmitAt.get(key) ?? 0;
        // Guard against backward wall-clock jumps (NTP correction, manual
        // change): a negative delta would drop all events until the skew
        // elapsed, so force-pass and reset the anchor instead.
        if (now < last) {
            this.lastEmitAt.set(key, now);
            return false;
        }
        if (now - last < COALESCE_WINDOW_MS) return true;
        this.lastEmitAt.set(key, now);
        return false;
    }

    /** Reset internal coalescing state. Tests only — not part of the public API. */
    __resetForTests(): void {
        for (const timer of this.pendingWatchChanges.values()) clearTimeout(timer);
        this.pendingWatchChanges.clear();
        this.lastEmitAt.clear();
        this.listeners.clear();
    }
}

export const watchStateEvents = new WatchStateEventEmitter();
export type { WatchStateEvent, WatchStateSetChangedEvent, SessionChangedEvent };
