// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cross-tab coordination for the music player: one tab plays at a time, and
 * moving playback between tabs continues where the music was.
 *
 * `audio-exclusivity.ts` arbitrates music vs audiobook inside ONE tab and says
 * so; this is the cross-tab half it deliberately left out. Without it, every
 * tab hydrates from the same `lumastra:music-playback` snapshot, so opening a
 * second tab while the first one plays made the new tab resume the same track
 * from the snapshot's (stale) position — two decks of the same song, seconds
 * apart, both reporting progress upstream. Observed on preprod 2026-09-29.
 *
 * ## Claims
 *
 * Starting playback makes a CLAIM, `(ts, tabId)`, ordered by time then tab id.
 * The newest claim a tab has seen decides everything:
 *
 * - A tab that receives a claim newer than its own stops playing. An OLDER
 *   claim is ignored, so two tabs claiming at the same instant (crossed
 *   messages, or several restored tabs resuming at once) end with exactly
 *   one playing instead of each pausing for the other.
 * - The tab holding the newest claim is the OWNER. Only it writes the shared
 *   snapshot and only it answers "who owns playback?", so an idle tab that
 *   never played can neither overwrite the owner's snapshot on close nor
 *   answer a new tab with a stale position. A tab learns the current claim
 *   on startup by asking.
 * - The owner heartbeats while playing. Other tabs show "playing in another
 *   tab" until it says idle (pause, stop, close) or goes silent — a crashed
 *   or discarded tab cannot leave the hint up forever.
 *
 * - The owner also broadcasts its live STATE (track, queue, position) on every
 *   change and every few seconds while playing, and answers a new tab's
 *   startup query with it. Other tabs mirror it, so a second tab shows what is
 *   actually playing — the current track and a moving position — instead of
 *   the snapshot it opened with.
 *
 * - A tab that mirrors can also steer: its seek bar, pause button, volume and
 *   mute send a COMMAND to the owner (addressed by the owner's claim), so
 *   those controls act on the music the listener hears, from any tab. Play
 *   is the exception: pressing it in a tab moves playback THERE.
 *
 * With no claim seen at all (a lone tab, or the owner is gone and nobody has
 * played since), a tab owns the snapshot: single-tab behaviour is unchanged.
 *
 * BroadcastChannel, not Web Locks: nothing here is held, so a crashed tab
 * cannot leave a lock behind that silences the next one — the failure mode
 * `audio-exclusivity.ts` warns about. Without BroadcastChannel the coordinator
 * does nothing and always owns the snapshot.
 */

export const MUSIC_TAB_CHANNEL = 'lumastra:music-player';

/**
 * How long to wait for the owner to answer. Same-origin BroadcastChannel
 * round-trips in well under this; the wait is only ever paid in full when no
 * owner is left (it was closed), and then only by a tab resuming a snapshot.
 */
export const OWNER_QUERY_TIMEOUT_MS = 200;
/** After a silence, how long a probe waits for the owner before releasing it. */
export const EXPIRY_PROBE_MS = 300;
/** How often the playing tab tells the others it is still playing. */
export const HEARTBEAT_INTERVAL_MS = 3_000;
/** Silence after which the others stop showing "playing in another tab". */
export const HEARTBEAT_EXPIRY_MS = 8_000;

export interface MusicTabClaim {
    ts: number;
    tabId: string;
}

/** Remote control from a mirroring tab to the owner. */
export type MusicTabCommand =
    | { type: 'seek'; trackId: string; positionMs: number }
    | { type: 'pause' }
    | { type: 'volume'; volume: number }
    | { type: 'mute'; muted: boolean }
    | { type: 'skip' }
    | { type: 'previous' }
    /**
     * One queue edit, applied by the owner to ITS current queue — not a whole
     * replacement list, which would undo what the owner changed meanwhile
     * (an advanced track, freshly appended smart-queue items).
     */
    | {
          type: 'queue-op';
          op: 'add' | 'add-front' | 'remove' | 'order';
          track?: unknown;
          sessionId?: string;
          id?: string;
          ids?: string[];
      };

/** What the owning tab reports about itself. */
export interface MusicTabOwnerState {
    isPlaying: boolean;
    trackId: string | null;
    positionMs: number;
    /** The owner's current track, so a taker can load it if it changed. */
    track?: unknown;
}

export type MusicTabMessage<L = unknown> =
    | { type: 'playing'; tabId: string; claim: MusicTabClaim }
    | { type: 'heartbeat'; tabId: string; claim: MusicTabClaim }
    | { type: 'idle'; tabId: string; claim: MusicTabClaim }
    | { type: 'closed'; tabId: string; claim: MusicTabClaim }
    | { type: 'who-owns'; tabId: string; queryId: string }
    | { type: 'state'; tabId: string; claim: MusicTabClaim; state: L; playing?: boolean }
    | { type: 'command'; tabId: string; claim: MusicTabClaim; command: MusicTabCommand }
    | ({
          type: 'owner-state';
          tabId: string;
          queryId: string;
          claim: MusicTabClaim;
      } & MusicTabOwnerState);

/**
 * Why the owner stopped counting as playing: it paused or stopped ('idle'),
 * went away cleanly ('closed'), or went silent past the expiry ('expired' —
 * crashed or discarded, so its last moments of play never happened).
 */
export type MusicTabIdleReason = 'idle' | 'closed' | 'expired';

export interface MusicTabSyncOptions<L = unknown> {
    /** This tab's live playback state, reported when another tab asks. */
    getState: () => MusicTabOwnerState;
    /** A newer claim arrived: stop playing here (or abort a pending start). */
    onOtherTabPlaying: (claim: MusicTabClaim) => void;
    /** The tab that took playback stopped playing, closed, or went silent. */
    onOtherTabIdle: (reason: MusicTabIdleReason) => void;
    /** The owner's live state arrived (see `broadcastState`). */
    onOwnerState?: (state: L) => void;
    /** Another tab asked who owns playback — a good moment to broadcast state. */
    onQueried?: () => void;
    /** A mirroring tab steered playback here (this tab holds the claim). */
    onCommand?: (command: MusicTabCommand) => void;
}

export interface MusicTabSync<L = unknown> {
    /** Claim playback: other tabs stop and this tab becomes the owner. */
    announcePlaying(): void;
    /** This tab stopped playing — lets the others drop their "elsewhere" hint. */
    announceIdle(): void;
    /** This tab is going away (pagehide): release its claim in the others. */
    announceClosed(): void;
    /** Ask the owning tab for its state; null if no other tab owns playback. */
    queryOwner(timeoutMs?: number): Promise<MusicTabOwnerState | null>;
    /** Whether this tab may write (or clear) the shared playback snapshot. */
    ownsSnapshot(): boolean;
    /** The tab holding the newest claim, if any. */
    ownerTabId(): string | null;
    /** Send this tab's live state to the others — only while it holds the claim. */
    broadcastState(state: L, playing?: boolean): void;
    /** Ask the owner to act (e.g. seek). False when there is no other owner. */
    sendCommand(command: MusicTabCommand): boolean;
    destroy(): void;
}

/** Positive when `a` is newer than `b`. */
export function compareClaims(a: MusicTabClaim, b: MusicTabClaim): number {
    return a.ts !== b.ts ? a.ts - b.ts : a.tabId < b.tabId ? -1 : a.tabId > b.tabId ? 1 : 0;
}

function randomId(): string {
    return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createMusicTabSync<L = unknown>(options: MusicTabSyncOptions<L>): MusicTabSync<L> {
    const tabId = randomId();
    /** The newest claim this tab knows of — its own or another tab's. */
    let latestClaim: MusicTabClaim | null = null;
    /** Whether this tab's claim is live (playing) and heartbeating. */
    let announced = false;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let elsewhereExpiry: ReturnType<typeof setTimeout> | null = null;
    let expiryProbe: ReturnType<typeof setTimeout> | null = null;
    /** Counts the owner's signs of life (heartbeat, state, owner-state). */
    let ownerSignals = 0;
    const pendingQueries = new Map<string, (answer: MusicTabOwnerState | null) => void>();

    const channel =
        typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(MUSIC_TAB_CHANNEL) : null;

    const post = (message: MusicTabMessage<L>): void => {
        try {
            channel?.postMessage(message);
        } catch {
            /* expected: posting on a channel closed during teardown */
        }
    };

    const isMine = (): boolean => latestClaim?.tabId === tabId;

    /** Record `claim` if it is the newest seen; returns whether it was. */
    const observe = (claim: MusicTabClaim): boolean => {
        if (latestClaim && compareClaims(claim, latestClaim) <= 0) return false;
        latestClaim = claim;
        return true;
    };

    const stopHeartbeat = (): void => {
        if (heartbeat !== null) clearInterval(heartbeat);
        heartbeat = null;
        announced = false;
    };

    const clearElsewhere = (): void => {
        if (elsewhereExpiry !== null) clearTimeout(elsewhereExpiry);
        elsewhereExpiry = null;
        if (expiryProbe !== null) clearTimeout(expiryProbe);
        expiryProbe = null;
    };

    const isOwnerClaim = (claim: MusicTabClaim): boolean =>
        !!latestClaim && !isMine() && compareClaims(claim, latestClaim) === 0;

    /** Another tab is playing: show it until it goes idle or silent. */
    const armElsewhere = (): void => {
        clearElsewhere();
        elsewhereExpiry = setTimeout(() => {
            elsewhereExpiry = null;
            // Silent past the expiry. That is usually a dead owner (crashed,
            // discarded) — but also a laptop waking up (this timer can fire
            // before the owner's first heartbeat) or an owner stalled on a
            // long task. Ask before releasing: a live owner answers.
            const signalsBefore = ownerSignals;
            post({ type: 'who-owns', tabId, queryId: randomId() });
            expiryProbe = setTimeout(() => {
                expiryProbe = null;
                if (ownerSignals !== signalsBefore) {
                    armElsewhere(); // alive after all
                    return;
                }
                // Gone: release its claim, as a 'closed' would.
                if (latestClaim && !isMine()) latestClaim = null;
                options.onOtherTabIdle('expired');
            }, EXPIRY_PROBE_MS);
        }, HEARTBEAT_EXPIRY_MS);
    };

    if (channel) {
        channel.onmessage = (event: MessageEvent<MusicTabMessage<L>>) => {
            const message = event.data;
            if (!message || message.tabId === tabId) return;
            switch (message.type) {
                case 'playing':
                    // An older claim lost a race this tab already won: ignore it.
                    if (!observe(message.claim)) return;
                    stopHeartbeat();
                    ownerSignals++;
                    armElsewhere();
                    options.onOtherTabPlaying(message.claim);
                    break;
                case 'heartbeat':
                    if (latestClaim && compareClaims(message.claim, latestClaim) === 0) {
                        ownerSignals++;
                        if (expiryProbe === null) armElsewhere();
                    } else if (observe(message.claim)) {
                        // Missed the 'playing' (e.g. opened after it was sent).
                        stopHeartbeat();
                        ownerSignals++;
                        armElsewhere();
                        options.onOtherTabPlaying(message.claim);
                    }
                    break;
                case 'idle':
                    if (latestClaim && compareClaims(message.claim, latestClaim) === 0) {
                        clearElsewhere();
                        options.onOtherTabIdle('idle');
                    }
                    break;
                case 'closed':
                    // The owner is gone: nobody holds the claim now, so this
                    // tab owns the snapshot again and commands fall back to
                    // local handling instead of vanishing.
                    if (latestClaim && compareClaims(message.claim, latestClaim) === 0) {
                        latestClaim = null;
                        clearElsewhere();
                        options.onOtherTabIdle('closed');
                    }
                    break;
                case 'who-owns':
                    // Only the holder of the newest claim has the live truth.
                    if (isMine() && latestClaim) {
                        post({
                            type: 'owner-state',
                            tabId,
                            queryId: message.queryId,
                            claim: latestClaim,
                            ...options.getState(),
                        });
                        options.onQueried?.();
                    }
                    break;
                case 'command':
                    // Addressed by claim: only the tab holding it acts, and a
                    // command aimed at a claim this tab has since lost is dropped.
                    if (
                        isMine() &&
                        latestClaim &&
                        compareClaims(message.claim, latestClaim) === 0
                    ) {
                        options.onCommand?.(message.command);
                    }
                    break;
                case 'state':
                    // Only the current owner's state; a stale claim's is ignored.
                    if (latestClaim && compareClaims(message.claim, latestClaim) === 0) {
                        // A playing owner's states are also its pulse (every
                        // few seconds): silence past the expiry means it died.
                        ownerSignals++;
                        if (message.playing && expiryProbe === null) armElsewhere();
                        options.onOwnerState?.(message.state);
                    }
                    break;
                case 'owner-state': {
                    // Every tab learns from every answer, not only the asker.
                    observe(message.claim);
                    if (isOwnerClaim(message.claim)) ownerSignals++;
                    const answer: MusicTabOwnerState = {
                        isPlaying: message.isPlaying,
                        trackId: message.trackId,
                        positionMs: message.positionMs,
                        track: message.track,
                    };
                    if (message.isPlaying && !isMine()) armElsewhere();
                    pendingQueries.get(message.queryId)?.(answer);
                    break;
                }
            }
        };
        // Learn the current owner, so a tab that never plays does not act as
        // one (write the snapshot on close, answer queries).
        post({ type: 'who-owns', tabId, queryId: randomId() });
    }

    return {
        announcePlaying() {
            const now = Date.now();
            // Strictly newer than anything seen, even with a skewed clock.
            const ts = latestClaim && latestClaim.ts >= now ? latestClaim.ts + 1 : now;
            latestClaim = { ts, tabId };
            clearElsewhere();
            post({ type: 'playing', tabId, claim: latestClaim });
            if (heartbeat === null && channel) {
                heartbeat = setInterval(() => {
                    if (isMine() && latestClaim) {
                        post({ type: 'heartbeat', tabId, claim: latestClaim });
                    }
                }, HEARTBEAT_INTERVAL_MS);
            }
            announced = true;
        },

        announceIdle() {
            if (!announced) return;
            stopHeartbeat();
            if (isMine() && latestClaim) post({ type: 'idle', tabId, claim: latestClaim });
        },

        announceClosed() {
            stopHeartbeat();
            if (isMine() && latestClaim) {
                post({ type: 'closed', tabId, claim: latestClaim });
                // Released everywhere else, so not ours either: a page restored
                // from the back/forward cache must claim anew, not broadcast
                // under a claim the others have dropped.
                latestClaim = null;
            }
        },

        queryOwner(timeoutMs = OWNER_QUERY_TIMEOUT_MS) {
            if (!channel) return Promise.resolve(null);
            const queryId = randomId();
            return new Promise<MusicTabOwnerState | null>((resolve) => {
                const timer = setTimeout(() => {
                    pendingQueries.delete(queryId);
                    resolve(null);
                }, timeoutMs);
                pendingQueries.set(queryId, (answer) => {
                    clearTimeout(timer);
                    pendingQueries.delete(queryId);
                    resolve(answer);
                });
                post({ type: 'who-owns', tabId, queryId });
            });
        },

        ownsSnapshot() {
            return latestClaim === null || isMine();
        },

        ownerTabId() {
            return latestClaim?.tabId ?? null;
        },

        sendCommand(command: MusicTabCommand) {
            if (!channel || !latestClaim || isMine()) return false;
            post({ type: 'command', tabId, claim: latestClaim, command });
            return true;
        },

        broadcastState(state: L, playing?: boolean) {
            if (isMine() && latestClaim) {
                post({ type: 'state', tabId, claim: latestClaim, state, playing });
            }
        },

        destroy() {
            if (isMine() && latestClaim) {
                // Closing: release the claim in the others, not just "idle".
                post({ type: 'closed', tabId, claim: latestClaim });
            }
            stopHeartbeat();
            clearElsewhere();
            for (const resolve of pendingQueries.values()) resolve(null);
            pendingQueries.clear();
            channel?.close();
        },
    };
}
