// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch-Together Events Channel
 *
 *   POST /watch-together/{code}/events   {clientId, type, payload}
 *   GET  /watch-together/{code}/events   SSE
 *
 * The POST dispatch table is a switch(type) calling service functions
 * via a single bidirectional channel.
 *
 * SSE features:
 *   - `event: error` frame before stream close on mid-stream errors
 *   - `Last-Event-ID` replay (capped ring in Valkey: `watch:v2:replay:{code}`)
 *   - `id:` field on every event frame (seq = watch:v2:seq:{code} INCR)
 *   - Feature gate: {kind:'feature', flag:'FEATURE_WATCH_TOGETHER', then:{kind:'user'}}
 *
 * The {clientId, type, payload} envelope is transport-agnostic.
 *
 * Auth:
 *   - Endpoint: feature(FEATURE_WATCH_TOGETHER) → user
 *   - Host-only types enforced in-handler (defense-in-depth; mirrors service checks)
 */

import {
    toPublicParty,
    toPublicFramesForSurface,
} from '$lib/server/services/watch-together-public.js';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, problem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    WATCH_TOGETHER_FRAME_SCHEMAS,
    sessionCodeParamsSchema,
    watchTogetherEventInputSchema,
    watchTogetherEventsQuerySchema,
    WATCH_TOGETHER_HOST_ONLY_EVENTS,
    EventAcceptedResponseSchema,
    EventPositionResponseSchema,
    EventJoinResponseSchema,
} from '$lib/schemas/watch-together.js';
import {
    getSession,
    getSessionWithParticipant,
    isHostClient,
    findParticipant,
    joinSession,
    leaveSession,
    disbandSession,
    transferHost,
    setSessionVisibility,
    broadcastSeek,
    updatePlaybackState,
    reportPosition,
    broadcastReaction,
    broadcastScreenEffect,
    navigateParty,
    broadcastVersionChange,
    broadcastHostActivity,
    updateSessionPosition,
    signalReady,
    registerSSEConnection,
    touchSSEConnection,
    reportClientStall,
    reportClientStallReady,
    getPendingBufferCheckSnapshot,
    getActiveSSEConnectionCount,
} from '$lib/server/services/watch-together.service.js';
import { checkJoinRateLimit } from './join-rate-limit.js';
import {
    connectValkey,
    isCoordinationValkeyReady,
    lRange,
    cacheGet,
} from '$lib/server/cache/valkey.js';
import { startSseKeepalive } from '$lib/server/utils/sse.js';
import { mediaIdResolver } from '$lib/server/services/media-id-resolver.js';
import { getDb } from '$lib/server/database/connection.js';
import { getFilesForMediaItem } from '$lib/server/database/queries/media-files.queries.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { config } from '$lib/server/config.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { acquireUserConnectionSlot } from '$lib/server/utils/sse-connection-ceiling.js';
import type { SSEEventType } from '$lib/types/watch-together.js';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';
import { z } from 'zod';

/** Namespace for this endpoint's SSE connection-slot accounting (P1). */
const SSE_CONNECTION_NAMESPACE = 'watch-together';

const WatchTogetherEventsQuerySchema = z.object({
    clientId: z
        .string()
        .optional()
        .meta({ description: 'Stable client identifier for Last-Event-ID replay scoping' }),
    lastEventId: z.string().optional().meta({
        description: 'Resume from this SSE sequence number (ring buffer replay)',
    }),
});

const logger = Logger.for('WatchTogether:Events');

// ---------------------------------------------------------------------------
// Replay ring constants (Last-Event-ID)
// ---------------------------------------------------------------------------

/** Max events kept in the per-session replay ring (written by the service's broadcastToSession). */
const REPLAY_MAX = 50;

const KEYS = {
    SEQ: (code: string) => `watch:v2:seq:${code.toUpperCase()}`,
    REPLAY: (code: string) => `watch:v2:replay:${code.toUpperCase()}`,
};

// ---------------------------------------------------------------------------
// Replay helpers
// ---------------------------------------------------------------------------

/**
 * Read the retained replay window, including sender-excluded cursor entries.
 * Returns them in ascending seq order (oldest first) so the client
 * replays them in the right order.
 */
async function getReplayEvents(
    code: string,
    clientId: string,
): Promise<Array<{ seq: number; event: SSEEventType | null }>> {
    try {
        await connectValkey();
        if (!isCoordinationValkeyReady()) return [];

        const raw = await lRange(KEYS.REPLAY(code), 0, REPLAY_MAX - 1);
        const parsed: Array<{ seq: number; event: SSEEventType | null }> = [];

        for (const entry of raw) {
            try {
                const item = JSON.parse(entry) as {
                    seq: number;
                    event: SSEEventType;
                    excludeClientId?: string;
                };
                if (Number.isSafeInteger(item.seq) && item.seq > 0) {
                    parsed.push({
                        seq: item.seq,
                        event: item.excludeClientId === clientId ? null : item.event,
                    });
                }
            } catch {
                // skip corrupt entries
            }
        }

        // lRange returns newest-first (LPUSH), sort ascending
        return parsed.sort((a, b) => a.seq - b.seq);
    } catch (err) {
        logger.warn('getReplayEvents failed', { code }, err as Error);
        return [];
    }
}

// NOTE: stall / stall-ready dispatch now goes through the service layer
// (reportClientStall / reportClientStallReady), which broadcasts via
// broadcastToSession — replay ring + pub/sub included. The local
// publishAndReplay helper they used was removed with them.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireUser(event: RequestEvent) {
    const displayName = event.locals.principal?.username ?? event.locals.user?.username;
    const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
    if (!displayName || !userId) return null;
    return { displayName, userId };
}

// ---------------------------------------------------------------------------
// POST /watch-together/{code}/events
// ---------------------------------------------------------------------------

/**
 * Request-schema shape declared on this endpoint's `request` block below. Threads
 * the parsed body/query/params output types onto `ctx.input` so handlers read
 * typed values (e.g. the discriminated `payload`) instead of the open default.
 */
type EventsRequestSchemas = {
    body: typeof watchTogetherEventInputSchema;
    query: typeof eventsQuerySchema;
    params: typeof sessionCodeParamsSchema;
};

async function handlePost(
    event: RequestEvent,
    ctx: ApiContext<EventsRequestSchemas>,
): Promise<Response> {
    const identity = requireUser(event);
    if (!identity) return ApiProblem.unauthorized();

    // params and body were validated by mount() before this handler runs.
    // ctx.input carries the typed, parsed values.
    const code = (ctx.input?.params as { code?: string })?.code;
    if (!code) {
        return problem('validation_failed', {
            details: [{ field: 'code', message: 'Session code is required' }],
        });
    }

    // Body was validated by mount() before this handler runs.
    const input = ctx.input?.body;
    if (!input) {
        return problem('validation_failed', { error: 'Request body must be valid JSON' });
    }
    const { clientId, type, payload } = input;
    const { userId, displayName } = identity;

    // Enrollment is the only event allowed without an owned participant ID.
    if (type !== 'join') {
        const session = await getSession(code);
        if (!session) return ApiProblem.notFound('Session not found');
        if (!findParticipant(session, userId, clientId)) {
            if (type === 'leave' && !session.participants.some((p) => p.clientId === clientId)) {
                return json({ accepted: true as const }, { status: 202 });
            }
            return problem('forbidden', { error: 'Unknown client for this participant' });
        }
        if (
            (WATCH_TOGETHER_HOST_ONLY_EVENTS as string[]).includes(type) &&
            !isHostClient(session, clientId, userId)
        ) {
            return problem('forbidden', { error: `Event type '${type}' is host-only` });
        }
    }

    // Dispatch
    switch (type) {
        // ---- (a) broadcasts ------------------------------------------------

        case 'seek': {
            const ok = await broadcastSeek(
                code,
                userId,
                payload.currentTime,
                clientId,
                payload.isPlaying, // undefined = legacy client → session state
                payload.itemId,
                payload.expectedTimelineId,
            );
            if (!ok)
                return problem('forbidden', { error: 'Not a participant or session not found' });
            return json({ accepted: true as const }, { status: 202 });
        }

        case 'sync': {
            const ok = await updatePlaybackState(
                code,
                userId,
                {
                    currentTime: payload.currentTime,
                    isPlaying: payload.isPlaying,
                    playbackRate: payload.playbackRate ?? 1,
                    timestamp: Date.now(),
                },
                clientId,
                payload.itemId,
                payload.expectedTimelineId,
                payload.syncId,
            );
            if (!ok)
                return problem('forbidden', { error: 'Not a participant or session not found' });
            return json({ accepted: true as const }, { status: 202 });
        }

        case 'position': {
            const result = await reportPosition(code, clientId, userId, payload.position);
            if (!result.success)
                return problem('forbidden', { error: 'Not a participant in this session' });
            // position → 200 {resyncing}
            return json({ resyncing: result.resyncing ?? false });
        }

        case 'reaction': {
            const ok = await broadcastReaction(code, userId, payload.emoji as never);
            if (!ok)
                return problem('forbidden', { error: 'Not a participant or session not found' });
            return json({ accepted: true as const }, { status: 202 });
        }

        case 'effect': {
            const ok = await broadcastScreenEffect(code, userId, payload.effect as never);
            if (!ok)
                return problem('forbidden', { error: 'Not a participant or session not found' });
            return json({ accepted: true as const }, { status: 202 });
        }

        // ---- (b) authoritative (host-only, already gate-checked above) -----

        case 'navigate': {
            // Canonicalize itemId + media access check (mirrors old navigate route)
            let itemId = payload.itemId;
            try {
                const resolved = await mediaIdResolver.resolveAnyMediaId(payload.itemId);
                if (resolved.internalId) itemId = resolved.internalId;
            } catch {
                logger.warn('Could not resolve itemId for navigate event', {
                    rawItemId: payload.itemId,
                });
            }

            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database unavailable');
            const accessAllowed = await checkMediaAccess(db, itemId, event.locals.user ?? null);
            if (!accessAllowed) return ApiProblem.notFound('Media not found or access denied');

            let validatedFileId = payload.fileId;
            if (validatedFileId) {
                const files = await getFilesForMediaItem(db, itemId);
                if (!files.some((f) => f.id === validatedFileId)) {
                    logger.warn('navigate event fileId does not belong to item, dropping', {
                        fileId: validatedFileId,
                        itemId,
                    });
                    validatedFileId = undefined;
                }
            }

            // The host's own access is not enough. navigateParty rewrites the
            // session's title and fans it out to EVERY participant, so without
            // its participantsBlockedBy check a host could move the party onto a
            // title someone in the room is not entitled to and push them its
            // name. Shared with the REST /navigate route (security review
            // 2026-09-12, C11).
            const result = await navigateParty(code, itemId, payload.title, {
                userId,
                clientId,
                mediaType: payload.mediaType,
                fileId: validatedFileId,
                timelineId: payload.timelineId,
                expectedTimelineId: payload.expectedTimelineId,
            });
            if (!result.ok) {
                return result.status === 'not_found'
                    ? ApiProblem.notFound(result.message)
                    : problem('forbidden', { error: result.message });
            }
            return json(
                { accepted: true as const, currentTime: result.currentTime },
                { status: 202 },
            );
        }

        case 'version': {
            const ok = await broadcastVersionChange(code, userId, payload.fileId, clientId);
            if (!ok)
                return problem('forbidden', {
                    error: 'Not a participant, session not found, or invalid file',
                });
            return json({ accepted: true as const }, { status: 202 });
        }

        case 'visibility': {
            const ok = await setSessionVisibility(code, userId, payload.visibility);
            if (!ok) return problem('forbidden', { error: 'Only the host can change visibility' });
            return json({ accepted: true as const }, { status: 202 });
        }

        case 'transfer-host': {
            const ok = await transferHost(code, userId, payload.newHostUserId);
            if (!ok)
                return problem('forbidden', {
                    error: 'Only the host can transfer — or target is not a participant / is self',
                });
            return json({ accepted: true as const }, { status: 202 });
        }

        case 'disband': {
            const ok = await disbandSession(code, userId);
            if (!ok)
                return problem('forbidden', { error: 'Only the host can disband the session' });
            return json({ accepted: true as const }, { status: 202 });
        }

        case 'activity': {
            const ok = await broadcastHostActivity(code, userId, payload.activity, payload.message);
            if (!ok) return problem('forbidden', { error: 'Only the host can broadcast activity' });
            return json({ accepted: true as const }, { status: 202 });
        }

        // ---- (c) barriers --------------------------------------------------

        case 'join': {
            // Rate-limited on the SAME key as POST {code}/join, so alternating
            // between the two doors does not double the budget. Only this branch
            // is limited — sync/position/heartbeat share this endpoint and fire
            // continuously during normal playback.
            const joinRl = await checkJoinRateLimit(code, userId, clientId);
            if (!joinRl.allowed) return ApiProblem.rateLimited(joinRl.retryAfter);

            // joinSession gates the session's item against this viewer's library
            // groups and age rating before returning it — this is the path the
            // OpenAPI description calls "the only event type exempt from the
            // participant check", so it is exactly where an unentitled caller
            // would otherwise obtain title/poster/fileId.
            const session = await joinSession(
                code,
                userId,
                displayName,
                clientId,
                event.locals.user,
            );
            if (!session) return ApiProblem.notFound('Session not found or expired');
            // join → 200 {session}
            return json({ party: await toPublicParty(session, ctx.surface) });
        }

        case 'leave': {
            // Idempotent — leaveSession returns false if not a participant, which is fine
            await leaveSession(code, userId, clientId);
            return json({ accepted: true as const }, { status: 202 });
        }

        case 'ready': {
            const result = await getSessionWithParticipant(code, userId, clientId);
            if (!result)
                return problem('forbidden', { error: 'Not a participant in this session' });
            const isHost = isHostClient(result.session, clientId, userId);
            await signalReady(
                code,
                clientId,
                payload.checkId,
                isHost ? payload.currentTime : undefined,
            );
            return json({ accepted: true as const }, { status: 202 });
        }

        case 'stall': {
            const ok = await reportClientStall(
                code,
                userId,
                clientId,
                payload.stallId,
                payload.expectedTimelineId,
            );
            if (!ok) {
                // false for both an unknown session and a non-participant —
                // distinguish so a missing session is 404, a non-participant 403.
                const session = await getSession(code);
                return session
                    ? problem('forbidden', { error: 'Not a participant in this session' })
                    : ApiProblem.notFound('Session not found');
            }
            return json({ accepted: true as const }, { status: 202 });
        }

        case 'stall-ready': {
            const ok = await reportClientStallReady(code, userId, clientId, payload.stallId);
            if (!ok) {
                const session = await getSession(code);
                return session
                    ? problem('forbidden', { error: 'Not a participant in this session' })
                    : ApiProblem.notFound('Session not found');
            }
            return json({ accepted: true as const }, { status: 202 });
        }

        case 'heartbeat': {
            const ok = await updateSessionPosition(
                code,
                userId,
                payload.currentTime,
                clientId,
                payload.isPlaying,
                payload.itemId,
                payload.expectedTimelineId,
            );
            if (!ok) return ApiProblem.notFound('Session not found or not a participant');
            return json({ accepted: true as const }, { status: 202 });
        }

        default: {
            // TypeScript exhaustiveness guard
            const _exhaustive: never = input;
            void _exhaustive;
            return problem('validation_failed', { error: 'Unknown event type' });
        }
    }
}

// ---------------------------------------------------------------------------
// GET /watch-together/{code}/events  (SSE — the sole watch-together stream; legacy /stream was removed)
// ---------------------------------------------------------------------------

async function handleGet(
    event: RequestEvent,
    ctx: ApiContext<EventsRequestSchemas>,
): Promise<Response> {
    const requestReceivedAt = Date.now();
    const identity = requireUser(event);
    if (!identity) return ApiProblem.unauthorized();

    // P1 (fix round 1, finding 2): bound CONNECT churn — this def's `POST`
    // handler dispatches frequent, fire-and-forget sync/position/heartbeat
    // events on the SAME def, so `EndpointDef.rateLimit` (which applies to
    // EVERY method on a def) can't be used here without also throttling that
    // continuous traffic. Enforce the connect-rate limit by hand, inside the
    // GET handler only, using the same Valkey mechanism `rateLimit` is built
    // on (checkRateLimit — see mount.ts's enforceRateLimit).
    const connectRl = await checkRateLimit(`sse-connect:watch-together:${identity.userId}`, 30, 60);
    if (!connectRl.allowed) {
        return ApiProblem.rateLimited(
            Math.max(0, Math.ceil(connectRl.resetAt - Date.now() / 1000)),
        );
    }

    // params and query were validated by mount() before this handler runs.
    const code = (ctx.input?.params as { code?: string })?.code;
    if (!code) {
        return ApiProblem.notFound('Invalid session code');
    }

    const clientId = (ctx.input?.query as { clientId?: string })?.clientId;
    if (!clientId) {
        return problem('validation_failed', {
            details: [{ field: 'clientId', message: 'clientId query parameter is required' }],
        });
    }

    // Last-Event-ID from header (RFC 6202) or query param
    const lastEventIdHeader = event.request.headers.get('Last-Event-ID');
    const lastEventIdQuery = (ctx.input?.query as { lastEventId?: string })?.lastEventId;
    const lastEventIdRaw = lastEventIdHeader ?? lastEventIdQuery;
    const validCursor =
        lastEventIdRaw !== null &&
        lastEventIdRaw !== undefined &&
        /^\d{1,15}$/.test(lastEventIdRaw);
    const lastSeq = validCursor ? Number(lastEventIdRaw) : 0;
    const hasCursor = lastEventIdRaw !== null && lastEventIdRaw !== undefined;

    const { userId } = identity;

    // Verify session exists (Tier-1 error → problem+json)
    let session = await getSession(code);
    if (!session) {
        return ApiProblem.notFound('Session not found or expired');
    }

    // Validate before reserving capacity or registering a connection marker.
    const isParticipant = findParticipant(session, userId, clientId);
    if (!isParticipant) {
        return problem('forbidden', { error: 'Not a participant in this session' });
    }

    // P1 (fix round 1, finding 2): process-wide + per-user SSE connection
    // ceilings, checked as late as the cheap validation above allows — right
    // before the connection is actually registered — so there is exactly ONE
    // early-return path to release the slot from (the registerSSEConnection
    // catch below) before the guaranteed cleanup() path takes over.
    const processWideConnections = getActiveSSEConnectionCount();
    if (processWideConnections >= config.SSE_MAX_CONNECTIONS) {
        return problem('stream_limit', {
            error: 'SSE connection capacity reached — try again shortly',
        });
    }
    const connectionSlot = await acquireUserConnectionSlot(
        SSE_CONNECTION_NAMESPACE,
        userId,
        config.SSE_MAX_CONNECTIONS_PER_USER,
    );
    if (!connectionSlot.ok) {
        return problem('rate_limited', {
            error: `Too many concurrent SSE connections for this user (max ${config.SSE_MAX_CONNECTIONS_PER_USER})`,
        });
    }

    let stopKeepalive: (() => void) | null = null;
    let unregisterFn: (() => void) | null = null;
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const pendingLiveEvents: Array<{ event: SSEEventType; seq?: number }> = [];
    const encoder = new TextEncoder();

    /**
     * Format an SSE frame with optional `id:` field (seq) and `event:` field.
     * Plain `data:` lines are the default event type (unnamed).
     *
     * When the stream controller throws (client disconnected, stream closed),
     * we attempt to emit an `event: error` frame before tearing down so any
     * still-open transport layer receives the signal.  If that also fails the
     * stream is truly gone and cleanup runs silently.
     */
    const sendFrame = (data: string | null, seq?: number, eventName?: string): void => {
        if (!streamController) return;
        let frame = '';
        if (seq !== undefined && seq > 0) frame += `id: ${seq}\n`;
        if (eventName) frame += `event: ${eventName}\n`;
        if (data !== null) frame += `data: ${data}\n`;
        frame += '\n';
        try {
            streamController.enqueue(encoder.encode(frame));
        } catch {
            // Mid-stream write error — emit an error frame (best-effort) then clean up.
            // We call _sendError only when this is NOT itself an error frame to avoid
            // infinite recursion: check eventName before re-entering.
            if (eventName !== 'error') {
                try {
                    const errFrame = `event: error\ndata: ${JSON.stringify({ type: 'error', error: 'Stream write error' })}\n\n`;
                    streamController.enqueue(encoder.encode(errFrame));
                } catch {
                    // stream is fully gone — fall through to cleanup
                }
            }
            cleanup();
        }
    };

    const sendEvent = (sseEvent: SSEEventType, seq?: number): void => {
        if (!streamController) return;
        try {
            sendFrame(JSON.stringify(toPublicFramesForSurface(sseEvent, ctx.surface)), seq);
        } catch (err) {
            // Serialisation failed — surface an error frame before tearing down.
            logger.warn('sendEvent serialisation error', { code }, err as Error);
            _sendError('Internal stream error — event could not be serialised');
            cleanup();
        }
    };

    const _sendError = (msg: string): void => {
        if (!streamController) return;
        try {
            sendFrame(JSON.stringify({ type: 'error', error: msg }), undefined, 'error');
        } catch {
            // stream already closed — nothing further to do
        }
    };

    const cleanup = (): void => {
        if (stopKeepalive) {
            stopKeepalive();
            stopKeepalive = null;
        }
        if (unregisterFn) {
            unregisterFn();
            unregisterFn = null;
        }
        // Idempotent — safe even if this is somehow called more than once.
        connectionSlot.release();
    };

    /**
     * Wrap the raw sendEvent callback so that:
     *  1. If the service pushes an event whose type is `session_ended` (i.e. a
     *     host-initiated disband or a system-level teardown), we emit an
     *     `event: error` frame immediately after the data frame so clients that
     *     only listen for the error event also get a clean teardown signal.
     *  2. If the service callback itself throws (malformed event from pub/sub),
     *     we emit an error frame before letting cleanup run.
     */
    const sendEventWithErrorGate = (sseEvent: SSEEventType, seq?: number): void => {
        if (!streamController) {
            pendingLiveEvents.push({ event: sseEvent, seq });
            return;
        }
        sendEvent(sseEvent, seq);
        // After a session_ended broadcast the stream has no more useful data.
        // Emit an explicit error frame so clients subscribed to `event: error`
        // receive the disband signal even if they missed the data frame.
        if ((sseEvent as { type?: string }).type === 'session_ended') {
            _sendError('Session disbanded by host');
        }
    };

    // Register before reading replay. Events arriving during that read are
    // queued below, closing the replay-to-live subscription gap.
    try {
        unregisterFn = await registerSSEConnection(code, clientId, sendEventWithErrorGate);
    } catch (err) {
        logger.warn('registerSSEConnection failed', { code }, err as Error);
        // cleanup()/the stream's cancel() will never run for this early return
        // — release the slot explicitly so a registration failure doesn't
        // permanently pin a phantom connection against this user's budget.
        connectionSlot.release();
        return ApiProblem.dependencyUnavailable('Event stream unavailable — cache layer error');
    }

    // The connection slot was already reserved above (registerSSEConnection).
    // If either startup read throws, the ReadableStream below is never
    // constructed, so its cancel()/onDead paths — the normal way cleanup()
    // runs — will never fire for this early return. Release explicitly via
    // cleanup() itself (not a hand-rolled unregisterFn()+release() pair) so
    // there is exactly one release implementation to keep idempotent-safe;
    // cleanup() already nulls unregisterFn and connectionSlot.release() is
    // itself idempotent, so calling it here is safe even though nothing else
    // can call it before the stream exists.
    let publicParty: Awaited<ReturnType<typeof toPublicParty>>;
    let replayEvents: Array<{ seq: number; event: SSEEventType | null }>;
    let lastEventId = 0;
    let resyncReason: 'gap' | 'ahead' | undefined;
    let bufferCheck: Awaited<ReturnType<typeof getPendingBufferCheckSnapshot>>;
    try {
        await connectValkey();
        lastEventId = isCoordinationValkeyReady() ? Number(await cacheGet(KEYS.SEQ(code))) || 0 : 0;
        const ring = await getReplayEvents(code, clientId);
        const oldest = ring[0]?.seq;
        if (hasCursor) {
            if (!validCursor || !isCoordinationValkeyReady()) resyncReason = 'gap';
            else if (lastSeq > lastEventId) resyncReason = 'ahead';
            else if (lastSeq < lastEventId && (oldest === undefined || lastSeq < oldest - 1)) {
                resyncReason = 'gap';
            }
        }
        replayEvents =
            hasCursor && !resyncReason ? ring.filter((entry) => entry.seq > lastSeq) : [];
        const currentSession = await getSession(code);
        if (!currentSession) {
            cleanup();
            return ApiProblem.notFound('Session not found or expired');
        }
        session = currentSession;
        publicParty = await toPublicParty(currentSession, ctx.surface);
        bufferCheck = await getPendingBufferCheckSnapshot(code);
    } catch (err) {
        logger.warn('Failed to load SSE startup state', { code }, err as Error);
        cleanup();
        return ApiProblem.dependencyUnavailable('Event stream unavailable — cache layer error');
    }

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            streamController = controller;

            // Bootstrap the current session before replaying transient events.
            // Clients use this snapshot to initialise their state machines;
            // replay then restores any commands missed after their cursor.
            sendFrame(
                JSON.stringify({
                    type: 'connected',
                    party: publicParty,
                    lastEventId,
                    requestReceivedAt,
                    serverTime: Date.now(),
                    bufferCheck,
                }),
            );

            if (resyncReason) {
                sendEvent({ type: 'resync', reason: resyncReason, lastEventId });
            }

            // Merge replay with live events queued while replay was being read.
            // A sequence can appear in both sources; keep one delivery and
            // preserve global order. Events without a sequence are fail-soft
            // live deliveries and follow sequenced startup events.
            const startupBySeq = new Map<number, SSEEventType | null>();
            for (const replayEvent of replayEvents) {
                startupBySeq.set(replayEvent.seq, replayEvent.event);
            }
            const unsequenced: SSEEventType[] = [];
            for (const pending of pendingLiveEvents.splice(0)) {
                if (pending.seq && pending.seq > 0) {
                    if (resyncReason && pending.seq <= lastEventId) continue;
                    if (!startupBySeq.has(pending.seq)) {
                        startupBySeq.set(pending.seq, pending.event);
                    }
                } else {
                    unsequenced.push(pending.event);
                }
            }

            for (const [seq, replayEvent] of [...startupBySeq].sort((a, b) => a[0] - b[0])) {
                if (replayEvent) {
                    sendEventWithErrorGate(replayEvent, seq);
                } else {
                    // Advance Last-Event-ID without echoing the sender's own
                    // excluded event. No data field means EventSource does not
                    // dispatch a message for this cursor-only frame.
                    sendFrame(null, seq);
                }
            }
            for (const pendingEvent of unsequenced) {
                sendEventWithErrorGate(pendingEvent);
            }

            // Keepalive on the shared SSE_KEEPALIVE_MS cadence. The binding
            // constraint is the client's HTTP/3 (QUIC) idle timeout: a paused
            // party stops sending playback events, so without this the stream
            // goes idle and QUIC closes it (~30 s observed). Each tick also
            // refreshes the CONNECTIONS liveness marker (buffer-check sizing +
            // stale-session reap gating), staying well inside
            // CONNECTION_STALE_MS (90 s), AND the connection-slot TTL (final
            // fix wave, 2026-09-13) — otherwise a watch party running longer
            // than SSE_CONN_TTL_SEC (1h) has its slot key expire while still
            // held, and the eventual release() DECR recreates it at -1 with
            // no TTL.
            stopKeepalive = startSseKeepalive(controller, {
                onTick: () => {
                    void touchSSEConnection(code, clientId);
                    connectionSlot.refresh();
                },
                onDead: cleanup,
            });
        },
        cancel() {
            cleanup();
        },
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        },
    });
}

// ---------------------------------------------------------------------------
// EndpointDef export
// ---------------------------------------------------------------------------

/**
 * Combined query schema for GET + POST /watch-together/{code}/events.
 *
 * GET requires clientId; POST does not use query params.
 * Make clientId optional so POST requests are not rejected by the contract layer.
 * The GET handler validates clientId presence itself and returns a meaningful error.
 */
const eventsQuerySchema = watchTogetherEventsQuerySchema.extend({
    clientId: watchTogetherEventsQuerySchema.shape.clientId.optional(),
});

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Watch Together'],
            summary: 'Subscribe to Watch Together session events (SSE)',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Opens an SSE stream for a Watch Together session. Supports `Last-Event-ID` replay ' +
                'of the newest 50 business frames. Business frames have increasing per-party `id:` values; replay-storage failures warn and continue live delivery without an id. ' +
                'The unnumbered bootstrap `connected` frame includes the full party and `lastEventId` ' +
                '(current counter, 0 if none). A cursor older than the replay window triggers an unnumbered ' +
                '`resync` frame with reason `gap`; a cursor newer than the counter uses reason `ahead`. ' +
                'Malformed cursors or a cursor sent while Valkey is unavailable use reason `gap` and skip replay. ' +
                'Resync follows connected immediately and skips replay; re-read GET /watch-together/{code} ' +
                '(the bootstrap already includes that snapshot). Sender-excluded frames advance only `id:`. ' +
                'Heartbeat is the SSE comment `: ping`, not an event. Errors use the named `event: error`. ' +
                'Wire schemas: ' +
                Object.entries(WATCH_TOGETHER_FRAME_SCHEMAS)
                    .map(([name, schema]) => `\`${schema.shape.type.value}\` → \`${name}\``)
                    .join(', ') +
                '. ' +
                'The caller must already be a participant — enroll first by POSTing a ' +
                '`{ type: "join" }` event to this same path (see POST), then connect. ' +
                'Feature-gated: `FEATURE_WATCH_TOGETHER` must be enabled.',
            query: WatchTogetherEventsQuerySchema,
            responses: {
                200: {
                    sse: true,
                    description: 'Watch Together event stream',
                },
                401: 'Authentication required',
                403: 'Not a participant in this session — POST a `join` event first',
                404: 'Feature not enabled or session not found',
                503: 'Cache service unavailable',
                500: 'Internal server error',
            },
        },
        POST: {
            tags: ['Watch Together'],
            summary: 'Dispatch an event to Watch Together session',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Dispatches a transport-agnostic event to the Watch Together session. ' +
                'The `{clientId, type, payload}` envelope is fan-out to all session participants via SSE. ' +
                'This is the single write surface for all session operations — there are no dedicated ' +
                'sub-routes (`/join`, `/seek`, `/reaction`, …) on the v1 API. ' +
                '**To join a session** (including a public one you are not yet in), POST ' +
                '`{ clientId, type: "join", payload: {} }`; this returns `200 { party }` and is the ' +
                'only event type exempt from the participant check. Only then will `GET {code}` and the ' +
                'SSE `GET {code}/events` stream succeed. ' +
                'Host-only event types are enforced server-side. ' +
                'Feature-gated: `FEATURE_WATCH_TOGETHER` must be enabled.',
            body: watchTogetherEventInputSchema,
            responses: {
                // The POST never emits { seq, delivered }. Its branches return
                // 200 { resyncing } (position) or 200 { party } (join), and
                // 202 { accepted: true } for every fire-and-forget event type.
                200: {
                    schema: z.union([EventPositionResponseSchema, EventJoinResponseSchema]),
                    description: 'Position resync ({ resyncing }) or join ({ party }) result',
                },
                202: {
                    schema: EventAcceptedResponseSchema,
                    description: 'Event accepted and fanned out to participants',
                },
                400: 'Validation error or invalid event type',
                401: 'Authentication required',
                403: 'Not a participant or host-only event type',
                404: 'Feature not enabled or session not found',
                503: 'Cache service unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: {
        kind: 'feature',
        flag: 'FEATURE_WATCH_TOGETHER',
        then: { kind: 'user' },
    },
    request: {
        // POST body: discriminated union on `type` — validated before handlePost runs.
        // GET query: clientId + optional lastEventId (both validated by the handler too).
        // body validation is skipped for GET (mount.ts: methodCanHaveBody).
        body: watchTogetherEventInputSchema,
        query: eventsQuerySchema,
        queryMethods: ['GET'],
        params: sessionCodeParamsSchema,
    },
    raw: true, // GET returns SSE (Class R); POST returns bare JSON
    handlers: {
        POST: handlePost,
        GET: handleGet,
    },
});

// Re-export response schemas for tests / OpenAPI generation
export {
    EventAcceptedResponseSchema,
    EventPositionResponseSchema,
    EventJoinResponseSchema,
    watchTogetherEventInputSchema,
    watchTogetherEventsQuerySchema,
};
