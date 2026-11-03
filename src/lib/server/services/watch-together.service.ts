// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch Together Service
 *
 * Manages synchronized watch sessions using Valkey for state storage.
 * Uses Server-Sent Events (SSE) for real-time updates to participants.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import {
    AuthDependencyUnavailableError,
    isDependencyError,
} from '$lib/server/auth/dependency-unavailable.js';
import {
    connectValkey,
    isCoordinationValkeyReady,
    publishMessage,
    subscribeToChannel,
    setEx,
    setIfNotExists,
    expire,
    incr,
    lPush,
    lTrim,
    sCard,
    hSet,
    hGet,
    hGetAll,
    hDel,
    del,
    cacheGet,
    cacheExists,
    getKeysByPattern,
    getCoordinationClient,
} from '../cache/valkey.js';
import { Logger } from '../utils/logger';
import { entityImageUrl } from '$lib/shared/api-urls';
import type {
    WatchTogetherState,
    SSEEventType,
    ReactionEmoji,
    ScreenEffect,
} from '$lib/types/watch-together';
import type {
    WatchTogetherFrame,
    WatchTogetherMediaType,
    WatchTogetherParty,
} from '$lib/schemas/watch-together';
import {
    canonicalWatchTogetherMediaType,
    WATCH_TOGETHER_HOST_ONLY_EVENTS,
} from '$lib/schemas/watch-together';
import {
    generateSessionCode,
    SESSION_TTL,
    HARD_RESYNC_DRIFT_SECONDS,
} from '$lib/types/watch-together';
import { getDb } from '$lib/server/database/connection.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import type { UserContext } from '$lib/server/types';
import { getFilesForMediaItem } from '$lib/server/database/queries/media-files.queries.js';
import { getUserById } from '$lib/server/database/queries/users.queries.js';
import { toUserId } from '$lib/shared/user-id.js';
import { mergeMaxAge, resolveTokenUserAccess } from '$lib/server/auth/resolve-token-user-access.js';

import {
    DRIFT_LATENCY_TOLERANCE_SECONDS,
    POSITION_SAMPLE_MAX_AGE_MS,
    estimateWatchTogetherDrift,
    type WatchTogetherPositionSample,
} from './watch-together-drift.js';
import { resolveWatchTogetherEntryPosition } from './watch-together-entry-position.js';
import { toPublicFrame, toPublicParties } from './watch-together-public.js';
import type { PartyStreamSnapshot } from './watch-party-stream-overlay.js';

export interface StoredParticipant {
    userId: string;
    displayName: string;
    joinedAt: number;
    clientId: string;
}

export type StoredSession = Omit<WatchTogetherParty, 'host' | 'participants'> & {
    hostUserId: string;
    hostDisplayName: string;
    participants: StoredParticipant[];
};

export type StoredFrame<F = WatchTogetherFrame> = F extends { author: unknown }
    ? Omit<F, 'author'> & { userId: string; displayName: string }
    : F extends { newHost: unknown }
      ? Omit<F, 'newHost'> & { newHostUserId: string; newHostDisplayName: string }
      : F extends { host: unknown }
        ? Omit<F, 'host'> & { hostUserId: string; hostDisplayName: string }
        : F extends { participant: unknown }
          ? Omit<F, 'participant'> & { participant: StoredParticipant }
          : F;

const logger = Logger.for('WatchTogether');

// Key patterns for Valkey
const KEYS = {
    SESSION: (code: string) => `watch:v2:session:${code.toUpperCase()}`,
    USER_SESSION: (userId: string) => `watch:v2:user:${userId}`,
    SUBSCRIBERS: (code: string) => `watch:v2:subs:${code.toUpperCase()}`,
    // Pub/Sub channel for session events (cross-replica broadcast)
    PUBSUB_CHANNEL: (code: string) => `watch:v2:events:${code.toUpperCase()}`,
    // Distributed state keys (replaces in-memory state)
    READY_STATES: (code: string, checkId: string) =>
        `watch:v2:ready:${code.toUpperCase()}:${checkId}`,
    BUFFER_CHECK: (code: string) => `watch:v2:buffer:${code.toUpperCase()}`,
    BUFFER_INIT_LOCK: (code: string) => `watch:v2:buffer-init-lock:${code.toUpperCase()}`,
    CLIENT_POSITIONS: (code: string) => `watch:v2:positions:${code.toUpperCase()}`,
    DRIFT_COOLDOWN: (code: string) => `watch:v2:drift-cooldown:${code.toUpperCase()}`,
    DRIFT_BREACH: (code: string) => `watch:v2:drift-breach:${code.toUpperCase()}`,
    // Live SSE connections (clientId → last-seen ms). Cross-replica liveness signal.
    CONNECTIONS: (code: string) => `watch:v2:conn:${code.toUpperCase()}`,
    // Currently-stalled clients (clientId → stall-start ms). Gates group resume.
    STALLED: (code: string) => `watch:v2:stalled:${code.toUpperCase()}`,
    STALL_RECOVERED: (code: string, clientId: string, stallId: string) =>
        `watch:v2:stall-recovered:${code.toUpperCase()}:${clientId}:${stallId}`,
    STALL_LOCK: (code: string) => `watch:v2:stall-lock:${code.toUpperCase()}`,
    JOIN_RESUME: (code: string) => `watch:v2:join-resume:${code.toUpperCase()}`,
    // The play state an explicit sync/seek/resume just set ('1'/'0'). Lives only
    // for PLAY_STATE_GRACE_S; while it exists a host heartbeat may not contradict it.
    PLAY_STATE: (code: string) => `watch:v2:play-state:${code.toUpperCase()}`,
    // Last time (ms) the host was seen: host heartbeat, host stream closing, host
    // change. Read with the host's live stream marker by the absent-host sweep.
    HOST_SEEN: (code: string) => `watch:v2:host-seen:${code.toUpperCase()}`,
    // Last-Event-ID replay ring (SSE reconnect support)
    SEQ: (code: string) => `watch:v2:seq:${code.toUpperCase()}`,
    REPLAY: (code: string) => `watch:v2:replay:${code.toUpperCase()}`,
};

/** Max events kept in the per-session replay ring. */
const REPLAY_MAX = 50;
/** TTL (seconds) for both the seq counter and the replay ring. Matches SESSION_TTL. */
const REPLAY_TTL = 4 * 60 * 60; // 4 h

/**
 * Assign a monotonic sequence number and store the serialised event in the
 * capped replay ring. Returns the assigned seq (or 0 on Valkey failure, fail-soft).
 *
 * Called from broadcastToSession so that every outbound SSE event is replayable
 * via Last-Event-ID on reconnect.
 */
async function appendEventToReplay(
    code: string,
    event: SSEEventType,
    excludeClientId?: string,
): Promise<number> {
    try {
        if (!isCoordinationValkeyReady()) return 0;

        const seqKey = KEYS.SEQ(code);
        const replayKey = KEYS.REPLAY(code);

        const seq = await incr(seqKey);
        await expire(seqKey, REPLAY_TTL);

        // Persist echo-filtering metadata too. Otherwise a reconnecting sender
        // can receive its own event from replay even though live delivery was
        // deliberately suppressed.
        const entry = JSON.stringify({ seq, event, excludeClientId });
        await lPush(replayKey, [entry]);
        await lTrim(replayKey, 0, REPLAY_MAX - 1);
        await expire(replayKey, REPLAY_TTL);

        return seq;
    } catch (err) {
        logger.warn('appendEventToReplay failed', { code }, err as Error);
        return 0;
    }
}

/** Match authenticated ownership, optionally binding one enrolled client. */
export function findParticipant(
    session: StoredSession,
    userId: string,
    clientId?: string,
): StoredParticipant | undefined {
    return session.participants.find(
        (p) =>
            p.userId.toLowerCase() === userId.toLowerCase() &&
            (clientId === undefined || p.clientId === clientId),
    );
}

/** Supplied IDs require an enrolled host device owned by the caller. */
export function isHostClient(session: StoredSession, clientId: string, userId?: string): boolean {
    if (!userId) return false;
    if (clientId) {
        const participant = findParticipant(session, userId, clientId);
        if (!participant || participant.userId.toLowerCase() !== session.hostUserId.toLowerCase())
            return false;
        return !session.hostClientId || participant.clientId === session.hostClientId;
    }
    return userId.toLowerCase() === session.hostUserId.toLowerCase();
}

/** Load and verify membership in one call; supplied IDs never fall back. */
export async function getSessionWithParticipant(
    code: string,
    userId: string,
    clientId?: string,
): Promise<{
    session: StoredSession;
    participant: StoredParticipant;
} | null> {
    const session = await getSession(code);
    if (!session) return null;
    const participant = findParticipant(session, userId, clientId);
    if (!participant) return null;
    return { session, participant };
}

// Local SSE connections (per server instance)
// These are callback functions that must remain local
// Cross-replica communication is handled via Valkey pub/sub
// Structure: code → clientId → callback (allows echo filtering by clientId)
interface SSEConnection {
    clientId: string;
    callback: (event: SSEEventType, seq?: number) => void;
}
const sseConnections = new Map<string, Map<string, SSEConnection>>();

/**
 * Total live watch-together SSE connections held by THIS replica process,
 * across every session. Used by the `GET {code}/events` handler (P1, fix
 * round 1 finding 2) to enforce the same process-wide SSE connection ceiling
 * (`config.SSE_MAX_CONNECTIONS`) the `createSseReplayHub`-backed endpoints
 * enforce via their own `consumers.size` — this registry has no single
 * `Set`/`size` to read directly since connections are bucketed per session
 * code, so this sums the per-session maps.
 */
export function getActiveSSEConnectionCount(): number {
    let total = 0;
    for (const perSession of sseConnections.values()) {
        total += perSession.size;
    }
    return total;
}

// Pub/sub message format (includes excludeClientId for echo filtering)
interface PubSubMessage {
    event: SSEEventType;
    seq?: number;
    excludeClientId?: string; // Don't send to this client (echo prevention)
}

// Track active pub/sub unsubscribe functions for cleanup
const pubsubUnsubscribers = new Map<string, Set<() => Promise<void>>>();

// Local timeout handles for buffer checks (must be local per-replica)
type TimeoutHandle = ReturnType<typeof setTimeout>;
const bufferCheckTimeouts = new Map<string, TimeoutHandle>();

// Buffer check timeout (5 seconds max wait for slow clients)
const BUFFER_CHECK_TIMEOUT = 5000;

// Cooldown repeated persistent-drift diagnostics after coordinated sync boundaries.
const DRIFT_RESYNC_COOLDOWN = 15000;

/** Two independent excessive-drift observations are required before treating it as persistent. */
const DRIFT_CONFIRMATION_COUNT = 2;

/** Confirmation state outlives two 10-second report intervals, then self-cleans. */
const DRIFT_CONFIRMATION_TTL_SECONDS = 30;

/** Position hashes outlive the cadence; individual samples are age-filtered more tightly. */
const POSITION_STATE_TTL_SECONDS = 30;

/** TTL for ephemeral Valkey state (buffer checks). Should be ~2x BUFFER_CHECK_TIMEOUT to bound frozen-session window on replica crash. */
const EPHEMERAL_STATE_TTL = 10;

// ============================================================================
// Distributed State Helpers (Buffer Check, Ready States, Positions)
// ============================================================================

interface BufferCheckState {
    checkId: string;
    currentTime: number;
    expectedCount: number;
    expectedClientIds?: string[];
    seekInitiated: boolean;
    startTime: number;
    isPlaying: boolean; // Whether playback should resume after buffer check
}

/**
 * Store buffer check state in Valkey
 */
async function setBufferCheckState(code: string, state: BufferCheckState): Promise<boolean> {
    try {
        await connectValkey();
        if (!isCoordinationValkeyReady()) return false;

        await setTransitionValue(
            KEYS.BUFFER_CHECK(code),
            EPHEMERAL_STATE_TTL,
            JSON.stringify(state),
        );
        return true;
    } catch (error) {
        logger.warn('Failed to set buffer check state', { code }, error as Error);
        return false;
    }
}

export async function getPendingBufferCheckSnapshot(code: string): Promise<{
    checkId: string;
    currentTime: number;
    isPlaying: boolean;
    seekInitiated: boolean;
} | null> {
    const state = await getBufferCheckState(code.toUpperCase());
    return state
        ? {
              checkId: state.checkId,
              currentTime: state.currentTime,
              isPlaying: state.isPlaying,
              seekInitiated: state.seekInitiated,
          }
        : null;
}

/**
 * Clear a user's "current party" pointer only if it still names `code`. Leaving or
 * ending an OLD party must never drop the user's pointer to a newer one: a leaked
 * party ended later by the sweeper wiped the pointer of the party its former guest
 * was now hosting (web e2e, 2026-10-01) — GET /api/watch-together then said "no
 * party", breaking rejoin-on-reload and the host's catch-up.
 */
async function clearUserSessionIfCurrent(userId: string, code: string): Promise<void> {
    const key = KEYS.USER_SESSION(userId);
    const upper = code.toUpperCase();
    const client = getCoordinationClient();
    if (!client) {
        if ((await cacheGet(key)) === upper) await del(key);
        return;
    }
    await client.customCommand([
        'EVAL',
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
        '1',
        key,
        upper,
    ]);
}

async function rememberJoinResumeIntent(code: string, isPlaying: boolean): Promise<void> {
    await setIfNotExists(KEYS.JOIN_RESUME(code), isPlaying ? '1' : '0', EPHEMERAL_STATE_TTL);
}

async function updateJoinResumeIntentIfPending(code: string, isPlaying: boolean): Promise<void> {
    const key = KEYS.JOIN_RESUME(code);
    const client = getCoordinationClient();
    if (!client) return;
    if (currentBufferTransition()) {
        await transitionCommand(
            [key],
            [isPlaying ? '1' : '0', String(EPHEMERAL_STATE_TTL)],
            "return redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2], 'XX')",
        );
    } else {
        await client.customCommand([
            'SET',
            key,
            isPlaying ? '1' : '0',
            'EX',
            String(EPHEMERAL_STATE_TTL),
            'XX',
        ]);
    }
}

async function consumeJoinResumeIntent(code: string, fallback: boolean): Promise<boolean> {
    const key = KEYS.JOIN_RESUME(code);
    const client = getCoordinationClient();
    if (!client) return fallback;
    const value = await client.customCommand(['GETDEL', key]);
    return value == null ? fallback : value === '1';
}

/**
 * Get buffer check state from Valkey
 */
async function getBufferCheckState(code: string): Promise<BufferCheckState | null> {
    try {
        await connectValkey();
        if (!isCoordinationValkeyReady()) return null;

        const data = await cacheGet(KEYS.BUFFER_CHECK(code));
        if (!data) return null;

        return JSON.parse(data) as BufferCheckState;
    } catch (error) {
        logger.warn('Failed to get buffer check state', { code }, error as Error);
        return null;
    }
}

/**
 * Update buffer check currentTime (for host position updates)
 */
async function updateBufferCheckTime(
    code: string,
    checkId: string,
    currentTime: number,
): Promise<boolean> {
    try {
        await connectValkey();
        if (!isCoordinationValkeyReady()) return false;

        const client = getCoordinationClient();
        if (!client) return false;
        const lua = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local state = cjson.decode(raw)
if state.checkId ~= ARGV[1] then return 0 end
state.currentTime = tonumber(ARGV[2])
redis.call('SETEX', KEYS[1], ARGV[3], cjson.encode(state))
return 1`;
        const result = await client.customCommand([
            'EVAL',
            lua,
            '1',
            KEYS.BUFFER_CHECK(code),
            checkId,
            String(currentTime),
            String(EPHEMERAL_STATE_TTL),
        ]);
        return Number(result) === 1;
    } catch (error) {
        logger.warn('Failed to update buffer check time', { code }, error as Error);
        return false;
    }
}

/**
 * Fold a play/pause into the pending buffer check's isPlaying.
 *
 * When a barrier (seek / join / drift buffer_check) is in flight and someone
 * presses play or pause, the guest DROPS the `sync` play instruction (its phase
 * machine ignores play-syncs during a buffer_check — all_ready owns the resume).
 * If the pending check's isPlaying is not updated too, the concluding `all_ready`
 * carries the STALE state and everyone stays paused (or resumes when they should
 * stay paused). This is the seek-spam-then-play / skip-then-play stuck-guest bug.
 *
 * No checkId gate: the caller (updatePlaybackState) doesn't know the pending
 * checkId — it just wants whatever barrier is currently in flight to conclude
 * with the intended play state. A no-op (returns 0) when no barrier is pending.
 */
async function updateBufferCheckIsPlaying(code: string, isPlaying: boolean): Promise<boolean> {
    try {
        await connectValkey();
        if (!isCoordinationValkeyReady()) return false;

        const client = getCoordinationClient();
        if (!client) return false;
        const lua = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local state = cjson.decode(raw)
state.isPlaying = ARGV[1] == '1'
redis.call('SETEX', KEYS[1], ARGV[2], cjson.encode(state))
return 1`;
        const result = await transitionCommand(
            [KEYS.BUFFER_CHECK(code)],
            [isPlaying ? '1' : '0', String(EPHEMERAL_STATE_TTL)],
            lua,
        );
        return Number(result) === 1;
    } catch (error) {
        if (currentBufferTransition()) throw error;
        logger.warn('Failed to update buffer check isPlaying', { code }, error as Error);
        return false;
    }
}

async function decrementBufferCheckExpectedCount(
    code: string,
    checkId: string,
    clientId: string,
): Promise<BufferCheckState | null> {
    try {
        const client = getCoordinationClient();
        if (!client) return null;
        const lua = `
local raw = redis.call('GET', KEYS[1])
if not raw then return nil end
local state = cjson.decode(raw)
if state.checkId ~= ARGV[1] then return nil end
if state.expectedClientIds then
    local found = false
    for i, id in ipairs(state.expectedClientIds) do
        if id == ARGV[3] then table.remove(state.expectedClientIds, i); found = true; break end
    end
    if not found then return nil end
end
redis.call('SREM', KEYS[2], ARGV[3])
state.expectedCount = math.max(0, state.expectedCount - 1)
local updated = cjson.encode(state)
redis.call('SETEX', KEYS[1], ARGV[2], updated)
return updated`;
        const result = await client.customCommand([
            'EVAL',
            lua,
            '2',
            KEYS.BUFFER_CHECK(code),
            KEYS.READY_STATES(code, checkId),
            checkId,
            String(EPHEMERAL_STATE_TTL),
            clientId,
        ]);
        return typeof result === 'string' ? (JSON.parse(result) as BufferCheckState) : null;
    } catch (error) {
        logger.warn('Failed to decrement buffer check participant count', { code }, error as Error);
        return null;
    }
}

/**
 * Add client to ready set and return the new count
 */
async function addReadyClient(
    code: string,
    checkId: string,
    clientId: string,
): Promise<{ readyCount: number; expectedCount: number } | null> {
    try {
        await connectValkey();
        const client = getCoordinationClient();
        if (!isCoordinationValkeyReady() || !client) return null;
        // Validate identity and mutate readiness in the same transaction as a
        // departure's removal: a stale signal cannot reinsert a departed client.
        const result = await client.customCommand([
            'EVAL',
            `local raw = redis.call('GET', KEYS[1])
             if not raw then return nil end
             local state = cjson.decode(raw)
             if state.checkId ~= ARGV[1] then return nil end
             if state.expectedClientIds then
                 local found = false
                 for _, id in ipairs(state.expectedClientIds) do if id == ARGV[2] then found = true end end
                 if not found then return nil end
             end
             local sessionRaw = redis.call('GET', KEYS[3])
             if not sessionRaw then return nil end
             local member = false
             for _, p in ipairs(cjson.decode(sessionRaw).participants) do if p.clientId == ARGV[2] then member = true end end
             if not member then return nil end
             redis.call('SADD', KEYS[2], ARGV[2])
             redis.call('EXPIRE', KEYS[2], ARGV[3])
             return cjson.encode({readyCount = redis.call('SCARD', KEYS[2]), expectedCount = state.expectedCount})`,
            '3',
            KEYS.BUFFER_CHECK(code),
            KEYS.READY_STATES(code, checkId),
            KEYS.SESSION(code),
            checkId,
            clientId,
            String(EPHEMERAL_STATE_TTL),
        ]);
        return typeof result === 'string'
            ? (JSON.parse(result) as { readyCount: number; expectedCount: number })
            : null;
    } catch (error) {
        logger.warn('Failed to add ready client', { code, clientId }, error as Error);
        return null;
    }
}

/**
 * Clean up buffer check state (called when resume is triggered)
 * Returns whether cleanup succeeded, including when no barrier was active.
 * Callers hold the transition lock; completion claims use their check ID.
 */
async function cleanupBufferCheckState(code: string): Promise<boolean> {
    try {
        // Clear local timeout
        const timeout = bufferCheckTimeouts.get(code);

        await connectValkey();
        if (!isCoordinationValkeyReady()) return false;

        const state = await getBufferCheckState(code);
        // Atomically delete buffer check key - returns count of deleted keys
        // Only one replica will get deleted > 0, others get 0
        const keys = [
            KEYS.BUFFER_CHECK(code),
            ...(state?.checkId ? [KEYS.READY_STATES(code, state.checkId)] : []),
        ];
        await transitionCommand(
            keys,
            [],
            `return redis.call('DEL', ${keys.map((_, i) => `KEYS[${i + 1}]`).join(', ')})`,
        );
        if (timeout && bufferCheckTimeouts.get(code) === timeout) {
            clearTimeout(timeout);
            bufferCheckTimeouts.delete(code);
        }
        return true;
    } catch (error) {
        logger.warn('Failed to cleanup buffer check state', { code }, error as Error);
        return false;
    }
}

/**
 * Handle participant leaving during an active buffer check.
 * - Removes their clientId from ready states
 * - Decrements expectedCount
 * - Triggers resume if all remaining participants are now ready
 */
async function handleParticipantLeftDuringBufferCheck(
    code: string,
    clientId: string,
): Promise<void> {
    try {
        const pending = await getBufferCheckState(code);
        if (!pending) return; // No active buffer check

        const updated = await decrementBufferCheckExpectedCount(code, pending.checkId, clientId);
        if (!updated) return;

        logger.debug('Updated buffer check after participant left', {
            code,
            clientId,
            newExpectedCount: updated.expectedCount,
        });

        // Check if we can now trigger resume (all remaining participants ready)
        const readyCount = await sCard(KEYS.READY_STATES(code, pending.checkId));
        if (readyCount >= updated.expectedCount && updated.expectedCount > 0) {
            logger.debug('All remaining participants ready after leave, triggering resume', {
                code,
                readyCount,
                expectedCount: updated.expectedCount,
            });
            const complete = () =>
                triggerSynchronizedResume(
                    code,
                    updated.currentTime,
                    updated.isPlaying,
                    updated.checkId,
                );
            if (currentBufferTransition()) {
                try {
                    await triggerSynchronizedResumeLocked(
                        code,
                        updated.currentTime,
                        updated.isPlaying,
                        updated.checkId,
                    );
                } catch (error) {
                    // Let the enclosing departure unwind/release its lost lease.
                    // The mandatory retry must acquire a fresh independent one.
                    void bufferTransitionScope.exit(complete).catch((retryError) => {
                        logger.warn(
                            'Failed to complete synchronization after departure',
                            { code },
                            retryError as Error,
                        );
                    });
                    throw error;
                }
            } else {
                await complete();
            }
        }
    } catch (error) {
        logger.warn(
            'Failed to handle participant left during buffer check',
            { code, clientId },
            error as Error,
        );
    }
}

/** A connection is considered live if touched within this window (9 keepalive periods at 10 s). */
const CONNECTION_STALE_MS = 90_000;

/** A stall entry older than this is considered abandoned and no longer blocks resume. */
const STALL_ACTIVE_MS = 30_000;

/** Per-replica failsafe timers that force a resume if a stalled client vanishes. */
const stallFailsafeTimeouts = new Map<string, TimeoutHandle>();

async function withStallLock<T>(code: string, fallback: T, action: () => Promise<T>): Promise<T> {
    const result = await withBufferTransition(code, () =>
        withStallLockHeld(code, fallback, action),
    );
    return result === false ? fallback : result;
}

async function withStallLockHeld<T>(
    code: string,
    fallback: T,
    action: () => Promise<T>,
): Promise<T> {
    const upperCode = code.toUpperCase();
    await connectValkey();
    if (!isCoordinationValkeyReady()) return fallback;
    const owner = crypto.randomUUID();
    let acquired = false;
    for (let attempt = 0; attempt < 100; attempt++) {
        acquired = await setIfNotExists(KEYS.STALL_LOCK(upperCode), owner, 15);
        if (acquired) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!acquired) return fallback;
    try {
        return await action();
    } finally {
        try {
            const client = getCoordinationClient();
            if (client) {
                await client.customCommand([
                    'EVAL',
                    `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`,
                    '1',
                    KEYS.STALL_LOCK(upperCode),
                    owner,
                ]);
            }
        } catch (error) {
            logger.warn('Failed to release stall lock', { code: upperCode }, error as Error);
        }
    }
}

/**
 * Mark an SSE connection as live (called on register and on each keepalive tick).
 * This is the cross-replica liveness signal used to size buffer checks.
 */
export async function touchSSEConnection(code: string, clientId: string): Promise<void> {
    if (!clientId) return;
    try {
        await connectValkey();
        if (!isCoordinationValkeyReady()) return;
        const key = KEYS.CONNECTIONS(code);
        await hSet(key, clientId, String(Date.now()));
        await expire(key, SESSION_TTL);
        // A live connection means the party is in use — refresh the session key's
        // TTL too so a long *paused* party (no playback events refreshing the
        // session write) isn't torn down by the SESSION_TTL backstop while a
        // viewer is still connected. Reaping still happens once all connections
        // drop (CONNECTIONS ages out → getAllSessions reaps the quiet session).
        await expire(KEYS.SESSION(code), SESSION_TTL);
    } catch (error) {
        logger.warn('Failed to touch SSE connection', { code, clientId }, error as Error);
    }
}

/**
 * Count SSE connections seen within CONNECTION_STALE_MS.
 * Returns null when the signal is unavailable (Valkey down / nothing tracked yet)
 * so callers can fall back to the participant count.
 */
async function getLiveConnectionCount(code: string): Promise<number | null> {
    try {
        await connectValkey();
        if (!isCoordinationValkeyReady()) return null;
        const data = await hGetAll(KEYS.CONNECTIONS(code));
        const entries = Object.values(data);
        if (entries.length === 0) return null;
        const now = Date.now();
        let live = 0;
        for (const value of entries) {
            const ts = Number(value);
            if (Number.isFinite(ts) && now - ts <= CONNECTION_STALE_MS) live++;
        }
        // All entries stale (delayed keepalives under load, or every marker
        // aged out) is indistinguishable from a broken signal — fall back to
        // the participant count rather than shrinking expectedCount to the
        // floor and resuming after a single ready signal.
        if (live === 0) return null;
        return live;
    } catch (error) {
        logger.warn('Failed to count live SSE connections', { code }, error as Error);
        return null;
    }
}

/**
 * Store client position for drift detection
 */
async function setClientPosition(
    code: string,
    clientId: string,
    position: number,
    isHost: boolean,
): Promise<void> {
    try {
        await connectValkey();
        if (!isCoordinationValkeyReady()) return;

        const data = JSON.stringify({
            position,
            timestamp: Date.now(),
            isHost,
        });
        await hSet(KEYS.CLIENT_POSITIONS(code), clientId, data);
        await expire(KEYS.CLIENT_POSITIONS(code), POSITION_STATE_TTL_SECONDS);
    } catch (error) {
        logger.warn('Failed to set client position', { code, clientId }, error as Error);
    }
}

/**
 * Get all client positions for drift detection
 */
async function getClientPositions(
    code: string,
): Promise<Map<string, { position: number; timestamp: number; isHost: boolean }>> {
    const positions = new Map<string, { position: number; timestamp: number; isHost: boolean }>();
    try {
        await connectValkey();
        if (!isCoordinationValkeyReady()) return positions;

        const data = await hGetAll(KEYS.CLIENT_POSITIONS(code));
        const now = Date.now();

        const isClientPosition = (
            value: unknown,
        ): value is { position: number; timestamp: number; isHost: boolean } =>
            typeof value === 'object' &&
            value !== null &&
            typeof (value as { position?: unknown }).position === 'number' &&
            typeof (value as { timestamp?: unknown }).timestamp === 'number' &&
            typeof (value as { isHost?: unknown }).isHost === 'boolean';

        for (const [clientId, json] of Object.entries(data)) {
            try {
                const pos: unknown = JSON.parse(json);
                // Admit any timer phase offset, but discard frozen/disconnected clients.
                if (
                    isClientPosition(pos) &&
                    now - pos.timestamp >= 0 &&
                    now - pos.timestamp <= POSITION_SAMPLE_MAX_AGE_MS
                ) {
                    positions.set(clientId, pos);
                }
            } catch {
                // Skip invalid entries
            }
        }
    } catch (error) {
        logger.warn('Failed to get client positions', { code }, error as Error);
    }
    return positions;
}

/** Record one excessive-drift observation and return its confirmation count. */
async function recordDriftBreach(code: string): Promise<number> {
    try {
        await connectValkey();
        if (!isCoordinationValkeyReady()) return 1;

        const key = KEYS.DRIFT_BREACH(code);
        const count = await incr(key);
        await expire(key, DRIFT_CONFIRMATION_TTL_SECONDS);
        return count;
    } catch (error) {
        logger.warn('Failed to record drift confirmation', { code }, error as Error);
        // Fail conservatively: a cache problem must not pause the whole party.
        return 1;
    }
}

async function clearDriftBreach(code: string): Promise<void> {
    try {
        await del(KEYS.DRIFT_BREACH(code));
    } catch (error) {
        logger.warn('Failed to clear drift confirmation', { code }, error as Error);
    }
}

/** Clear samples that are invalid across a pause, stall, seek, or resync boundary. */
async function clearDriftMeasurements(code: string): Promise<void> {
    try {
        await del([KEYS.CLIENT_POSITIONS(code), KEYS.DRIFT_BREACH(code)]);
    } catch (error) {
        logger.warn('Failed to clear drift measurements', { code }, error as Error);
    }
}

/**
 * Check drift resync cooldown
 */
async function isDriftCooldownActive(code: string): Promise<boolean> {
    try {
        await connectValkey();
        if (!isCoordinationValkeyReady()) return false;

        const exists = await cacheExists(KEYS.DRIFT_COOLDOWN(code));
        return exists;
    } catch (error) {
        logger.warn('Failed to check drift cooldown', { code }, error as Error);
        return false;
    }
}

/**
 * Set drift resync cooldown
 */
/**
 * How long an explicit play/pause outranks the host's heartbeat.
 *
 * The heartbeat samples the host's play state client-side and is in flight for a
 * while; one sampled just BEFORE the host pressed Play can land just AFTER the
 * `sync` that press sent. Applied blindly it wrote isPlaying=false back into a
 * playing session and broadcast it as `host_position`, which guests honour — the
 * Apple TV paused itself one heartbeat (~5 s) after the browser host pressed Play
 * and then trailed by 5 s. Found by the browser <-> Apple TV e2e. Short on purpose:
 * the heartbeat is also the self-heal for a missed sync, and the next one (5 s
 * later) still heals.
 */
const PLAY_STATE_GRACE_S = 3;

async function pinExplicitPlayState(code: string, isPlaying: boolean): Promise<void> {
    try {
        await setTransitionValue(KEYS.PLAY_STATE(code), PLAY_STATE_GRACE_S, isPlaying ? '1' : '0');
    } catch (error) {
        if (currentBufferTransition()) throw error;
        logger.warn('Failed to pin explicit play state', { code }, error as Error);
    }
}

/** The play state an explicit action set within the grace window, if any. */
async function pinnedPlayState(code: string): Promise<boolean | null> {
    try {
        const pinned = await cacheGet(KEYS.PLAY_STATE(code));
        return pinned === null ? null : pinned === '1';
    } catch {
        return null;
    }
}

/**
 * TTL of the host sighting: longer than the longest allowed absence limit (24 h). With
 * SESSION_TTL (4 h) a limit above 240 min never ended a party: the sighting expired,
 * the sweep saw "no sighting yet" and restarted the clock.
 */
const HOST_SEEN_TTL_S = 24 * 60 * 60 + 300;

async function markHostSeen(code: string, at: number = Date.now()): Promise<void> {
    try {
        await setEx(KEYS.HOST_SEEN(code), HOST_SEEN_TTL_S, String(at));
    } catch (error) {
        logger.warn('Failed to mark host seen', { code }, error as Error);
    }
}

async function setDriftCooldown(code: string): Promise<void> {
    try {
        await connectValkey();
        if (!isCoordinationValkeyReady()) return;

        // Set cooldown key with TTL (15 seconds)
        await setEx(KEYS.DRIFT_COOLDOWN(code), Math.ceil(DRIFT_RESYNC_COOLDOWN / 1000), '1');
    } catch (error) {
        logger.warn('Failed to set drift cooldown', { code }, error as Error);
    }
}

/**
 * Clean up all position tracking state for a session
 */
async function cleanupPositionTrackingState(code: string): Promise<void> {
    try {
        await connectValkey();
        if (!isCoordinationValkeyReady()) return;

        await del([
            KEYS.CLIENT_POSITIONS(code),
            KEYS.DRIFT_COOLDOWN(code),
            KEYS.DRIFT_BREACH(code),
        ]);
    } catch (error) {
        logger.warn('Failed to cleanup position tracking state', { code }, error as Error);
    }
}

/**
 * Create a new watch together session
 */
export async function createSession(
    hostUserId: string,
    hostDisplayName: string,
    itemId: string,
    mediaType: WatchTogetherMediaType,
    title: string,
    _posterUrl?: string, // Ignored - auto-generated from itemId
    currentTime?: number,
    fileId?: string,
    clientId?: string,
    visibility: 'unlisted' | 'listed' = 'unlisted',
): Promise<StoredSession | null> {
    try {
        await connectValkey();
        if (!isCoordinationValkeyReady()) {
            logger.error('Valkey not available for Watch Together');
            return null;
        }

        const entryPosition = await resolveWatchTogetherEntryPosition(
            itemId,
            mediaType,
            fileId,
            currentTime,
        );

        // Check if user already has an active session
        const existingCode = await cacheGet(KEYS.USER_SESSION(hostUserId));
        if (existingCode) {
            // End the existing session first — or, when this user is only a GUEST
            // there (endSession refuses non-hosts), leave it: staying behind as a
            // participant of the old party left a ghost there, and its later end
            // used to wipe this user's pointer to the party created here.
            if (!(await endSession(existingCode, hostUserId))) {
                await leaveSession(existingCode, hostUserId);
            }
        }

        // Generate unique code (retry if collision)
        let code: string;
        let attempts = 0;
        do {
            code = generateSessionCode();
            const exists = await cacheExists(KEYS.SESSION(code));
            if (!exists) break;
            attempts++;
        } while (attempts < 10);

        if (attempts >= 10) {
            logger.error('Failed to generate unique session code after 10 attempts');
            return null;
        }

        const now = Date.now();
        // Generate clientId for host if not provided
        const hostClientId =
            clientId || `${hostUserId}-${now}-${crypto.randomUUID()}`;

        const session: StoredSession = {
            code,
            hostUserId,
            hostDisplayName,
            hostClientId, // Track specific device/tab that is the host
            itemId,
            timelineId: crypto.randomUUID(),
            // Canonicalise on WRITE so every reader gets one spelling. Previously
            // the client's spelling was stored and echoed back verbatim, so the
            // same field came back as `tv` or `series` depending on which client
            // opened the party.
            mediaType: canonicalWatchTogetherMediaType(mediaType),
            title,
            // Auto-generate poster URL from itemId using the entity image endpoint.
            // Always the v1 form (existing behavior, unrelated to which surface the
            // session was created from). entityImageUrl() derives the prefix from
            // SvelteKit's `base` for subfolder installs — a hand-built
            // `${config.BASE_PATH}/...` literal doesn't, and worse, config.BASE_PATH
            // is the filesystem config/data directory, not a URL prefix.
            posterUrl: entityImageUrl(itemId, 'poster', 'v1'),
            fileId,
            currentTime: entryPosition,
            isPlaying: false,
            playbackRate: 1,
            createdAt: now,
            lastSync: now,
            participants: [
                {
                    userId: hostUserId,
                    displayName: hostDisplayName,
                    joinedAt: now,
                    clientId: hostClientId,
                },
            ],
            visibility,
        };

        // Store session with TTL
        await setTransitionValue(KEYS.SESSION(code), SESSION_TTL, JSON.stringify(session));
        await markHostSeen(code);

        // Track user's active session
        await setEx(KEYS.USER_SESSION(hostUserId), SESSION_TTL, code);

        logger.info('Created watch together session', {
            code,
            hostDisplayName,
            title,
        });
        return session;
    } catch (error) {
        if (isDependencyError(error)) throw new AuthDependencyUnavailableError(error);
        logger.error('Failed to create session', error as Error);
        return null;
    }
}

/**
 * Deserialize a session from Valkey, canonicalising the legacy `tv` spelling.
 *
 * Sessions are stored as raw JSON and read back with a cast, not a schema parse,
 * so a party created BEFORE mediaType was canonicalised on write keeps `tv` in
 * Valkey for the rest of its TTL. Coercing on read means in-flight parties stop
 * emitting `tv` the moment this deploys, instead of hours later.
 */
function parseStoredSession(data: string): StoredSession {
    const session = JSON.parse(data) as StoredSession;
    session.visibility ??= 'unlisted';
    if ((session.mediaType as string) === 'tv') {
        session.mediaType = 'series';
    }
    return session;
}

/**
 * Get session by code
 */
export async function getSession(code: string): Promise<StoredSession | null> {
    try {
        await connectValkey();
        if (!isCoordinationValkeyReady()) return null;

        const data = await cacheGet(KEYS.SESSION(code.toUpperCase()));
        if (!data) return null;

        return parseStoredSession(data);
    } catch (error) {
        logger.error('Failed to get session', error as Error, { code });
        return null;
    }
}

/**
 * Get user's active session code
 */
/**
 * May this viewer see the session's current item?
 *
 * Wraps `checkMediaAccess` (library group + `users.max_age_rating`) with two
 * behaviours the raw helper does not have and that this surface needs:
 *
 * - **Fails closed when the DB is unavailable.** Elsewhere a DB outage yields a
 *   503 from the route; here a thrown error inside a join would otherwise be
 *   caught by the surrounding try/catch and read as "no access problem".
 * - **Treats a session with no item as accessible** — a party can exist in a
 *   lobby state before the host picks something, and there is nothing to gate.
 */
async function participantMayAccess(
    itemId: string | undefined,
    viewer: UserContext,
): Promise<boolean> {
    if (!itemId) return true;
    try {
        const db = getDb();
        if (!db) return false;
        return await checkMediaAccess(db, itemId, viewer);
    } catch (error) {
        logger.error('Access check failed during watch-together join', error as Error, { itemId });
        return false;
    }
}

/**
 * Hard ceiling on participants in one party.
 *
 * The array is stored as a single JSON blob rewritten on every join, and every
 * event fans out to one SSE connection per participant, so both memory and
 * fan-out cost scale linearly with no natural bound — the 4-hour session TTL
 * caps duration, not size.
 *
 * 50 is far above any real watch party (`social-sharing.md` sizes whole
 * INSTALLS at 1–100 users) and far below anything that strains Valkey or the
 * pub/sub fan-out. It exists to stop a script, not to shape product behaviour;
 * if a real party ever hits it, raise it rather than designing around it.
 */
const MAX_PARTICIPANTS = 50;

/**
 * A participant is only a ghost candidate once they have had long enough to
 * open an SSE stream. Without this, a client is pruned in the window between
 * its join POST and its EventSource connecting.
 */
const PARTICIPANT_GRACE_MS = 120_000;

/**
 * Remove participants whose SSE liveness marker has aged out.
 *
 * Never prunes the host — losing them would trigger host transfer from what is
 * meant to be a bookkeeping step — and never prunes anyone inside
 * `PARTICIPANT_GRACE_MS` of joining.
 *
 * Fails open: if the liveness hash cannot be read, every participant is kept.
 * Pruning on missing evidence would empty parties during a Valkey blip.
 */
async function pruneGhostParticipants(
    code: string,
    session: StoredSession,
): Promise<StoredParticipant[]> {
    try {
        const markers = await hGetAll(KEYS.CONNECTIONS(code.toUpperCase()));
        if (!markers || Object.keys(markers).length === 0) return session.participants;

        const now = Date.now();
        return session.participants.filter((participant) => {
            if (participant.userId === session.hostUserId) return true;
            if (now - participant.joinedAt < PARTICIPANT_GRACE_MS) return true;
            if (!participant.clientId) return true;

            const seen = Number(markers[participant.clientId]);
            if (!Number.isFinite(seen)) return true;
            return now - seen <= CONNECTION_STALE_MS;
        });
    } catch (error) {
        logger.warn('Ghost prune skipped', { code }, error as Error);
        return session.participants;
    }
}

/**
 * Which current participants may NOT see `itemId`?
 *
 * Used to gate `navigate`, which previously checked only the HOST's access and
 * then broadcast the new title to everyone — so a host could move a party onto
 * an 18+ title and every participant, including an account with a lower
 * `max_age_rating`, received that title in an SSE frame. Playback stayed
 * blocked; the disclosure did not.
 *
 * **Why the caller refuses the navigate instead of ejecting or filtering:**
 * selective exclusion is not available at this layer. `broadcastToSession`
 * carries a single `excludeClientId`, and the same value is written into the
 * Valkey replay ring so a reconnecting client can replay what it missed — so
 * "exclude these N clients" would mean changing the replay entry format too.
 * Ejecting mid-party is more machinery and worse behaviour than telling the
 * host why the move is blocked. Refusing is fail-closed and cannot leak.
 *
 * Participants are keyed by UUID, so this resolves each distinct user ID to
 * its user row and rebuilds the access context. The host
 * is excluded — they were already checked by the caller, against the same
 * `locals.user` the request carries.
 *
 * A participant whose user row has vanished counts as blocked: an unresolvable
 * account is not evidence of entitlement.
 */
export async function participantsBlockedBy(
    code: string,
    itemId: string,
    hostUserId: string,
): Promise<string[]> {
    const session = await getSession(code);
    if (!session) return [];

    const db = getDb();
    if (!db) return [];

    const userIds = [
        ...new Set(
            session.participants
                .map((participant) => participant.userId)
                .filter((name) => name !== hostUserId),
        ),
    ];

    // Fail CLOSED on a DB error, matching participantMayAccess above. Without
    // this the loop's un-awaited-catch calls throw straight out of here and past
    // the navigate handler, which has no try/catch either — turning a transient
    // pool exhaustion into a 500 instead of the logged refusal this feature uses
    // everywhere else. An unresolvable participant already counts as blocked;
    // an unreachable database has to count the same way, or a DB blip becomes a
    // way to get an unchecked navigate through.
    try {
        return await resolveBlockedParticipants(db, itemId, userIds);
    } catch (error) {
        if (isDependencyError(error)) throw new AuthDependencyUnavailableError(error);
        logger.error('Participant access check failed — refusing navigate', error as Error, {
            code,
            itemId,
        });
        return userIds;
    }
}

/** Inner loop of {@link participantsBlockedBy}; throws on DB failure by design. */
async function resolveBlockedParticipants(
    db: NonNullable<ReturnType<typeof getDb>>,
    itemId: string,
    userIds: string[],
): Promise<string[]> {
    const blocked: string[] = [];
    for (const name of userIds) {
        const row = await getUserById(db, name);
        if (!row) {
            blocked.push(name);
            continue;
        }
        // The subject comes from the canonical resolver, not the raw `users`
        // row (security review 6, C2): a raw read was blind to every cap that
        // isn't in the column — an OIDC participant's `age-<n>` IdP group
        // (`max_age_rating` is always NULL for OIDC), an in-app age cohort,
        // and a stale-true `is_admin` on an unpinned row all read as
        // unrestricted under the old code. `resolveTokenUserAccess` is the
        // SAME composition every other surface uses for a token-derived
        // subject (forward-auth's session path, `user-notifier.service.ts`'s
        // `boundaryFor`) — see `resolve-token-user-access.ts`'s module doc
        // comment. Case-fold the username the same way its other callers do
        // (e.g. `subsonic-compat/auth.ts`); `row.username` is already the
        // canonical stored value, but every comparison stays folded on
        // principle. A `null`, disabled or deleted result counts the
        // participant as blocked (fail closed) rather than falling back to
        // the raw column.
        const access = await resolveTokenUserAccess(row.username.toLowerCase());
        if (!access || access.disabled || access.deleted) {
            blocked.push(name);
            continue;
        }
        // Ruling F-I2 (fix plan 6): for a non-admin, the effective cap is the
        // STRICTER of the resolver's cap and the raw `users.max_age_rating`
        // column (NULL = no cap). The resolver reads the column only for a
        // pinned row and otherwise derives the cap from `users.groups`, which
        // a Valkey-less forward-auth install never syncs while its upsert
        // still writes `max_age_rating` — so a column-only cap read as
        // unrestricted here. Kept local to Watch Together: the resolver backs
        // every token path, and a stale stricter column only over-blocks a
        // participant here (the host's navigate is refused), never grants.
        const isAdmin = access.permissions.ownerIsAdmin;
        const maxAgeRating = isAdmin
            ? access.permissions.maxAgeRating
            : mergeMaxAge(access.permissions.maxAgeRating, row.max_age_rating);
        const isAgeRestricted = isAdmin
            ? access.permissions.isAgeRestricted
            : access.permissions.isAgeRestricted || maxAgeRating !== null;
        // `satisfies Pick<UserContext, ...>` (not a bare `as UserContext` cast)
        // is the guard: checkMediaAccess reads isAgeRestricted off this object,
        // and a plain `as` cast let it compile with the field silently missing
        // (undefined), which made `if (!user.isAgeRestricted) return true;` in
        // checkMediaAccess skip the age gate unconditionally for every
        // participant here — see admin/fix/visibility-check.ts for the sibling
        // that already does this correctly and the comment explaining why.
        const subject = {
            userId: toUserId(row.id),
            username: row.username,
            groups: access.userGroups.join(','),
            userGroups: access.userGroups,
            ownerIsAdmin: isAdmin,
            maxAgeRating,
            isAgeRestricted,
        } satisfies Pick<
            UserContext,
            | 'userId'
            | 'username'
            | 'groups'
            | 'userGroups'
            | 'ownerIsAdmin'
            | 'maxAgeRating'
            | 'isAgeRestricted'
        >;
        const allowed = await checkMediaAccess(db, itemId, subject as unknown as UserContext);
        if (!allowed) blocked.push(name);
    }
    return blocked;
}

/**
 * Is this exact (session, user, client) already a participant?
 *
 * Exists so the join rate limit can skip idempotent rejoins. A client on a
 * flaky connection re-POSTs `join` on every SSE reconnect; each one is a no-op
 * inside `joinSession` (the matching-clientId early return adds nobody), but it
 * still consumed a unit of the 20/60s budget. Twenty reconnects in a minute —
 * entirely reachable on bad mobile network — locked a user out of rejoining
 * their OWN party for the rest of the window.
 *
 * Safe to exempt: being a participant means this caller already passed the
 * media-access gate for this session. It buys an attacker nothing, because a
 * guessed code resolves to a session they are not in, so they fall through to
 * the limit exactly as before.
 *
 * Returns false on any error or missing session — the caller then applies the
 * limit, which is the conservative direction.
 */
export async function isExistingParticipant(
    code: string,
    userId: string,
    clientId: string | undefined,
): Promise<boolean> {
    if (!clientId) return false;
    try {
        const session = await getSession(code);
        if (!session) return false;
        return session.participants.some(
            (participant) => participant.clientId === clientId && participant.userId === userId,
        );
    } catch {
        return false;
    }
}

export async function getUserActiveSession(userId: string): Promise<string | null> {
    try {
        await connectValkey();
        if (!isCoordinationValkeyReady()) return null;

        return await cacheGet(KEYS.USER_SESSION(userId));
    } catch (error) {
        logger.error('Failed to get user session', error as Error, { userId });
        return null;
    }
}

/**
 * Join an existing session.
 *
 * **`viewer` is required, and the media-access check below is the reason.**
 * A join code is the intended sharing mechanism — you paste it to someone — so
 * "holds the code" says nothing about entitlement. Before this check, joining
 * returned the full session (`itemId`, `title`, `posterUrl`, `fileId`,
 * `hostDisplayName`) to anyone authenticated, including users outside the title's
 * library group and accounts under its age rating. The playback routes were
 * (and are) independently gated, so no bytes ever leaked — but the metadata
 * did, and on a `max_age_rating` account that is the whole complaint.
 *
 * The check lives HERE rather than in the two route handlers because there are
 * two join paths — `POST {code}/join` and `POST {code}/events` with
 * `type:'join'`, the latter explicitly exempt from the participant check — and
 * a third would eventually miss it. One chokepoint, required param, so the
 * type checker refuses a caller that has not thought about it.
 *
 * Denial returns `null`, which callers already map to 404 rather than 403.
 * That is deliberate and matches the repo convention for access denial (see
 * `resolveAndGate`): a 403 would confirm the party exists.
 */
export async function joinSession(
    code: string,
    userId: string,
    displayName: string,
    clientId: string | undefined,
    viewer: UserContext | undefined,
): Promise<StoredSession | null> {
    // Leave a different party before acquiring this party's lease, avoiding
    // cross-party lock inversion when two users switch parties concurrently.
    if (!viewer) return null;
    await connectValkey();
    if (!isCoordinationValkeyReady()) return null;
    const existingCode = await cacheGet(KEYS.USER_SESSION(userId));
    if (existingCode && existingCode !== code.toUpperCase()) {
        const target = await getSession(code);
        if (!target || !(await participantMayAccess(target.itemId, viewer))) return null;
        await leaveSession(existingCode, userId);
    }
    return (
        (await withBufferTransition(code, () =>
            joinSessionLocked(code, userId, displayName, clientId, viewer),
        )) || null
    );
}

async function joinSessionLocked(
    code: string,
    userId: string,
    displayName: string,
    clientId: string | undefined,
    viewer: UserContext | undefined,
): Promise<StoredSession | null> {
    try {
        await connectValkey();
        if (!isCoordinationValkeyReady()) return null;

        const session = await getSession(code);
        if (!session) {
            logger.warn('Session not found', { code });
            return null;
        }

        // Fail closed: every caller reaches this through an authenticated auth
        // spec, so a missing viewer is a wiring mistake, not an anonymous user.
        // `checkMediaAccess` returns TRUE for an undefined user (it defers to
        // auth middleware), so passing one straight through would silently make
        // this whole gate a no-op.
        if (!viewer) {
            logger.warn('Join refused — no viewer context', { code });
            return null;
        }
        if (!(await participantMayAccess(session.itemId, viewer))) {
            logger.warn('Join refused — viewer lacks access to the session item', {
                code,
                itemId: session.itemId,
            });
            return null;
        }

        // Generate clientId if not provided
        const finalClientId =
            clientId || `${userId}-${Date.now()}-${crypto.randomUUID()}`;

        // Check if this exact client is already in session (same clientId)
        const existingClient = session.participants.find((p) => p.clientId === finalClientId);
        if (existingClient) {
            if (!findParticipant(session, userId, finalClientId)) return null;
            // Re-establish the per-user active-session pointer even on a pure
            // rejoin. A client relaunching (app foreground / SSE reconnect) with
            // the same clientId must be able to restore the party via
            // GET /watch-together; without this the early return below skips the
            // pointer write and launch-restore sees {session: null}. Idempotent.
            // Guard on userId: clientId is client-supplied, so only write the
            // pointer when this client genuinely belongs to this user (never mint
            // a pointer for a spoofed clientId that maps to a different member).
            if (existingClient.userId.toLowerCase() === userId.toLowerCase()) {
                await setEx(KEYS.USER_SESSION(userId), SESSION_TTL, code.toUpperCase());
            }

            // Rejoin (e.g., page reload). If the party is playing, schedule a
            // buffer check so this client is re-integrated at the right
            // position instead of sitting paused until drift detection fires.
            if (session.isPlaying) {
                bufferTransitionScope.exit(() =>
                    setTimeout(() => {
                        void (async () => {
                            try {
                                // A seek/drift buffer check may have started during
                                // the delay — never clobber it with stale state.
                                // Re-read the session: position/play state may have
                                // moved (host seek, pause) since the rejoin.
                                await initiateJoinBufferCheck(code, session.timelineId);
                            } catch (err) {
                                logger.warn(
                                    'Failed to initiate buffer check after rejoin',
                                    err as Error,
                                );
                            }
                        })();
                    }, 1000),
                );
            }
            return session; // This exact client already joined
        }

        // Note: We allow the same userId to join multiple times with different clientIds
        // This supports watching from multiple devices/tabs

        // Leave any existing session in a DIFFERENT watch party first
        // But don't leave if joining the same session from another device

        // Drop participants whose SSE connection has been silent past the stale
        // window. A client that closes without calling `leave` (tab killed, app
        // backgrounded, network dropped) never removes itself, so over a
        // session's 4-hour life the array accumulates ghosts. That is not just
        // untidy: the whole array is serialized and rewritten on EVERY join, and
        // it drives buffer-check expectations, so ghosts make the party wait on
        // clients that will never report ready.
        //
        // Pruning here rather than on a timer keeps it to the one path that
        // already rewrites the array. Never prunes the host (losing them would
        // trigger a host transfer from a bookkeeping step) and never prunes a
        // participant who has not yet had time to open an SSE stream.
        session.participants = await pruneGhostParticipants(code, session);

        if (session.participants.length >= MAX_PARTICIPANTS) {
            logger.warn('Join refused — participant cap reached', {
                code,
                cap: MAX_PARTICIPANTS,
            });
            return null;
        }

        // Add participant with clientId
        const participant: StoredParticipant = {
            userId,
            displayName,
            joinedAt: Date.now(),
            clientId: finalClientId,
        };
        session.participants.push(participant);

        // Update session
        await setTransitionValue(
            KEYS.SESSION(code.toUpperCase()),
            SESSION_TTL,
            JSON.stringify(session),
        );

        // Track user's active session
        await setEx(KEYS.USER_SESSION(userId), SESSION_TTL, code.toUpperCase());

        // Capture and persist the intended state before pausing. SET-NX makes
        // concurrent joins share the first join's pre-pause intent; explicit
        // play/pause updates can still revise it during the grace period.
        const shouldResume = session.isPlaying;
        await rememberJoinResumeIntent(code, shouldResume);

        // Pause playback for everyone when someone joins
        session.isPlaying = false;
        session.lastSync = Date.now();

        // Update session with paused state
        await setTransitionValue(
            KEYS.SESSION(code.toUpperCase()),
            SESSION_TTL,
            JSON.stringify(session),
        );

        // Notify other participants about the new joiner
        await broadcastToSession(code, {
            type: 'participant_joined',
            participant,
        });

        // Initiate buffer check - pauses everyone, waits for buffers, then resumes in sync
        // Small delay to let the new joiner's SSE connect first
        bufferTransitionScope.exit(() =>
            setTimeout(() => {
                void (async () => {
                    try {
                        await initiateJoinBufferCheck(code, session.timelineId, shouldResume);
                    } catch (err) {
                        logger.warn('Failed to initiate buffer check after join', err as Error);
                    }
                })();
            }, 1000),
        );

        logger.info('User joined session', { code, displayName });
        return session;
    } catch (error) {
        logger.error('Failed to join session', error as Error, {
            code,
            userId,
        });
        return null;
    }
}

/**
 * Leave a session
 * If the host leaves and there are remaining participants, a new host is chosen (oldest joiner).
 * The session only ends if there are no participants left.
 *
 * @param code - Session code
 * @param userId - User ID (used for host check and fallback)
 * @param clientId - Optional client ID. If provided, only removes that specific client.
 *                   If not provided, removes ALL participants with this userId.
 */
export async function leaveSession(
    code: string,
    userId: string,
    clientId?: string,
    staleDeparture?: { joinedAt: number; marker: string; now: number },
): Promise<boolean> {
    return withBufferTransition(code, () =>
        leaveSessionLocked(code, userId, clientId, staleDeparture),
    );
}

async function leaveSessionLocked(
    code: string,
    userId: string,
    clientId?: string,
    staleDeparture?: { joinedAt: number; marker: string; now: number },
): Promise<boolean> {
    try {
        await connectValkey();
        if (!isCoordinationValkeyReady()) return false;

        const original = staleDeparture ? await cacheGet(KEYS.SESSION(code)) : null;
        const session = staleDeparture
            ? original
                ? parseStoredSession(original)
                : null
            : await getSession(code);
        if (!session) return false;

        if (staleDeparture) {
            const participant = session.participants.find((p) => p.clientId === clientId);
            if (
                !participant ||
                participant.joinedAt !== staleDeparture.joinedAt ||
                participant.userId !== userId ||
                participant.clientId === session.hostClientId ||
                (!session.hostClientId && participant.userId === session.hostUserId) ||
                staleDeparture.now - participant.joinedAt < PARTICIPANT_GRACE_MS
            )
                return false;
            const marker = await hGet(KEYS.CONNECTIONS(code), clientId!);
            if (
                !marker ||
                marker !== staleDeparture.marker ||
                !Number.isFinite(Number(marker)) ||
                staleDeparture.now - Number(marker) <= CONNECTION_STALE_MS
            )
                return false;
        }

        // Find the leaving participant(s)
        let leavingParticipants: StoredParticipant[];
        if (clientId !== undefined) {
            // Remove specific client only
            const participant = findParticipant(session, userId, clientId);
            if (!participant) return false;
            leavingParticipants = [participant];
            session.participants = session.participants.filter((p) => p !== participant);
        } else {
            // Remove all participants with this userId (legacy behavior)
            leavingParticipants = session.participants.filter(
                (p) => p.userId.toLowerCase() === userId.toLowerCase(),
            );
            session.participants = session.participants.filter(
                (p) => p.userId.toLowerCase() !== userId.toLowerCase(),
            );
        }

        if (leavingParticipants.length === 0) {
            return false; // No matching participant found
        }

        const ownerUserId = leavingParticipants[0].userId;
        const displayName = leavingParticipants[0]?.displayName || ownerUserId;

        // Check if host is leaving (any of the leaving participants is the host)
        const wasHost = leavingParticipants.some(
            (p) => p.userId.toLowerCase() === session.hostUserId.toLowerCase(),
        );
        // Preserve the host user while another device remains; replace a departed host device.
        const hostStillHasClients = session.participants.some(
            (p) => p.userId.toLowerCase() === session.hostUserId.toLowerCase(),
        );
        const hostDeviceLeft = leavingParticipants.some((p) => p.clientId === session.hostClientId);
        const needsNewHost = wasHost && (!hostStillHasClients || hostDeviceLeft);

        // If no participants left, end session
        if (session.participants.length === 0) {
            return await endSession(code, ownerUserId);
        }

        // Pick the oldest surviving host device, or promote a new user if none remain.
        if (needsNewHost) {
            // Sort by joinedAt (oldest first) and pick the first one
            const sortedParticipants = session.participants
                .filter(
                    (p) =>
                        !hostStillHasClients ||
                        p.userId.toLowerCase() === session.hostUserId.toLowerCase(),
                )
                .sort((a, b) => a.joinedAt - b.joinedAt);
            const newHost = sortedParticipants[0];

            session.hostUserId = newHost.userId;
            session.hostDisplayName = newHost.displayName;
            session.hostClientId = newHost.clientId; // Track the new host's specific client
            // The new host starts its absence clock now, not at the old host's last sighting.
            await markHostSeen(code);

            logger.info('Host left, promoting new host', {
                code,
                oldHost: userId,
                newHost: newHost.userId,
                newHostDisplayName: newHost.displayName,
                newHostClientId: newHost.clientId,
            });
        }

        // Update session
        if (staleDeparture) {
            const client = getCoordinationClient();
            if (!client || !original || !clientId) return false;
            // Atomically compare both the membership generation and liveness.
            // A concurrent join/heartbeat/reconnect wins; retry next sweep.
            const removed = await transitionCommand(
                [KEYS.SESSION(code), KEYS.CONNECTIONS(code), KEYS.USER_SESSION(ownerUserId)],
                [
                    original,
                    clientId,
                    staleDeparture.marker,
                    JSON.stringify(session),
                    String(SESSION_TTL),
                    session.participants.some(
                        (p) => p.userId.toLowerCase() === ownerUserId.toLowerCase(),
                    )
                        ? '0'
                        : '1',
                    code.toUpperCase(),
                ],
                `-- watch-together stale membership removal
                 if redis.call('GET', KEYS[1]) ~= ARGV[1] or redis.call('HGET', KEYS[2], ARGV[2]) ~= ARGV[3] then return 0 end
                 redis.call('SET', KEYS[1], ARGV[4], 'EX', ARGV[5]);
                 if ARGV[6] == '1' and redis.call('GET', KEYS[3]) == ARGV[7] then redis.call('DEL', KEYS[3]) end; return 1`,
            );
            if (Number(removed) !== 1) return false;
        } else {
            await setTransitionValue(
                KEYS.SESSION(code.toUpperCase()),
                SESSION_TTL,
                JSON.stringify(session),
            );
        }

        // Only remove user's session tracking if they have no more clients in this session
        const userStillInSession = session.participants.some(
            (p) => p.userId.toLowerCase() === ownerUserId.toLowerCase(),
        );
        if (!userStillInSession && !staleDeparture) {
            await clearUserSessionIfCurrent(ownerUserId, code);
        }

        // Handle buffer check state for each leaving participant
        // This prevents "stuck waiting for X" when someone leaves during sync
        const upperCode = code.toUpperCase();
        for (const leaving of leavingParticipants) {
            if (leaving.clientId) {
                await handleParticipantLeftDuringBufferCheck(upperCode, leaving.clientId);
            }
        }

        // Notify remaining participants that someone left
        // Include clientId so clients can remove the specific participant
        await broadcastToSession(code, {
            type: 'participant_left',
            userId: ownerUserId,
            displayName,
            clientId,
        });

        // If host changed, notify about the new host (include clientId for multi-device support)
        if (needsNewHost) {
            await broadcastToSession(code, {
                type: 'host_changed',
                newHostUserId: session.hostUserId,
                newHostDisplayName: session.hostDisplayName,
                newHostClientId: session.hostClientId,
            });
        }

        logger.info('User left session', { code, userId, wasHost });
        return true;
    } catch (error) {
        logger.error('Failed to leave session', error as Error, {
            code,
            userId,
        });
        return false;
    }
}

/**
 * Tear down a session: notify participants, drop every user-session pointer,
 * delete the session key, and clear SSE/position-tracking state.
 *
 * Shared by the host-authorized `endSession` and the internal
 * `endSessionAsSystem` — the caller has ALREADY decided this teardown is
 * authorized; this helper does no authorization of its own.
 */
async function performEndSession(code: string, session: StoredSession): Promise<boolean> {
    try {
        // Notify all participants with host info
        await broadcastToSession(code, {
            type: 'session_ended',
            hostUserId: session.hostUserId,
            hostDisplayName: session.hostDisplayName,
        });

        // Clean up all participant user-session mappings
        for (const participant of session.participants) {
            await clearUserSessionIfCurrent(participant.userId, code);
        }

        // The terminal publication already removed the session atomically.
        // Fence the remaining cleanup too: an expired owner cannot delete a
        // newer owner's connection/control state.
        await transitionCommand(
            [KEYS.CONNECTIONS(code), KEYS.HOST_SEEN(code), KEYS.PLAY_STATE(code)],
            [],
            "redis.call('DEL', KEYS[1], KEYS[2], KEYS[3]); return 1",
        );
        sseConnections.delete(code.toUpperCase());
        await cleanupPositionTracking(code);

        logger.info('Session ended', { code, hostUserId: session.hostUserId });
        return true;
    } catch (error) {
        logger.error('Failed to end session', error as Error, { code });
        return false;
    }
}

/**
 * Shared preamble for `endSession` / `endSessionAsSystem` (deferred item 14,
 * 2026-09-13 security review): both used to duplicate the identical
 * connect-Valkey / ready-check / `getSession` sequence. Extracted here so
 * there is ONE implementation of that scaffolding; each caller still applies
 * its OWN authorization logic on the returned session before calling
 * `performEndSession` — `endSession`'s host-only check is NOT part of this
 * preamble (see its own docstring for why), so behaviour is unchanged for
 * both callers.
 */
async function loadSessionForEnd(
    code: string,
): Promise<
    | { status: 'not_ready' }
    | { status: 'already_gone' }
    | { status: 'ready'; session: StoredSession }
> {
    await connectValkey();
    if (!isCoordinationValkeyReady()) return { status: 'not_ready' };

    const session = await getSession(code);
    if (!session) return { status: 'already_gone' }; // Already gone

    return { status: 'ready', session };
}

/**
 * End a session — HOST ONLY. `userId` must be the session's current host; there
 * is no string that bypasses this check (there used to be a `'system'`
 * sentinel here, which meant a real account literally named `system` could end
 * ANY party — see `endSessionAsSystem` for the actual internal-cleanup path).
 */
export async function endSession(code: string, userId: string): Promise<boolean> {
    return withBufferTransition(code, () => endSessionLocked(code, userId));
}

async function endSessionLocked(code: string, userId: string): Promise<boolean> {
    try {
        const preamble = await loadSessionForEnd(code);
        if (preamble.status === 'not_ready') return false;
        if (preamble.status === 'already_gone') return true;

        const { session } = preamble;
        if (userId !== session.hostUserId) {
            logger.warn('Non-host tried to end session', { code, userId });
            return false;
        }

        return await performEndSession(code, session);
    } catch (error) {
        logger.error('Failed to end session', error as Error, { code });
        return false;
    }
}

/**
 * End a session on behalf of the server's own stale-session sweep
 * (`cleanupStaleSessions`). Internal-only: nothing in a request path may reach
 * this — there is no username or client input that selects it — so it needs no
 * host check. Do NOT wire this to any user-facing input; user-triggered ends
 * must go through `endSession` (host-only) or `disbandSession`.
 */
export async function endSessionAsSystem(code: string): Promise<boolean> {
    return withBufferTransition(code, () => endSessionAsSystemLocked(code));
}

async function endSessionAsSystemLocked(code: string): Promise<boolean> {
    try {
        const preamble = await loadSessionForEnd(code);
        if (preamble.status === 'not_ready') return false;
        if (preamble.status === 'already_gone') return true;

        return await performEndSession(code, preamble.session);
    } catch (error) {
        logger.error('Failed to end session (system)', error as Error, { code });
        return false;
    }
}

/**
 * Transfer host status to another participant (current host only)
 */
export async function transferHost(
    code: string,
    currentHostUserId: string,
    newHostUserId: string,
): Promise<boolean> {
    return withBufferTransition(code, () =>
        transferHostLocked(code, currentHostUserId, newHostUserId),
    );
}

async function transferHostLocked(
    code: string,
    currentHostUserId: string,
    newHostUserId: string,
): Promise<boolean> {
    try {
        await connectValkey();
        if (!isCoordinationValkeyReady()) return false;

        const session = await getSession(code);
        if (!session) {
            logger.warn('Session not found for host transfer', { code });
            return false;
        }

        // Verify current user is the host
        if (session.hostUserId !== currentHostUserId) {
            logger.warn('Non-host tried to transfer host status', {
                code,
                currentHostUserId,
            });
            return false;
        }

        // Find the new host in participants
        const newHost = session.participants.find((p) => p.userId === newHostUserId);
        if (!newHost) {
            logger.debug('New host not found in participants', {
                code,
                newHostUserId,
            });
            return false;
        }

        // Can't transfer to yourself
        if (newHostUserId === currentHostUserId) {
            logger.warn('Cannot transfer host to yourself', { code });
            return false;
        }

        // Update session with new host (including their clientId)
        session.hostUserId = newHostUserId;
        session.hostDisplayName = newHost.displayName;
        session.hostClientId = newHost.clientId;

        await setTransitionValue(
            KEYS.SESSION(code.toUpperCase()),
            SESSION_TTL,
            JSON.stringify(session),
        );
        await markHostSeen(code);

        // Notify all participants about the host change (include clientId for multi-device support)
        await broadcastToSession(code, {
            type: 'host_changed',
            newHostUserId: newHostUserId,
            newHostDisplayName: newHost.displayName,
            newHostClientId: newHost.clientId,
        });

        logger.info('Host transferred', {
            code,
            fromUserId: currentHostUserId,
            toUserId: newHostUserId,
            toClientId: newHost.clientId,
        });
        return true;
    } catch (error) {
        logger.error('Failed to transfer host', error as Error, { code });
        return false;
    }
}

/**
 * Disband session - host can end session from any device
 * Unlike endSession, this checks if user is host across ANY of their clients
 */
export async function disbandSession(code: string, userId: string): Promise<boolean> {
    try {
        await connectValkey();
        if (!isCoordinationValkeyReady()) return false;

        const session = await getSession(code);
        if (!session) return true; // Already gone

        // Check if user is the host (regardless of which device/clientId)
        if (session.hostUserId !== userId) {
            logger.warn('Non-host tried to disband session', {
                code,
                userId,
                hostUserId: session.hostUserId,
            });
            return false;
        }

        // Use endSession to clean up properly
        return await endSession(code, userId);
    } catch (error) {
        logger.error('Failed to disband session', error as Error, { code });
        return false;
    }
}

/**
 * Toggle session visibility (host only)
 * When visibility is unlisted, the session won't appear on the homepage
 */
export async function setSessionVisibility(
    code: string,
    userId: string,
    visibility: 'unlisted' | 'listed',
): Promise<boolean> {
    return withBufferTransition(code, () => setSessionVisibilityLocked(code, userId, visibility));
}

async function setSessionVisibilityLocked(
    code: string,
    userId: string,
    visibility: 'unlisted' | 'listed',
): Promise<boolean> {
    try {
        await connectValkey();
        if (!isCoordinationValkeyReady()) return false;

        const session = await getSession(code);
        if (!session) {
            logger.warn('Session not found for visibility toggle', { code });
            return false;
        }

        // Only host can change visibility
        if (session.hostUserId !== userId) {
            logger.warn('Non-host tried to change visibility', {
                code,
                userId,
            });
            return false;
        }

        session.visibility = visibility;

        await setTransitionValue(
            KEYS.SESSION(code.toUpperCase()),
            SESSION_TTL,
            JSON.stringify(session),
        );

        // Broadcast visibility change to all participants
        await broadcastToSession(code, {
            type: 'visibility_changed',
            visibility,
        });

        logger.info('Session visibility changed', { code, visibility });
        return true;
    } catch (error) {
        logger.error('Failed to change session visibility', error as Error, {
            code,
        });
        return false;
    }
}

/**
 * Update session playback state (any participant can control play/pause)
 *
 * IMPORTANT: Only the host can update currentTime.
 * Guests can only control play/pause state - their position is ignored.
 * This prevents guests from accidentally overwriting the position (e.g., when their video starts at 0).
 */
/**
 * How far a pausing guest may be AHEAD of the host's last heartbeat and still be
 * believed. The host heartbeats every 5 s, so while the party plays the stored
 * position trails the real one by up to ~5 s (plus delivery); 10 s covers that and
 * a 1.5x playback rate.
 */
const GUEST_PAUSE_MAX_LEAD_S = 10;

/**
 * A guest pausing a PLAYING party is the one moment its position beats the
 * session's: the stored host position is up to a heartbeat old, and it is what the
 * pause is broadcast with — so every other player (the host too) seeked BACK by up
 * to 5 s on a guest's pause (browser <-> Apple TV e2e: TV at 4.9 s jumped to 1.5 s).
 * The guest's position is only taken when it is where a guest in sync would be: at
 * or just ahead of the last host heartbeat. That keeps the original protection — a
 * guest whose player still sits at 0 can never rewind the party.
 */
function isPlausibleGuestPausePosition(session: StoredSession, state: WatchTogetherState): boolean {
    if (!session.isPlaying || state.isPlaying) return false;
    if (!Number.isFinite(state.currentTime)) return false;
    const lead = state.currentTime - session.currentTime;
    return lead >= -1 && lead <= GUEST_PAUSE_MAX_LEAD_S;
}

export async function updatePlaybackState(
    code: string,
    userId: string,
    state: WatchTogetherState,
    clientId?: string,
    itemId?: string,
    expectedTimelineId?: string,
    syncId?: string,
): Promise<boolean> {
    const preflight = await getSessionWithParticipant(code, userId, clientId);
    if (!preflight) return false;
    return withBufferTransition(code, () =>
        updatePlaybackStateLocked(
            code,
            userId,
            state,
            clientId,
            itemId,
            expectedTimelineId,
            syncId,
        ),
    );
}

async function updatePlaybackStateLocked(
    code: string,
    userId: string,
    state: WatchTogetherState,
    clientId?: string,
    itemId?: string,
    expectedTimelineId?: string,
    syncId?: string,
): Promise<boolean> {
    try {
        const result = await getSessionWithParticipant(code, userId, clientId);
        if (!result) {
            logger.warn('Non-participant tried to update playback state', {
                code,
                userId,
            });
            return false;
        }

        const { session, participant } = result;
        if (
            (itemId && session.itemId !== itemId) ||
            (expectedTimelineId && session.timelineId !== expectedTimelineId)
        )
            return true;

        const isHost = isHostClient(session, clientId ?? participant.clientId, userId);

        await connectValkey();
        if (!isCoordinationValkeyReady()) return false;

        // Only host can update position - prevents guests from overwriting with stale values
        // Guests can still control play/pause
        if (isHost) {
            session.currentTime = state.currentTime;
        } else if (isPlausibleGuestPausePosition(session, state)) {
            session.currentTime = state.currentTime;
        }
        session.isPlaying = state.isPlaying;
        session.playbackRate = state.playbackRate;
        session.lastSync = Date.now();
        await pinExplicitPlayState(code, state.isPlaying);
        await updateJoinResumeIntentIfPending(code, state.isPlaying);
        // If a barrier is in flight, fold this play/pause into it so the concluding
        // all_ready resumes (or stays paused) as intended — a play pressed during a
        // seek barrier is otherwise dropped by the guest and the guest stays stuck
        // paused. No-op when no buffer check is pending.
        await updateBufferCheckIsPlaying(code, state.isPlaying);

        // Save to Valkey
        await setTransitionValue(
            KEYS.SESSION(code.toUpperCase()),
            SESSION_TTL,
            JSON.stringify(session),
        );

        // Every participant, including the sender, consumes the committed order.
        // A peer control can arrive while the sender awaits its own request.
        // Use the session's currentTime (not the incoming state) to ensure consistency
        await broadcastToSession(code, {
            type: 'sync',
            syncId,
            timelineId: session.timelineId,
            state: {
                currentTime: session.currentTime,
                isPlaying: session.isPlaying,
                playbackRate: session.playbackRate,
                timestamp: session.lastSync,
            },
            userId,
            displayName: participant.displayName,
            clientId,
        });

        return true;
    } catch (error) {
        logger.error('Failed to update playback state', error as Error, {
            code,
        });
        return false;
    }
}

/**
 * Update session position without broadcasting (heartbeat)
 * Used to keep session state fresh for new joiners
 *
 * IMPORTANT: Only the host can update the session's currentTime.
 * This prevents guests from accidentally overwriting the position (e.g., when their video starts at 0).
 *
 * If the user is the host, this also broadcasts the position to all participants
 * for smooth catch-up synchronization.
 */
export async function updateSessionPosition(
    code: string,
    userId: string,
    currentTime: number,
    clientId: string,
    isPlaying?: boolean,
    itemId?: string,
    expectedTimelineId?: string,
): Promise<boolean> {
    // Heartbeats are unthrottled: never let a non-member contend for the party lock.
    const preflight = await getSessionWithParticipant(code, userId, clientId);
    if (!preflight) return false;
    return withBufferTransition(code, () =>
        updateSessionPositionLocked(
            code,
            userId,
            currentTime,
            clientId,
            isPlaying,
            itemId,
            expectedTimelineId,
        ),
    );
}

async function updateSessionPositionLocked(
    code: string,
    userId: string,
    currentTime: number,
    clientId: string,
    isPlaying?: boolean,
    itemId?: string,
    expectedTimelineId?: string,
): Promise<boolean> {
    try {
        await connectValkey();
        const client = getCoordinationClient();
        if (!isCoordinationValkeyReady() || !client) return false;
        const now = Date.now();
        // Read the CURRENT session inside the update. A heartbeat sampled before
        // a guest departure or host transfer must never restore old membership.
        const result = await transitionCommand(
            [KEYS.SESSION(code), KEYS.PLAY_STATE(code), KEYS.HOST_SEEN(code)],
            [
                userId,
                clientId,
                String(currentTime),
                isPlaying === undefined ? '' : isPlaying ? '1' : '0',
                String(now),
                String(SESSION_TTL),
                String(HOST_SEEN_TTL_S),
                itemId ?? '',
                expectedTimelineId ?? '',
            ],
            `local raw = redis.call('GET', KEYS[1])
             if not raw then return nil end
             local session = cjson.decode(raw)
             local member = false
             for _, p in ipairs(session.participants) do
                 if string.lower(p.userId) == string.lower(ARGV[1]) and p.clientId == ARGV[2] then member = true end
             end
             if not member then return nil end
             if (ARGV[8] ~= '' and session.itemId ~= ARGV[8]) or (ARGV[9] ~= '' and session.timelineId ~= ARGV[9]) then return cjson.encode({session = session, isHost = false}) end
             local host = string.lower(session.hostUserId) == string.lower(ARGV[1]) and (not session.hostClientId or session.hostClientId == ARGV[2])
             if host then
                 session.currentTime = tonumber(ARGV[3])
                 if ARGV[4] ~= '' then
                     local pinned = redis.call('GET', KEYS[2])
                     if pinned then session.isPlaying = pinned == '1' else session.isPlaying = ARGV[4] == '1' end
                 end
                 redis.call('SET', KEYS[3], ARGV[5], 'EX', ARGV[7])
             end
             session.lastSync = tonumber(ARGV[5])
             redis.call('SET', KEYS[1], cjson.encode(session), 'EX', ARGV[6])
             return cjson.encode({session = session, isHost = host})`,
        );
        if (typeof result !== 'string') return false;
        const updated = JSON.parse(result) as { session: StoredSession; isHost: boolean };
        if (updated.isHost) {
            await broadcastToSession(code, {
                type: 'host_position',
                position: updated.session.currentTime,
                timestamp: now,
                isPlaying: updated.session.isPlaying,
                playbackRate: updated.session.playbackRate,
            });
        }

        return true;
    } catch (error) {
        logger.error('Failed to update session position', error as Error, {
            code,
        });
        return false;
    }
}

/**
 * Register SSE connection for a session
 * Subscribes to Valkey pub/sub for cross-replica event distribution
 *
 * @param code - Session code
 * @param clientId - Unique client identifier (for echo filtering)
 * @param callback - Function to call when events are received
 */
export async function registerSSEConnection(
    code: string,
    clientId: string,
    callback: (event: SSEEventType, seq?: number) => void,
): Promise<() => void> {
    const upperCode = code.toUpperCase();

    // Register local callback with clientId for echo filtering. Keep the
    // entry's identity so a fast reconnect (same clientId replaces this map
    // entry) can be distinguished from THIS connection at cleanup time.
    if (!sseConnections.has(upperCode)) {
        sseConnections.set(upperCode, new Map());
    }
    const connectionEntry: SSEConnection = { clientId, callback };
    sseConnections.get(upperCode)!.set(clientId, connectionEntry);

    // Mark this connection as live (cross-replica; used to size buffer checks)
    await touchSSEConnection(upperCode, clientId);

    // Subscribe to Valkey pub/sub channel for this session
    // This allows receiving events from other replicas
    const unsubscribe = await subscribeToChannel(
        KEYS.PUBSUB_CHANNEL(upperCode),
        (message: string) => {
            try {
                const parsed = JSON.parse(message) as PubSubMessage;
                // Skip if this is an echo (sender's own event)
                if (parsed.excludeClientId && parsed.excludeClientId === clientId) {
                    logger.debug('Skipping echo for client', {
                        code: upperCode,
                        clientId: clientId.substring(0, 12),
                    });
                    return;
                }
                // Forward to this local SSE connection
                callback(parsed.event, parsed.seq);
            } catch (err) {
                logger.warn('Failed to parse pub/sub message', { code: upperCode }, err as Error);
            }
        },
    );

    // Track unsubscribe function for cleanup
    if (unsubscribe) {
        if (!pubsubUnsubscribers.has(upperCode)) {
            pubsubUnsubscribers.set(upperCode, new Set());
        }
        pubsubUnsubscribers.get(upperCode)!.add(unsubscribe);
    }

    logger.debug('SSE connection registered with pub/sub', {
        code: upperCode,
        clientId: clientId.substring(0, 12),
    });

    // Return cleanup function
    return () => {
        // A fast reconnect replaces this clientId's map entry BEFORE the old
        // stream's cleanup runs. Only tear down shared per-client state when
        // this connection still owns the entry — otherwise the old cleanup
        // would erase the NEW connection's callback, liveness marker, and
        // stall entry.
        const connections = sseConnections.get(upperCode);
        const stillOwnsClient = connections?.get(clientId) === connectionEntry;
        if (connections && stillOwnsClient) {
            connections.delete(clientId);
            if (connections.size === 0) {
                sseConnections.delete(upperCode);
            }
        }

        if (stillOwnsClient) {
            // Retain the last keepalive timestamp. A stream closing on an old
            // replica cannot erase a fresh reconnect elsewhere; the sweeper
            // removes stale guests only after the reconnect grace expires.

            // If this client was blocking the group on a stall, clear it and
            // resume the others instead of leaving them frozen.
            void (async () => {
                await withStallLock(upperCode, undefined, async () => {
                    try {
                        await connectValkey();
                        if (isCoordinationValkeyReady() && clientId) {
                            const removed = await hDel(KEYS.STALLED(upperCode), clientId);
                            if (removed > 0) {
                                await resumeIfNoActiveStalls(upperCode);
                            }
                        }
                    } catch (err) {
                        logger.warn(
                            'Failed to clear stall on disconnect',
                            { code: upperCode },
                            err as Error,
                        );
                    }
                });
            })();
        }

        // Unsubscribe from pub/sub
        if (unsubscribe) {
            const unsubs = pubsubUnsubscribers.get(upperCode);
            if (unsubs) {
                unsubs.delete(unsubscribe);
                if (unsubs.size === 0) {
                    pubsubUnsubscribers.delete(upperCode);
                }
            }
            unsubscribe().catch((err) => {
                logger.warn(
                    'Failed to unsubscribe from pub/sub',
                    { code: upperCode },
                    err as Error,
                );
            });
        }

        logger.debug('SSE connection unregistered', {
            code: upperCode,
            clientId: clientId.substring(0, 12),
        });
    };
}

/**
 * Broadcast event to all SSE connections for a session across all replicas
 * Uses Valkey pub/sub for cross-replica distribution
 *
 * @param code - Session code
 * @param event - Event to broadcast
 * @param excludeClientId - Don't send to this client (echo prevention)
 */
async function broadcastToSession(
    code: string,
    storedEvent: StoredFrame,
    excludeClientId?: string,
    navigationSession?: StoredSession,
): Promise<void> {
    const upperCode = code.toUpperCase();
    if (
        [
            'sync',
            'buffer_check',
            'all_ready',
            'host_position',
            'stall',
            'resume',
            'version_change',
        ].includes(storedEvent.type)
    ) {
        const origin = navigationSession ?? (await getSession(upperCode));
        storedEvent = { ...storedEvent, timelineId: origin?.timelineId } as StoredFrame;
    }
    const event = await toPublicFrame(storedEvent);

    logger.debug('Broadcasting to session via pub/sub', {
        code: upperCode,
        type: event.type,
        excludeClientId: excludeClientId?.substring(0, 12),
    });

    if (currentBufferTransition()) {
        const completion = event.type === 'all_ready' ? event : undefined;
        const timeout = completion ? bufferCheckTimeouts.get(upperCode) : undefined;
        const result = await transitionCommand(
            [
                KEYS.SEQ(upperCode),
                KEYS.REPLAY(upperCode),
                KEYS.PUBSUB_CHANNEL(upperCode),
                KEYS.BUFFER_CHECK(upperCode),
                KEYS.READY_STATES(upperCode, completion?.checkId ?? ''),
                KEYS.SESSION(upperCode),
                `watch:v2:navigation-commands:${upperCode}`,
                KEYS.STALLED(upperCode),
                KEYS.PLAY_STATE(upperCode),
            ],
            [
                JSON.stringify(event),
                excludeClientId ?? '',
                String(REPLAY_TTL),
                String(REPLAY_MAX),
                completion?.checkId ?? '',
                String(SESSION_TTL),
                String(Date.now()),
                navigationSession ? JSON.stringify(navigationSession) : '',
            ],
            `-- watch-together atomic timeline publication
             local frame = cjson.decode(ARGV[1])
             if ARGV[8] ~= '' then
                 if not redis.call('GET', KEYS[6]) then return redis.error_reply('PARTY_TRANSITION_MISSING') end
                 redis.call('SET', KEYS[6], ARGV[8], 'EX', ARGV[6])
                 redis.call('DEL', KEYS[8], KEYS[9])
                 redis.call('HSET', KEYS[7], frame.timelineId, '1')
                 redis.call('EXPIRE', KEYS[7], ARGV[6])
             end
             if frame.type == 'session_ended' then redis.call('DEL', KEYS[6]) end
             if ARGV[5] ~= '' then
                 local pending = redis.call('GET', KEYS[4])
                 if not pending then return nil end
                 local state = cjson.decode(pending)
                 if state.checkId ~= ARGV[5] then return nil end
                 local rawSession = redis.call('GET', KEYS[6])
                 if not rawSession then return nil end
                 local session = cjson.decode(rawSession)
                 frame.timelineId = session.timelineId
                 frame.currentTime = state.currentTime
                 frame.isPlaying = state.isPlaying
                 session.currentTime = state.currentTime
                 session.isPlaying = state.isPlaying
                 local clock = redis.call('TIME')
                 local now = tonumber(clock[1])*1000 + math.floor(tonumber(clock[2])/1000)
                 session.lastSync = now
                 frame.serverTime = now
                 frame.resumeAt = now + 1500
                 redis.call('SETEX', KEYS[6], ARGV[6], cjson.encode(session))
                 redis.call('DEL', KEYS[4], KEYS[5])
             end
             local seq = redis.call('INCR', KEYS[1])
             redis.call('EXPIRE', KEYS[1], ARGV[3])
             local entry = {seq=seq, event=frame}
             if ARGV[2] ~= '' then entry.excludeClientId = ARGV[2] end
             local encoded = cjson.encode(entry)
             redis.call('LPUSH', KEYS[2], encoded)
             redis.call('LTRIM', KEYS[2], 0, tonumber(ARGV[4])-1)
             redis.call('EXPIRE', KEYS[2], ARGV[3])
             local published = redis.call('PUBLISH', KEYS[3], encoded)
             return {seq, published, encoded}`,
        );
        if (result == null) return; // A different completion already consumed this generation.
        if (!Array.isArray(result)) throw new Error('Invalid Watch Together publication result');
        const seq = Number(result[0]);
        if (timeout && bufferCheckTimeouts.get(upperCode) === timeout) {
            clearTimeout(timeout);
            bufferCheckTimeouts.delete(upperCode);
        }
        if (Number(result[1]) === 0 && !currentBufferTransition()?.lost) {
            const committed = JSON.parse(String(result[2])) as PubSubMessage;
            for (const [clientId, conn] of sseConnections.get(upperCode) ?? []) {
                if (excludeClientId && clientId === excludeClientId) continue;
                conn.callback(committed.event, seq);
            }
        }
        return;
    }

    // Append to replay ring so SSE reconnects can replay missed events via Last-Event-ID.
    // If replay storage fails, keep live delivery available without a cursor.
    const seq = await appendEventToReplay(upperCode, event, excludeClientId);
    if (seq === 0) {
        logger.warn('Broadcasting live without a replay cursor', {
            code: upperCode,
            type: event.type,
        });
    }

    // Create pub/sub message with echo filtering info
    const message: PubSubMessage = {
        event,
        seq: seq > 0 ? seq : undefined,
        excludeClientId,
    };

    // Publish to Valkey channel - all subscribers (including on other replicas) will receive it
    const published = await publishMessage(KEYS.PUBSUB_CHANNEL(upperCode), JSON.stringify(message));

    if (!published) {
        // Fallback to local broadcast if pub/sub fails
        const connections = sseConnections.get(upperCode);
        if (connections && connections.size > 0) {
            logger.debug('Pub/sub failed, falling back to local broadcast', {
                code: upperCode,
            });
            for (const [clientId, conn] of connections) {
                // Skip excluded client (echo prevention)
                if (excludeClientId && clientId === excludeClientId) {
                    continue;
                }
                try {
                    conn.callback(event, seq > 0 ? seq : undefined);
                } catch (error) {
                    logger.warn('Failed to send SSE event', { code: upperCode }, error as Error);
                }
            }
        }
    }
}

/**
 * Broadcast a seek event to all participants
 * @param isPlaying - Whether playback should resume after seek
 */
export async function broadcastSeek(
    code: string,
    userId: string,
    currentTime: number,
    clientId: string,
    isPlaying?: boolean,
    itemId?: string,
    expectedTimelineId?: string,
): Promise<boolean> {
    const preflight = await getSessionWithParticipant(code, userId, clientId);
    if (!preflight || !isHostClient(preflight.session, clientId, userId)) return false;
    return withBufferTransition(code, () =>
        broadcastSeekLocked(
            code,
            userId,
            currentTime,
            clientId,
            isPlaying,
            itemId,
            expectedTimelineId,
        ),
    );
}

async function broadcastSeekLocked(
    code: string,
    userId: string,
    currentTime: number,
    clientId: string,
    isPlaying?: boolean,
    itemId?: string,
    expectedTimelineId?: string,
): Promise<boolean> {
    try {
        const result = await getSessionWithParticipant(code, userId, clientId);
        if (!result) return false;

        const { session } = result;

        // Seeking is host-only. The client UI enforces this too, but guests'
        // programmatic seeks (sync-applied) must never move the whole party.
        if (!isHostClient(session, clientId, userId)) {
            logger.warn('Non-host tried to broadcast seek, ignoring', {
                code,
                userId,
                clientId: clientId?.substring(0, 12),
            });
            return false;
        }

        if (
            (itemId && session.itemId !== itemId) ||
            (expectedTimelineId && session.timelineId !== expectedTimelineId)
        )
            return true;

        const effectiveIsPlaying = isPlaying ?? session.isPlaying;
        await updateJoinResumeIntentIfPending(code, effectiveIsPlaying);

        // Update session time and playing state
        await connectValkey();
        if (isCoordinationValkeyReady()) {
            session.currentTime = currentTime;
            session.isPlaying = effectiveIsPlaying;
            session.lastSync = Date.now();
            await setTransitionValue(
                KEYS.SESSION(code.toUpperCase()),
                SESSION_TTL,
                JSON.stringify(session),
            );
            if (isPlaying !== undefined) await pinExplicitPlayState(code, effectiveIsPlaying);
        }

        // Initiate buffer check instead of just broadcasting seek
        // This pauses everyone, waits for buffers, then resumes in sync
        // Mark as seek-initiated so the target position is preserved (not overwritten by host position)
        if (
            !(await initiateBufferCheckLocked(code, currentTime, userId, true, effectiveIsPlaying))
        ) {
            return false;
        }

        logger.debug('Broadcast seek with buffer check', {
            code,
            userId,
            currentTime,
            isPlaying,
        });
        return true;
    } catch (error) {
        logger.error('Failed to broadcast seek', error as Error, { code });
        return false;
    }
}

/**
 * Broadcast navigation to a new item (next episode, different movie, etc.)
 */
export async function broadcastNavigate(
    code: string,
    userId: string,
    itemId: string,
    title: string,
    mediaType: WatchTogetherMediaType,
    clientId?: string,
    fileId?: string,
    timelineId?: string,
    expectedTimelineId?: string,
): Promise<boolean> {
    return !!(await broadcastNavigateCanonical(
        code,
        userId,
        itemId,
        title,
        mediaType,
        clientId,
        fileId,
        timelineId,
        expectedTimelineId,
    ));
}

async function broadcastNavigateCanonical(
    code: string,
    userId: string,
    itemId: string,
    title: string,
    mediaType: WatchTogetherMediaType,
    clientId?: string,
    fileId?: string,
    timelineId?: string,
    expectedTimelineId?: string,
): Promise<{ currentTime: number } | null> {
    const preflight = await getSessionWithParticipant(code, userId, clientId);
    if (!preflight || !isHostClient(preflight.session, clientId ?? '', userId)) return null;
    return (
        (await withBufferTransition(code, () =>
            broadcastNavigateLocked(
                code,
                userId,
                itemId,
                title,
                mediaType,
                clientId,
                fileId,
                timelineId,
                expectedTimelineId,
            ),
        )) || null
    );
}

async function broadcastNavigateLocked(
    code: string,
    userId: string,
    itemId: string,
    title: string,
    mediaType: WatchTogetherMediaType,
    clientId?: string,
    fileId?: string,
    timelineId?: string,
    expectedTimelineId?: string,
): Promise<{ currentTime: number } | null> {
    try {
        const result = await getSessionWithParticipant(code, userId, clientId);
        if (!result) return null;

        const { session, participant } = result;

        if (!isHostClient(session, clientId ?? '', userId)) return null;

        // Remember prior commands too: a delayed retry cannot reopen an older item.
        if (
            timelineId &&
            Number(
                await transitionCommand(
                    [`watch:v2:navigation-commands:${code.toUpperCase()}`],
                    [timelineId],
                    "return redis.call('HEXISTS', KEYS[1], ARGV[1])",
                ),
            ) === 1
        )
            return timelineId === session.timelineId &&
                session.itemId === itemId &&
                session.fileId === fileId
                ? { currentTime: session.currentTime }
                : null;

        if (expectedTimelineId && expectedTimelineId !== session.timelineId) return null;

        const entryPosition = await resolveWatchTogetherEntryPosition(itemId, mediaType, fileId);

        // A prior item's timeout/readiness must never resume the new item. The
        // shared transition lock also waits for a resume already being published.
        if (!(await cleanupBufferCheckState(code.toUpperCase()))) return null;
        await updateJoinResumeIntentIfPending(code, false);

        // Update the item and publish navigation within the same transition.
        await connectValkey();
        if (isCoordinationValkeyReady()) {
            session.itemId = itemId;
            session.timelineId = timelineId ?? crypto.randomUUID();
            session.title = title;
            session.mediaType = canonicalWatchTogetherMediaType(mediaType);
            session.fileId = fileId;
            session.currentTime = entryPosition;
            session.isPlaying = false;
            session.lastSync = Date.now();
            // A new item is a measurement boundary like a seek: samples taken on
            // the previous episode would otherwise be compared against the new
            // one (drift check here, and the Active Streams sync readout).
            await clearDriftMeasurements(code.toUpperCase());
        }

        // Broadcast navigate event to all EXCEPT sender (echo prevention)
        await broadcastToSession(
            code,
            {
                type: 'navigate',
                timelineId: session.timelineId,
                itemId,
                title,
                fileId,
                currentTime: session.currentTime,
                userId,
                displayName: participant.displayName,
                clientId,
            },
            clientId,
            session,
        ); // Exclude sender to prevent echo

        logger.info('Broadcast navigation', { code, userId, itemId, title });
        return { currentTime: session.currentTime };
    } catch (error) {
        if (isDependencyError(error)) throw new AuthDependencyUnavailableError(error);
        logger.error('Failed to broadcast navigation', error as Error, {
            code,
        });
        return null;
    }
}

/** Caller identity + navigation payload passed into {@link navigateParty}. */
export interface NavigatePartyActor {
    userId: string;
    clientId?: string;
    mediaType: WatchTogetherMediaType;
    fileId?: string;
    timelineId?: string;
    expectedTimelineId?: string;
}

export type NavigatePartyResult =
    | { ok: true; currentTime: number }
    | { ok: false; status: 'not_found'; message: string }
    | { ok: false; status: 'forbidden'; message: string };

/**
 * Shared navigate authorization + broadcast (security review 2026-09-12, C11).
 *
 * Used by BOTH the REST `POST /watch-together/{code}/navigate` route and the
 * `navigate` arm of the unified `/events` dispatcher, so the two surfaces
 * cannot drift again. Performs the checks a navigate must pass before the
 * whole party gets redirected:
 *   1. Host-only gate — 'navigate' is listed in WATCH_TOGETHER_HOST_ONLY_EVENTS,
 *      so any non-host participant is refused here (the REST route used to
 *      skip this and let any participant redirect the whole party).
 *   2. participantsBlockedBy — refuses when navigating would push a title onto
 *      a participant who cannot access it, not just the navigator.
 *   3. Membership + broadcast, delegated to broadcastNavigate (which re-checks
 *      the caller is still a participant via getSessionWithParticipant).
 */
export async function navigateParty(
    code: string,
    itemId: string,
    title: string,
    actor: NavigatePartyActor,
): Promise<NavigatePartyResult> {
    const session = await getSession(code);
    if (!session) return { ok: false, status: 'not_found', message: 'Session not found' };

    if ((WATCH_TOGETHER_HOST_ONLY_EVENTS as readonly string[]).includes('navigate')) {
        if (!isHostClient(session, actor.clientId ?? '', actor.userId)) {
            return {
                ok: false,
                status: 'forbidden',
                message: "Event type 'navigate' is host-only",
            };
        }
    }

    const blocked = await participantsBlockedBy(code, itemId, actor.userId);
    if (blocked.length > 0) {
        logger.warn('navigate refused — participants lack access to the target item', {
            code,
            itemId,
            blockedCount: blocked.length,
        });
        return {
            ok: false,
            status: 'forbidden',
            message:
                `${blocked.length} participant(s) cannot access this title. ` +
                'Remove them from the party first, or pick something everyone can watch.',
        };
    }

    const navigation = await broadcastNavigateCanonical(
        code,
        actor.userId,
        itemId,
        title,
        actor.mediaType,
        actor.clientId,
        actor.fileId,
        actor.timelineId,
        actor.expectedTimelineId,
    );
    if (!navigation) {
        return {
            ok: false,
            status: 'forbidden',
            message: 'Not a participant or session not found',
        };
    }

    return { ok: true, currentTime: navigation.currentTime };
}

/**
 * Broadcast a version/media source change to all participants
 */
export async function broadcastVersionChange(
    code: string,
    userId: string,
    fileId: string,
    clientId?: string,
): Promise<boolean> {
    return withBufferTransition(code, () =>
        broadcastVersionChangeLocked(code, userId, fileId, clientId),
    );
}

async function broadcastVersionChangeLocked(
    code: string,
    userId: string,
    fileId: string,
    clientId?: string,
): Promise<boolean> {
    try {
        const result = await getSessionWithParticipant(code, userId, clientId);
        if (!result) return false;

        const { session, participant } = result;
        if (!isHostClient(session, clientId ?? '', userId)) return false;

        // Validate fileId belongs to the session's current item (defense-in-depth)
        if (session.itemId) {
            const sql = getDb();
            if (sql) {
                const files = await getFilesForMediaItem(sql, session.itemId);
                if (!files.some((f) => f.id === fileId)) {
                    logger.warn(
                        'Version change fileId does not belong to session item, rejecting',
                        {
                            code,
                            fileId,
                            itemId: session.itemId,
                        },
                    );
                    return false;
                }
            } else {
                logger.warn('Cannot validate version fileId — database unavailable, rejecting', {
                    code,
                    fileId,
                });
                return false;
            }
        }

        // Update session with new file
        await connectValkey();
        if (isCoordinationValkeyReady()) {
            session.fileId = fileId;
            session.lastSync = Date.now();
            await setTransitionValue(
                KEYS.SESSION(code.toUpperCase()),
                SESSION_TTL,
                JSON.stringify(session),
            );
        }

        // Broadcast version change event to all EXCEPT sender (echo prevention)
        await broadcastToSession(
            code,
            {
                type: 'version_change',
                fileId,
                userId,
                displayName: participant.displayName,
                clientId,
            },
            clientId,
        ); // Exclude sender to prevent echo

        logger.info('Broadcast version change', {
            code,
            userId,
            fileId,
        });
        return true;
    } catch (error) {
        logger.error('Failed to broadcast version change', error as Error, {
            code,
        });
        return false;
    }
}

/**
 * Broadcast an emoji reaction to all participants
 */
export async function broadcastReaction(
    code: string,
    userId: string,
    emoji: ReactionEmoji,
): Promise<boolean> {
    try {
        const result = await getSessionWithParticipant(code, userId);
        if (!result) return false;

        const { participant } = result;

        // Broadcast reaction event (no need to store in Redis - just broadcast)
        await broadcastToSession(code, {
            type: 'reaction',
            emoji,
            userId,
            displayName: participant.displayName,
        });

        logger.debug('Broadcast reaction', { code, userId, emoji });
        return true;
    } catch (error) {
        logger.error('Failed to broadcast reaction', error as Error, { code });
        return false;
    }
}

/**
 * Broadcast a screen effect to all participants
 * Screen effects affect the video player (shake, confetti, etc.)
 */
export async function broadcastScreenEffect(
    code: string,
    userId: string,
    effect: ScreenEffect,
): Promise<boolean> {
    try {
        const result = await getSessionWithParticipant(code, userId);
        if (!result) return false;

        const { participant } = result;

        // Broadcast screen effect event
        await broadcastToSession(code, {
            type: 'screen_effect',
            effect,
            userId,
            displayName: participant.displayName,
        });

        logger.debug('Broadcast screen effect', { code, userId, effect });
        return true;
    } catch (error) {
        logger.error('Failed to broadcast screen effect', error as Error, {
            code,
        });
        return false;
    }
}

/**
 * Broadcast host activity status to all participants
 * (e.g., searching for new content, browsing homepage)
 */
export async function broadcastHostActivity(
    code: string,
    userId: string,
    activity: 'watching' | 'searching' | 'browsing',
    message?: string,
): Promise<boolean> {
    try {
        const session = await getSession(code);
        if (!session) return false;

        // Only the host can broadcast their activity
        if (session.hostUserId !== userId) return false;

        await broadcastToSession(code, {
            type: 'host_activity',
            activity,
            message,
        });

        logger.debug('Broadcast host activity', { code, activity, message });
        return true;
    } catch (error) {
        logger.error('Failed to broadcast host activity', error as Error, {
            code,
        });
        return false;
    }
}

// Sessions are considered stale if no sync in 5 minutes
const STALE_SESSION_THRESHOLD = 5 * 60 * 1000;

/**
 * End every party whose host is gone: no live stream connection and not seen
 * (heartbeat, stream close, host change) for `absentMs`. Guests are told via
 * `session_ended`. Without this a party whose host crashed or lost its network
 * lived on while guests waited for a host that never came back; the lazy reap in
 * getAllSessions only ends a party once NO participant is connected.
 *
 * A party with no host sighting recorded yet (created before this existed, or the
 * key expired) starts its clock at the first sweep instead of ending at once.
 * Called by one replica per window (watch-together-host-sweeper.ts).
 */
/**
 * When the host was last seen: 'connected' while its stream marker is fresh, else the
 * latest of the (stale) marker and the recorded sighting, or null if neither exists.
 */
async function hostLastSeen(
    session: StoredSession,
    now: number,
): Promise<number | 'connected' | null> {
    const markerRaw = session.hostClientId
        ? await hGet(KEYS.CONNECTIONS(session.code), session.hostClientId)
        : null;
    const marker = markerRaw ? Number(markerRaw) : NaN;
    if (Number.isFinite(marker) && now - marker <= CONNECTION_STALE_MS) return 'connected';
    const seenRaw = await cacheGet(KEYS.HOST_SEEN(session.code));
    const seen = seenRaw ? Number(seenRaw) : NaN;
    const lastSeen = Math.max(
        Number.isFinite(seen) ? seen : -Infinity,
        Number.isFinite(marker) ? marker : -Infinity,
    );
    return Number.isFinite(lastSeen) ? lastSeen : null;
}

/** Remove only clients with positive, stale liveness evidence. */
export async function sweepStaleGuests(now: number = Date.now()): Promise<string[]> {
    const removed: string[] = [];
    try {
        await connectValkey();
        if (!isCoordinationValkeyReady()) return removed;
        const keys = await getKeysByPattern('watch:v2:session:*', Number.MAX_SAFE_INTEGER);
        for (const key of keys) {
            const raw = await cacheGet(key);
            if (!raw) continue;
            let session: StoredSession;
            try {
                session = parseStoredSession(raw);
            } catch {
                continue;
            }
            const markers = await hGetAll(KEYS.CONNECTIONS(session.code));
            for (const participant of session.participants) {
                if (
                    !participant.clientId ||
                    participant.clientId === session.hostClientId ||
                    (!session.hostClientId && participant.userId === session.hostUserId) ||
                    now - participant.joinedAt < PARTICIPANT_GRACE_MS
                )
                    continue;
                const marker = markers[participant.clientId];
                if (
                    !marker ||
                    !Number.isFinite(Number(marker)) ||
                    now - Number(marker) <= CONNECTION_STALE_MS
                )
                    continue;
                if (
                    await leaveSession(session.code, participant.userId, participant.clientId, {
                        joinedAt: participant.joinedAt,
                        marker,
                        now,
                    })
                )
                    removed.push(participant.clientId);
            }
        }
    } catch (error) {
        logger.warn('Stale guest sweep skipped', {}, error as Error);
    }
    return removed;
}

export async function sweepAbsentHosts(
    absentMs: number,
    now: number = Date.now(),
): Promise<string[]> {
    const ended: string[] = [];
    const startedAt = Date.now();
    // The sweep's clock (`now` may be injected), advanced by real time spent sweeping.
    const clock = () => now + (Date.now() - startedAt);
    try {
        await connectValkey();
        if (!isCoordinationValkeyReady()) return ended;
        const keys = await getKeysByPattern('watch:v2:session:*', 500);
        for (const key of keys) {
            const data = await cacheGet(key);
            if (!data) continue;
            let session: StoredSession;
            try {
                session = parseStoredSession(data);
            } catch {
                continue;
            }
            const code = session.code;
            const lastSeen = await hostLastSeen(session, now);
            if (lastSeen === 'connected') continue;
            if (lastSeen === null) {
                await markHostSeen(code, now);
                continue;
            }
            if (now - lastSeen < absentMs) continue;

            // Re-check right before ending: the host may have reconnected, sent a
            // heartbeat or been replaced (promotion/transfer) since the first read.
            const current = await getSession(code);
            if (!current || current.hostClientId !== session.hostClientId) continue;
            const recheckAt = clock();
            const recheck = await hostLastSeen(current, recheckAt);
            if (recheck === 'connected' || recheck === null || recheckAt - recheck < absentMs) {
                continue;
            }

            logger.info('Ending watch party: host gone', {
                code,
                hostClientId: session.hostClientId?.substring(0, 12),
                absentMinutes: Math.floor((now - lastSeen) / 60000),
            });
            if (await endSessionAsSystem(code)) ended.push(code);
        }
    } catch (error) {
        logger.error('Absent-host sweep failed', error as Error);
    }
    return ended;
}

/**
 * Get all active watch sessions (filters out stale sessions)
 * @param publicOnly - If true, only returns sessions where visibility is listed (default: true)
 */
export async function getAllSessions(publicOnly: boolean = true): Promise<StoredSession[]> {
    try {
        await connectValkey();
        if (!isCoordinationValkeyReady()) return [];

        // Use SCAN instead of KEYS to avoid blocking Redis
        const keys = await getKeysByPattern('watch:v2:session:*', 500);
        if (keys.length === 0) return [];

        const sessions: StoredSession[] = [];
        const staleSessions: string[] = [];
        const now = Date.now();

        for (const key of keys) {
            const data = await cacheGet(key);
            if (data) {
                try {
                    const session = parseStoredSession(data);

                    // Check if session is stale (no activity in 5 minutes).
                    // lastSync only advances on playback events (sync/seek/
                    // position/heartbeat) — a *paused* party emits none of those,
                    // so lastSync goes quiet even while viewers stay connected and
                    // their SSE keepalives keep the CONNECTIONS liveness marker
                    // fresh. Reaping purely on lastSync therefore tears down live,
                    // merely-paused parties. Only reap when no live SSE connection
                    // remains; getLiveConnectionCount returns null when the signal
                    // is unavailable/empty (truly abandoned), which reaps as before.
                    const timeSinceLastSync = now - session.lastSync;
                    if (timeSinceLastSync > STALE_SESSION_THRESHOLD) {
                        const liveConnections = await getLiveConnectionCount(session.code);
                        if (liveConnections && liveConnections > 0) {
                            // Still connected — paused, not abandoned. Surface it
                            // like any other active session.
                            const visibility = session.visibility ?? 'unlisted';
                            if (!publicOnly || visibility === 'listed') {
                                sessions.push(session);
                            }
                        } else {
                            staleSessions.push(session.code);
                            logger.info('Found stale session', {
                                code: session.code,
                                lastSync: new Date(session.lastSync).toISOString(),
                                staleMinutes: Math.floor(timeSinceLastSync / 60000),
                            });
                        }
                    } else {
                        // Filter by visibility if publicOnly is true
                        // Missing visibility is unlisted.
                        const visibility = session.visibility ?? 'unlisted';
                        if (!publicOnly || visibility === 'listed') {
                            sessions.push(session);
                        }
                    }
                } catch {
                    // Skip invalid entries
                }
            }
        }

        // Clean up stale sessions in background
        if (staleSessions.length > 0) {
            cleanupStaleSessions(staleSessions).catch((err) => {
                logger.warn('Failed to cleanup stale sessions', err as Error);
            });
        }

        // Sort by creation time (newest first)
        sessions.sort((a, b) => b.createdAt - a.createdAt);
        return sessions;
    } catch (error) {
        logger.error('Failed to get all sessions', error as Error);
        return [];
    }
}

/**
 * How long one party snapshot is shared across viewers. The Active Streams
 * view is memoised PER VIEWER (2s), so without this every viewer's poll would
 * SCAN `watch:v2:session:*` and read every party's positions on its own.
 */
const PARTY_SNAPSHOT_TTL_MS = 1500;
let partySnapshotMemo: { at: number; value: Promise<PartyStreamSnapshot[]> } | null = null;

/**
 * Every live party (public AND private) with the sync signals the Active
 * Streams overlay needs — see watch-party-stream-overlay.ts, which decides
 * per viewer what of this may be shown. Fail-soft: [] when Valkey is down.
 * Shared per replica for {@link PARTY_SNAPSHOT_TTL_MS}; concurrent callers
 * await the same in-flight read.
 */
export function getPartyStreamSnapshots(): Promise<PartyStreamSnapshot[]> {
    const now = Date.now();
    if (partySnapshotMemo && now - partySnapshotMemo.at < PARTY_SNAPSHOT_TTL_MS) {
        return partySnapshotMemo.value;
    }
    const value = readPartyStreamSnapshots().catch((error: unknown) => {
        logger.warn('Failed to read party snapshots', error as Error);
        return [];
    });
    partySnapshotMemo = { at: now, value };
    return value;
}

async function readPartyStreamSnapshots(): Promise<PartyStreamSnapshot[]> {
    const sessions = await getAllSessions(false);
    if (sessions.length === 0) return [];
    const now = Date.now();
    const parties = await toPublicParties(sessions, 'internal');

    return Promise.all(
        sessions.map(async (session, index): Promise<PartyStreamSnapshot> => {
            const code = session.code.toUpperCase();
            const [positions, stalledRaw, bufferCheck] = await Promise.all([
                getClientPositions(code),
                hGetAll(KEYS.STALLED(code)).catch((): Record<string, string> => ({})),
                getBufferCheckState(code).catch(() => null),
            ]);
            // Same parse as hasActiveStalls, read-only (no pruning from a view).
            const stalledClientIds = new Set<string>();
            for (const [cid, raw] of Object.entries(stalledRaw)) {
                let t = Number(raw);
                if (!Number.isFinite(t)) {
                    try {
                        t = Number((JSON.parse(raw) as { startedAt?: number }).startedAt);
                    } catch {
                        t = Number.NaN;
                    }
                }
                if (Number.isFinite(t) && now - t <= STALL_ACTIVE_MS) stalledClientIds.add(cid);
            }
            return {
                code,
                visibility: session.visibility ?? 'unlisted',
                itemId: session.itemId,
                host: parties[index].host,
                hostClientId: session.hostClientId,
                isPlaying: session.isPlaying,
                playbackRate: session.playbackRate,
                participants: session.participants.map((p) => ({
                    userId: p.userId,
                    displayName: p.displayName,
                    clientId: p.clientId,
                })),
                positions,
                stalledClientIds,
                bufferCheckPending: bufferCheck !== null,
            };
        }),
    );
}

/**
 * Clean up stale sessions
 */
async function cleanupStaleSessions(codes: string[]): Promise<void> {
    for (const code of codes) {
        await endSessionAsSystem(code);
    }
    logger.info('Cleaned up stale sessions', { count: codes.length });
}

/**
 * Get active session count (for monitoring)
 */
export async function getActiveSessionCount(): Promise<number> {
    try {
        await connectValkey();
        if (!isCoordinationValkeyReady()) return 0;

        // Use SCAN instead of KEYS to avoid blocking Redis
        const keys = await getKeysByPattern('watch:v2:session:*', 1000);
        return keys.length;
    } catch (error) {
        logger.error('Failed to get session count', error as Error);
        return 0;
    }
}

/**
 * Initiate a buffer check - pauses everyone and waits for ready signals
 * Used before synchronized resume after seek or join
 * Uses distributed state in Valkey for multi-replica support
 * @param seekInitiated - If true, the buffer check was triggered by a user seek and the target position should be preserved
 * @param isPlaying - Whether playback should resume after buffer check (default: true)
 */
async function initiateJoinBufferCheck(
    code: string,
    timelineId: string | undefined,
    fallback?: boolean,
): Promise<boolean> {
    return withBufferTransition(code, async () => {
        const fresh = await getSession(code);
        if (!fresh || fresh.timelineId !== timelineId) return false;
        const joinIntent = await consumeJoinResumeIntent(
            code.toUpperCase(),
            fallback ?? fresh.isPlaying,
        );
        const intended = (await pinnedPlayState(code.toUpperCase())) ?? joinIntent;
        return initiateBufferCheckLocked(code, fresh.currentTime, 'system', false, intended, true);
    });
}

async function initiateBufferCheckLocked(
    code: string,
    currentTime: number,
    initiator: string,
    seekInitiated: boolean = false,
    isPlaying: boolean = true,
    onlyIfIdle: boolean = false,
): Promise<boolean> {
    try {
        const session = await getSession(code);
        if (!session) return false;

        const upperCode = code.toUpperCase();
        const participantCount = session.participants.length;

        // Expect ready-signals only from clients that actually hold a live SSE
        // connection. Participants whose tab closed/backgrounded without an
        // explicit leave would otherwise inflate expectedCount and force every
        // buffer check into the full 5s timeout (group frozen, then "resumes
        // by itself"). Cap by participants and floor at 1.
        const markers = await hGetAll(KEYS.CONNECTIONS(upperCode));
        const now = Date.now();
        const liveClientIds = session.participants.flatMap((p) => {
            const raw = p.clientId ? markers[p.clientId] : undefined;
            return p.clientId &&
                raw &&
                Number.isFinite(Number(raw)) &&
                now - Number(raw) <= CONNECTION_STALE_MS
                ? [p.clientId]
                : [];
        });
        // Empty/error evidence remains fail-open. Keep the client identities
        // used to size this barrier so leaving an already-excluded stale client
        // cannot decrement expectations for somebody who is still connected.
        const expectedClientIds =
            liveClientIds.length > 0
                ? liveClientIds
                : session.participants.every((p) => !!p.clientId)
                  ? session.participants.flatMap((p) => (p.clientId ? [p.clientId] : []))
                  : undefined;
        const expectedCount = Math.max(1, expectedClientIds?.length ?? participantCount);

        // Store buffer check state in Valkey (distributed)
        const state: BufferCheckState = {
            checkId: crypto.randomUUID(),
            currentTime,
            expectedCount,
            expectedClientIds,
            seekInitiated,
            startTime: Date.now(),
            isPlaying,
        };
        if (onlyIfIdle) {
            const claimed = await transitionCommand(
                [KEYS.BUFFER_CHECK(upperCode)],
                [JSON.stringify(state), String(EPHEMERAL_STATE_TTL)],
                "return redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2], 'NX') and 1 or 0",
            );
            if (Number(claimed) !== 1) return false;
        } else {
            if (!(await cleanupBufferCheckState(upperCode))) return false;
            if (!(await setBufferCheckState(upperCode, state))) return false;
        }

        // Set local timeout - if not all ready in 5s, resume anyway
        // Note: In multi-replica setup, each replica that initiates sets its own timeout
        const priorTimeout = bufferCheckTimeouts.get(upperCode);
        if (priorTimeout) clearTimeout(priorTimeout);
        const timeout = bufferTransitionScope.exit(() =>
            setTimeout(() => {
                void (async () => {
                    logger.info('Buffer check timeout, resuming anyway', {
                        code: upperCode,
                    });
                    const pending = await getBufferCheckState(upperCode);
                    if (pending?.checkId !== state.checkId) return;
                    await triggerSynchronizedResume(
                        upperCode,
                        pending?.currentTime ?? currentTime,
                        pending.isPlaying,
                        state.checkId,
                    );
                })();
            }, BUFFER_CHECK_TIMEOUT),
        );
        bufferCheckTimeouts.set(upperCode, timeout);

        // Broadcast buffer check to all clients
        await broadcastToSession(code, {
            type: 'buffer_check',
            timelineId: session.timelineId,
            checkId: state.checkId,
            currentTime,
            initiator,
            isPlaying,
            seekInitiated,
        });

        logger.debug('Initiated buffer check', {
            code: upperCode,
            participantCount,
            expectedCount,
            currentTime,
            seekInitiated,
            isPlaying,
        });
        return true;
    } catch (error) {
        logger.error('Failed to initiate buffer check', error as Error, {
            code,
        });
        return false;
    }
}

/**
 * Serialize state replacement and broadcast as one initiation transaction.
 * Join/rejoin and explicit checks wait briefly for an in-flight initiation;
 * join/rejoin still refuse to replace a barrier once its state exists.
 */
export async function initiateBufferCheck(
    code: string,
    currentTime: number,
    initiator: string,
    seekInitiated: boolean = false,
    isPlaying: boolean = true,
    onlyIfIdle: boolean = false,
): Promise<boolean> {
    return withBufferTransition(code, () =>
        initiateBufferCheckLocked(
            code.toUpperCase(),
            currentTime,
            initiator,
            seekInitiated,
            isPlaying,
            onlyIfIdle,
        ),
    );
}

interface BufferTransitionLease {
    code: string;
    owner: string;
    active: boolean;
    lost: boolean;
}

const bufferTransitionScope = new AsyncLocalStorage<BufferTransitionLease>();

function currentBufferTransition(): BufferTransitionLease | undefined {
    const lease = bufferTransitionScope.getStore();
    return lease?.active ? lease : undefined;
}

/** Fence each mutation in the same Redis command that verifies lease ownership. */
type CoordinationCommandResult = Awaited<
    ReturnType<NonNullable<ReturnType<typeof getCoordinationClient>>['customCommand']>
>;

async function transitionCommand(
    keys: string[],
    args: string[],
    lua: string,
): Promise<CoordinationCommandResult> {
    const lease = currentBufferTransition();
    const client = getCoordinationClient();
    if (!client) {
        if (lease) lease.lost = true;
        throw new AuthDependencyUnavailableError(
            new Error('Watch Together coordination unavailable'),
        );
    }
    if (!lease) return client.customCommand(['EVAL', lua, String(keys.length), ...keys, ...args]);
    if (lease.lost) throw new Error('Watch Together transition lease lost');
    const shifted = lua.replace(
        /\b(KEYS|ARGV)\[(\d+)\]/g,
        (_match, kind: string, index: string) => `${kind}[${Number(index) + 1}]`,
    );
    try {
        return await client.customCommand([
            'EVAL',
            `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return redis.error_reply('STALE_PARTY_TRANSITION') end\n${shifted}`,
            String(keys.length + 1),
            KEYS.BUFFER_INIT_LOCK(lease.code),
            ...keys,
            lease.owner,
            ...args,
        ]);
    } catch (error) {
        lease.lost = true;
        throw new AuthDependencyUnavailableError(error);
    }
}

async function setTransitionValue(key: string, ttl: number, value: string): Promise<void> {
    if (!currentBufferTransition()) {
        await setEx(key, ttl, value);
        return;
    }
    await transitionCommand(
        [key],
        [String(ttl), value],
        "redis.call('SETEX', KEYS[1], ARGV[1], ARGV[2]); return 1",
    );
}

/** Serialize barrier replacement, completion and item changes across replicas. */
async function withBufferTransition<T>(
    code: string,
    operation: () => Promise<T>,
): Promise<T | false> {
    const upperCode = code.toUpperCase();
    const existing = bufferTransitionScope.getStore();
    if (existing?.active && existing.code === upperCode) {
        if (existing.lost)
            throw new AuthDependencyUnavailableError(
                new Error('Watch Together transition lease lost'),
            );
        return operation();
    }
    await connectValkey();
    if (!isCoordinationValkeyReady()) return false;
    const owner = crypto.randomUUID();
    const attempts = 500;
    let acquired = false;
    for (let attempt = 0; attempt < attempts; attempt++) {
        acquired = await setIfNotExists(KEYS.BUFFER_INIT_LOCK(upperCode), owner, 15);
        if (acquired) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!acquired)
        throw new AuthDependencyUnavailableError(new Error('Watch Together transition busy'));

    const lease: BufferTransitionLease = { code: upperCode, owner, active: true, lost: false };
    let renewing = false;
    const renew = setInterval(() => {
        if (renewing || !lease.active) return;
        renewing = true;
        void (async () => {
            try {
                const client = getCoordinationClient();
                if (!client) {
                    lease.lost = true;
                    return;
                }
                const renewed = await client.customCommand([
                    'EVAL',
                    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], 15) else return 0 end",
                    '1',
                    KEYS.BUFFER_INIT_LOCK(upperCode),
                    owner,
                ]);
                if (Number(renewed) !== 1) lease.lost = true;
            } catch {
                lease.lost = true;
            } finally {
                renewing = false;
            }
        })();
    }, 2000);
    renew.unref?.();
    try {
        const result = await bufferTransitionScope.run(lease, operation);
        if (lease.lost)
            throw new AuthDependencyUnavailableError(
                new Error('Watch Together transition lease lost'),
            );
        return result;
    } catch (error) {
        logger.warn('Watch Together transition failed', { code: upperCode }, error as Error);
        if (isDependencyError(error)) throw error;
        return false;
    } finally {
        lease.active = false;
        clearInterval(renew);
        try {
            const client = getCoordinationClient();
            if (client) {
                const lua = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;
                await client.customCommand([
                    'EVAL',
                    lua,
                    '1',
                    KEYS.BUFFER_INIT_LOCK(upperCode),
                    owner,
                ]);
            }
        } catch (error) {
            logger.warn(
                'Failed to release buffer initiation lock',
                { code: upperCode },
                error as Error,
            );
        }
    }
}

/**
 * Signal that a client is ready (buffer loaded at position)
 * Uses distributed state in Valkey for multi-replica support
 * @param hostCurrentTime - If this is the host, their actual current playback position
 */
export async function signalReady(
    code: string,
    clientId: string,
    checkId: string,
    hostCurrentTime?: number,
): Promise<void> {
    const upperCode = code.toUpperCase();
    const pending = await getBufferCheckState(upperCode);

    if (!pending || pending.checkId !== checkId) {
        // No pending buffer check, ignore
        return;
    }

    if (pending.expectedClientIds && !pending.expectedClientIds.includes(clientId)) return;

    // If host provides their current position, update the target time
    // BUT only if this was NOT a seek-initiated buffer check (user seek should preserve target)
    // This ensures we use the host's actual position for drift/join syncs, but respect seek targets
    if (hostCurrentTime !== undefined && hostCurrentTime >= 0 && !pending.seekInitiated) {
        if (await updateBufferCheckTime(upperCode, pending.checkId, hostCurrentTime)) {
            pending.currentTime = hostCurrentTime;
        }
        logger.debug('Updated buffer check position from host', {
            code: upperCode,
            hostCurrentTime,
        });
    } else if (pending.seekInitiated && hostCurrentTime !== undefined) {
        logger.debug('Preserving seek target position (ignoring host position)', {
            code: upperCode,
            seekTarget: pending.currentTime,
            hostPosition: hostCurrentTime,
        });
    }

    // Add to ready set (distributed in Valkey)
    const readiness = await addReadyClient(upperCode, pending.checkId, clientId);
    if (!readiness) return;
    const { readyCount, expectedCount } = readiness;

    logger.debug('Client signaled ready', {
        code: upperCode,
        clientId,
        readyCount,
        expected: pending.expectedCount,
    });

    // Check if all ready
    if (readyCount >= expectedCount) {
        await triggerSynchronizedResume(
            upperCode,
            pending.currentTime,
            pending.isPlaying,
            pending.checkId,
        );
    }
}

/**
 * Trigger synchronized resume - all clients play at the same server time
 * Uses atomic delete to ensure only one replica triggers the broadcast.
 * @param isPlaying - Whether playback should resume (true) or stay paused (false)
 */
async function triggerSynchronizedResume(
    code: string,
    currentTime: number,
    isPlaying: boolean = true,
    expectedCheckId?: string,
): Promise<void> {
    const checkId = expectedCheckId ?? (await getBufferCheckState(code))?.checkId;
    if (!checkId) return;
    // Completion can wait behind a slow transition longer than the normal
    // ten-second crash TTL. Retain only this generation while a live worker
    // is completing it; cancellation/replacement must never be resurrected.
    let retaining = false;
    const retain = async () => {
        if (retaining) return;
        retaining = true;
        try {
            const client = getCoordinationClient();
            if (!client) return;
            await client.customCommand([
                'EVAL',
                `local raw = redis.call('GET', KEYS[1])
                 if not raw or cjson.decode(raw).checkId ~= ARGV[1] then return 0 end
                 return redis.call('EXPIRE', KEYS[1], ARGV[2])`,
                '1',
                KEYS.BUFFER_CHECK(code.toUpperCase()),
                checkId,
                String(EPHEMERAL_STATE_TTL),
            ]);
        } catch (error) {
            logger.warn('Failed to retain pending synchronization', { code }, error as Error);
        } finally {
            retaining = false;
        }
    };
    await retain();
    const retention = setInterval(() => {
        void retain();
    }, 2000);
    retention.unref?.();
    try {
        while (true) {
            try {
                const completed = await withBufferTransition(code, async () => {
                    await triggerSynchronizedResumeLocked(code, currentTime, isPlaying, checkId);
                    return true;
                });
                if (completed) return;
            } catch (error) {
                if (!isDependencyError(error) || currentBufferTransition()?.lost) throw error;
            }
            if ((await getBufferCheckState(code))?.checkId !== checkId) return;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    } finally {
        clearInterval(retention);
    }
}

async function triggerSynchronizedResumeLocked(
    code: string,
    currentTime: number,
    isPlaying: boolean = true,
    expectedCheckId?: string,
): Promise<void> {
    const upperCode = code.toUpperCase();

    // Atomically claim the right to trigger by cleaning up buffer check state
    // Only one replica will get wasActive=true, preventing duplicate broadcasts
    const current = await getBufferCheckState(upperCode);
    if (!current) return;
    const checkId = expectedCheckId ?? current.checkId;
    if (!checkId) return;
    // Prefer the freshly re-read pending play state over the value captured when
    // the caller decided to resume: a play/pause that landed during the barrier
    // updated BufferCheckState.isPlaying (updateBufferCheckIsPlaying) and is more
    // current, so we don't conclude a barrier paused right after a mid-barrier play.
    const effectiveIsPlaying = current.checkId === checkId ? current.isPlaying : isPlaying;
    // Same for the position. A non-host's signalReady reads the barrier state before
    // the host's call replaces the stale heartbeat position with the host's real one
    // (updateBufferCheckTime); when both then count all-ready, the non-host's call can
    // win the claim below with its stale snapshot — everyone resumed ~1 s behind the
    // host, inside the drift compensator's tolerance, for good (web e2e, rejoin).
    const effectiveTime = current.checkId === checkId ? current.currentTime : currentTime;
    // Positions reported BEFORE this resync are now meaningless (clients are
    // about to seek to the new target). Clearing them + arming the cooldown
    // prevents an immediate false drift-resync right after every seek/join
    // resume, which previously caused a pause/black-screen loop.
    try {
        await clearDriftMeasurements(upperCode);
    } catch {
        // non-fatal
    }
    await setDriftCooldown(upperCode);

    // The pending-generation claim, resolved session state and event are committed
    // by one fenced Redis operation in broadcastToSession below.

    // Timestamp immediately before publishing. Cache/session work above must
    // not consume the clients' scheduling lead time.
    const serverTime = Date.now();
    const resumeAt = serverTime + 1500;
    await broadcastToSession(code, {
        type: 'all_ready',
        checkId,
        currentTime: effectiveTime,
        resumeAt,
        isPlaying: effectiveIsPlaying,
        serverTime,
    });

    logger.debug('Triggered synchronized resume', {
        code: upperCode,
        currentTime: effectiveTime,
        resumeAt,
        isPlaying: effectiveIsPlaying,
    });
}

/**
 * Check whether any client still has an active (non-abandoned) stall entry.
 * Opportunistically prunes abandoned entries.
 */
async function hasActiveStalls(code: string): Promise<boolean> {
    try {
        await connectValkey();
        if (!isCoordinationValkeyReady()) return false;

        const key = KEYS.STALLED(code);
        const data = await hGetAll(key);
        const now = Date.now();
        const abandoned: string[] = [];
        let active = false;
        for (const [cid, raw] of Object.entries(data)) {
            let t = Number(raw);
            if (!Number.isFinite(t)) {
                try {
                    t = Number((JSON.parse(raw) as { startedAt?: number }).startedAt);
                } catch {
                    t = Number.NaN;
                }
            }
            if (Number.isFinite(t) && now - t <= STALL_ACTIVE_MS) {
                active = true;
            } else {
                abandoned.push(cid);
            }
        }
        if (abandoned.length > 0) {
            await hDel(key, abandoned);
        }
        return active;
    } catch (error) {
        logger.warn('Failed to check active stalls', { code }, error as Error);
        return false;
    }
}

/**
 * Arm (or re-arm) the per-session stall failsafe. When it fires, abandoned
 * stall entries are pruned; if a client is still LEGITIMATELY stalled the
 * timer re-arms instead of resuming — so a later stall can't indefinitely
 * postpone the abandonment check of an earlier client that died mid-stall.
 */
function armStallFailsafe(code: string, timelineId?: string): void {
    const existing = stallFailsafeTimeouts.get(code);
    if (existing) clearTimeout(existing);
    stallFailsafeTimeouts.set(
        code,
        setTimeout(() => {
            stallFailsafeTimeouts.delete(code);
            void (async () => {
                await withStallLock(code, undefined, async () => {
                    const session = await getSession(code);
                    if (!session || session.timelineId !== timelineId) return;
                    if (await hasActiveStalls(code)) {
                        armStallFailsafe(code, timelineId);
                        return;
                    }
                    await broadcastToSession(code, { type: 'resume' });
                });
            })().catch((err) => {
                logger.warn('Stall failsafe resume failed', { code }, err as Error);
            });
        }, STALL_ACTIVE_MS + 1000),
    );
}

/**
 * Broadcast a group resume if no client is still stalled.
 */
async function resumeIfNoActiveStalls(code: string): Promise<void> {
    const upperCode = code.toUpperCase();
    if (await hasActiveStalls(upperCode)) return;

    const timer = stallFailsafeTimeouts.get(upperCode);
    if (timer) {
        clearTimeout(timer);
        stallFailsafeTimeouts.delete(upperCode);
    }
    await broadcastToSession(upperCode, { type: 'resume' });
}

/**
 * Report that a client is stalled (buffering). Records the stall in Valkey so
 * the group only resumes once EVERY stalled client recovered, and broadcasts
 * the stall (with replay support) so late/reconnecting clients see it too.
 */
export async function reportClientStall(
    code: string,
    userId: string,
    clientId: string,
    stallId: string,
    expectedTimelineId?: string,
): Promise<boolean> {
    const upperCode = code.toUpperCase();
    return withStallLock(upperCode, false, async () => {
        const liveResult = await getSessionWithParticipant(upperCode, userId, clientId);
        if (!liveResult) return false;
        if (
            expectedTimelineId !== undefined &&
            liveResult.session.timelineId !== expectedTimelineId
        )
            return true;
        try {
            await connectValkey();
            if (!isCoordinationValkeyReady()) return false;
            // A ready request can overtake a slow stall POST. Its tombstone
            // makes the generation idempotent in either arrival order.
            if (await cacheExists(KEYS.STALL_RECOVERED(upperCode, clientId, stallId))) return true;
            const key = KEYS.STALLED(upperCode);
            await hSet(
                key,
                clientId,
                JSON.stringify({
                    startedAt: Date.now(),
                    stallId,
                    timelineId: liveResult.session.timelineId,
                }),
            );
            await expire(key, Math.ceil((STALL_ACTIVE_MS * 2) / 1000));
        } catch (error) {
            logger.warn('Failed to record stall', { code: upperCode }, error as Error);
            return false;
        }

        // Failsafe: if the stalled client crashes/disconnects without reporting
        // ready, force a resume once its entry is abandoned. Per-replica timer,
        // same pattern as the buffer-check timeout.
        armStallFailsafe(upperCode, liveResult.session.timelineId);

        // State mutation and broadcast share the lock, preserving stall/resume
        // ordering across replicas.
        await broadcastToSession(upperCode, {
            type: 'stall',
            userId,
            displayName: liveResult.participant.displayName,
            clientId,
        });
        return true;
    });
}

/**
 * Report that a previously-stalled client recovered. Resumes the group only
 * when no other client is still stalled.
 */
export async function reportClientStallReady(
    code: string,
    userId: string,
    clientId: string,
    stallId: string,
): Promise<boolean> {
    const upperCode = code.toUpperCase();
    return withStallLock(upperCode, false, async () => {
        const liveResult = await getSessionWithParticipant(upperCode, userId, clientId);
        if (!liveResult) return false;
        try {
            await connectValkey();
            if (!isCoordinationValkeyReady()) return false;
            await setEx(
                KEYS.STALL_RECOVERED(upperCode, clientId, stallId),
                Math.ceil((STALL_ACTIVE_MS * 2) / 1000),
                '1',
            );
            const raw = await hGet(KEYS.STALLED(upperCode), clientId);
            if (!raw) return true;
            const active = JSON.parse(raw) as { stallId: string; timelineId?: string };
            if (active.stallId !== stallId) return true;
            if (
                active.timelineId !== undefined &&
                active.timelineId !== liveResult.session.timelineId
            ) {
                await hDel(KEYS.STALLED(upperCode), clientId);
                return true;
            }
            await hDel(KEYS.STALLED(upperCode), clientId);
        } catch (error) {
            logger.warn('Failed to clear stall entry', { code: upperCode }, error as Error);
            return false;
        }

        await resumeIfNoActiveStalls(upperCode);
        return true;
    });
}

/**
 * Report client position for drift detection
 * Uses distributed state in Valkey for multi-replica support
 * Returns true if a resync was triggered
 */
export async function reportPosition(
    code: string,
    clientId: string,
    userId: string,
    position: number,
): Promise<{ success: boolean; resyncing?: boolean }> {
    const upperCode = code.toUpperCase();

    // Get session to check if user is a participant and host
    const session = await getSession(code);
    if (!session) {
        return { success: true, resyncing: false };
    }

    // Reject position reports from non-participants
    const isParticipant = findParticipant(session, userId, clientId);
    if (!isParticipant) {
        return { success: false };
    }

    const isHost = isHostClient(session, clientId, userId);

    // Samples spanning a coordinated pause/seek are not comparable. Clear them
    // instead of carrying pre-transition media times into the next play period.
    const pendingCheck = await getBufferCheckState(upperCode);
    if (pendingCheck) {
        await clearDriftMeasurements(upperCode);
        return { success: true, resyncing: true };
    }

    // Paused parties need no drift correction. Explicit pause/seek events
    // already synchronize position, and projecting paused samples after a later
    // resume would manufacture drift across the time spent paused.
    if (!session.isPlaying) {
        await clearDriftMeasurements(upperCode);
        return { success: true, resyncing: false };
    }

    // Stall coordination owns playback while any client is buffering. Mixing
    // moving and intentionally-paused samples here would fight that protocol.
    if (await hasActiveStalls(upperCode)) {
        await clearDriftMeasurements(upperCode);
        return { success: true, resyncing: false };
    }

    // Store this client's position with a SERVER receipt timestamp. Client wall
    // clocks never enter the comparison, so clock skew/drift is irrelevant.
    await setClientPosition(upperCode, clientId, position, isHost);

    // Check cooldown (distributed via Valkey)
    if (await isDriftCooldownActive(upperCode)) {
        return { success: true, resyncing: false };
    }

    // Get all client positions (from Valkey, already filters stale entries)
    const positions = await getClientPositions(upperCode);

    // Project independently-timed samples to one server-clock instant before
    // comparing them. The fixed margin absorbs asymmetric network latency and
    // scheduling jitter without trusting client clocks or requiring RTT sync.
    const comparisonTime = Date.now();
    const estimate = estimateWatchTogetherDrift(
        positions.values() as Iterable<WatchTogetherPositionSample>,
        comparisonTime,
        true,
        session.playbackRate,
    );
    const localCorrectionThreshold = HARD_RESYNC_DRIFT_SECONDS + DRIFT_LATENCY_TOLERANCE_SECONDS;

    if (estimate.hostPosition === null || estimate.comparableGuests === 0) {
        // Need a fresh host/guest pair for a meaningful comparison.
        return { success: true, resyncing: false };
    }

    if (estimate.maxDrift > localCorrectionThreshold) {
        const confirmationCount = await recordDriftBreach(upperCode);
        if (confirmationCount < DRIFT_CONFIRMATION_COUNT) {
            logger.debug('Drift observation awaiting confirmation', {
                code: upperCode,
                maxDrift: estimate.maxDrift,
                threshold: localCorrectionThreshold,
                confirmationCount,
            });
            return { success: true, resyncing: false };
        }

        logger.info('Persistent drift detected; client-side correction remains authoritative', {
            code: upperCode,
            maxDrift: estimate.maxDrift,
            threshold: localCorrectionThreshold,
            hostPosition: estimate.hostPosition,
            confirmationCount,
        });

        await clearDriftBreach(upperCode);

        // Browser and tvOS synchronizers handle drift locally with rate
        // correction and, for extreme drift, a guest-local seek. A periodic
        // report must never pause every participant.
        await setDriftCooldown(upperCode);
        return { success: true, resyncing: false };
    }

    // One healthy comparison breaks the consecutive-breach sequence.
    await clearDriftBreach(upperCode);
    return { success: true, resyncing: false };
}

/**
 * Clean up position tracking for a session
 * Uses distributed state in Valkey
 */
export async function cleanupPositionTracking(code: string): Promise<void> {
    const upperCode = code.toUpperCase();
    await cleanupPositionTrackingState(upperCode);
}
