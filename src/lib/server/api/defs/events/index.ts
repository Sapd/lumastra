// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/events/index.ts — GET /api/v1/events
 *
 * The ONE global per-user SSE channel.
 * Contract:
 *
 *   - `event: connected` bootstrap frame with `{serverTime}` on connect.
 *   - `id:` per frame + `Last-Event-ID` replay via Valkey (user:events:* keys).
 *   - Admin/maintenance frames (from adminEvents EventEmitter).
 *   - Watch-state change frames (cross-pod user hub, sourced by watchStateEvents).
 *   - Device remote-control frames (device.command only to the target device's
 *     own stream, device.command_status / device.state to the account).
 *   - Keepalive `: ping` comments from the hub on the shared SSE cadence (SSE_KEEPALIVE_MS).
 *   - Per-user isolation via `Consumer.targetUserId` filter in the hub.
 *
 * Scoped SSE channels for individual resources remain separate — they have a resource lifecycle.
 *
 * Auth: {kind:'user'} — any authenticated user.
 * Class R: SSE (raw) response.
 */

import { randomUUID } from 'node:crypto';
import {
    markDeviceStreamClosed,
    markDeviceStreamOpen,
} from '$lib/server/services/device-presence.service.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { userEventsHub } from '$lib/server/services/notification-events.service.js';
import {
    adminEvents,
    getActiveMaintenanceNotice,
    withRemaining,
    shouldDeliverAdminMessageToUserId,
    type AdminMessagePayload,
    type MaintenanceNoticeFrame,
} from '$lib/server/services/play-session-events.service.js';
import { watchStateEvents } from '$lib/server/services/watch-state-events.service.js';
import { isDeviceSessionTombstoned } from '$lib/server/oauth/device-session-liveness.js';
import type { UserId } from '$lib/shared/user-id.js';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';

/** Refresh cadence of the device stream marker (its TTL is 45 s). */
const STREAM_PRESENCE_REFRESH_MS = 30_000;

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleGet(event: RequestEvent, _ctx: ApiContext): Promise<Response> {
    // Auth is enforced by mount() via {kind:'user'} — locals.user is populated.
    // UserId is a branded string; preserve the brand for watchStateEvents.subscribe().
    const userId: UserId | null = event.locals.user?.userId ?? null;
    // Plain string for the hub filter and SSE frame data.
    const userIdStr: string | null = userId as string | null;
    const username = event.locals.principal?.username ?? event.locals.user?.username ?? null;

    if (!userId || !userIdStr || !username) {
        return ApiProblem.unauthorized();
    }

    // ── Per-connection state ─────────────────────────────────────────────────

    let maintenanceNoticeListener: ((notice: MaintenanceNoticeFrame) => void) | null = null;
    let maintenanceClearedListener: (() => void) | null = null;
    let adminMessageListener: ((payload: unknown) => void) | null = null;
    let watchStateUnsubscribe: (() => void) | null = null;
    /** Keeps the device's "stream open" marker alive (live remote commands). */
    let streamPresenceTimer: ReturnType<typeof setInterval> | null = null;
    let presenceDeviceSessionId: string | undefined;
    /** Names this stream in the presence marker (see markDeviceStreamOpen). */
    const streamToken = randomUUID();

    // ── Stream ───────────────────────────────────────────────────────────────
    // The hub provides: replay, keepalive, per-user user:events:* frames.
    // We layer on top: admin/maintenance + session lifecycle (local emitters).
    // Both extra sources write into `extraController` — a ReadableStream that
    // we pump concurrently with the hub stream into a single merged output.

    let extraController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let extraClosed = false;

    function sendExtra(eventName: string, data: unknown): void {
        if (extraClosed || !extraController) return;
        try {
            extraController.enqueue(
                encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`),
            );
        } catch {
            extraClosed = true;
        }
    }

    function cleanupListeners(): void {
        if (streamPresenceTimer) {
            clearInterval(streamPresenceTimer);
            streamPresenceTimer = null;
        }
        if (presenceDeviceSessionId) {
            const id = presenceDeviceSessionId;
            presenceDeviceSessionId = undefined;
            void markDeviceStreamClosed(id, streamToken).catch(() => {});
        }
        if (maintenanceNoticeListener) {
            adminEvents.off('maintenance_notice', maintenanceNoticeListener);
            maintenanceNoticeListener = null;
        }
        if (maintenanceClearedListener) {
            adminEvents.off('maintenance_cleared', maintenanceClearedListener);
            maintenanceClearedListener = null;
        }
        if (adminMessageListener) {
            adminEvents.off('admin_message_broadcast', adminMessageListener);
            adminMessageListener = null;
        }
        watchStateUnsubscribe?.();
        watchStateUnsubscribe = null;
        extraClosed = true;
        if (extraController) {
            try {
                extraController.close();
            } catch {
                /* already closed */
            }
            extraController = null;
        }
    }

    // Hub response — replay + live per-user frames + keepalive.
    // `streamResponse` registers a Consumer with targetUserId=userIdStr so only
    // frames for this user are delivered.
    //
    // P1: streamResponse() now enforces per-user (429) and process-wide (503)
    // SSE connection ceilings BEFORE building the stream, returning an ordinary
    // problem+json Response in that case — status is NOT 200, and its body is
    // NOT an SSE stream. That must be returned to the caller as-is rather than
    // treated as hub frames to pump.
    // targetUsername (security fix C28): lets closeConsumersForUsername()
    // tear this stream down if the session is revoked while it's open — the
    // cross-replica session-revocation signal (auth-cache-bus's
    // {kind:'user-admin'}) keys on username, not this userId UUID.
    // targetDeviceSessionId: a device logout / revoke closes this device's
    // stream (oauth/device-session-liveness.ts → onDeviceSessionsRevoked).
    // Only for a device-flow JWT; a stream-token caller's session id is not
    // its own credential.
    const targetDeviceSessionId =
        event.locals.authMethod === 'bearer' && event.locals.deviceSessionId
            ? event.locals.deviceSessionId
            : undefined;
    const hubResponse = await userEventsHub.streamResponse(event, {
        targetUserId: userIdStr,
        targetUsername: username,
        ...(targetDeviceSessionId ? { targetDeviceSessionId } : {}),
    });
    if (hubResponse.status !== 200) {
        return hubResponse;
    }
    // The consumer is registered now. A revoke that landed between auth and
    // registration (streamResponse awaits a Valkey slot) found nothing to
    // close; close it here instead of leaving the stream open.
    if (targetDeviceSessionId && isDeviceSessionTombstoned(targetDeviceSessionId)) {
        userEventsHub.closeConsumersForDeviceSessions([targetDeviceSessionId]);
    }

    // A device holding its stream can take live remote commands; say so (and
    // keep saying it, the marker lives 45 s) until the stream ends. Not for a
    // session revoked meanwhile: its stream was just closed above.
    if (targetDeviceSessionId && !isDeviceSessionTombstoned(targetDeviceSessionId)) {
        presenceDeviceSessionId = targetDeviceSessionId;
        void markDeviceStreamOpen(targetDeviceSessionId, streamToken).catch(() => {});
        streamPresenceTimer = setInterval(() => {
            if (presenceDeviceSessionId) {
                void markDeviceStreamOpen(presenceDeviceSessionId, streamToken).catch(() => {});
            }
        }, STREAM_PRESENCE_REFRESH_MS);
        streamPresenceTimer.unref?.();
    }
    const hubStream = hubResponse.body;
    if (!hubStream) {
        return ApiProblem.internalError('Failed to open event stream');
    }

    // Extra stream for EventEmitter-sourced frames (admin + watch-state).
    // It stays open as long as the connection is alive; cancel() tears it down.
    const extraStream = new ReadableStream<Uint8Array>({
        start(controller) {
            extraController = controller;

            maintenanceNoticeListener = (notice: MaintenanceNoticeFrame) => {
                sendExtra('admin', { type: 'maintenance_notice', ...notice });
            };
            maintenanceClearedListener = () => {
                sendExtra('admin', { type: 'maintenance_cleared' });
            };
            adminMessageListener = (payload: unknown) => {
                if (
                    payload &&
                    typeof payload === 'object' &&
                    'type' in payload &&
                    (payload as { type?: unknown }).type === 'admin_message'
                ) {
                    // Owner check only — the stream is per-user, so narrowing
                    // to ONE of that user's clients is the frame's job
                    // (`playSessionId` / `deviceId`), done client-side.
                    if (
                        !shouldDeliverAdminMessageToUserId(
                            payload as AdminMessagePayload,
                            userIdStr,
                        )
                    ) {
                        return;
                    }
                }
                sendExtra('admin', payload);
            };

            adminEvents.on('maintenance_notice', maintenanceNoticeListener);
            adminEvents.on('maintenance_cleared', maintenanceClearedListener);
            adminEvents.on('admin_message_broadcast', adminMessageListener);

            watchStateUnsubscribe = watchStateEvents.subscribe(userId, (evt) => {
                // Watch changes arrive once through the cross-pod hub, including
                // those produced by workers. Session signals remain local.
                if (evt.type === 'session_changed') sendExtra(evt.type, evt);
            });

            // Replay current maintenance state on connect so reconnecting
            // clients converge immediately without waiting for the next event.
            void getActiveMaintenanceNotice()
                .then((notice) => {
                    if (extraClosed) return;
                    if (notice) {
                        sendExtra('admin', {
                            type: 'maintenance_notice',
                            ...withRemaining(notice),
                        });
                    } else {
                        sendExtra('admin', { type: 'maintenance_cleared' });
                    }
                })
                .catch(() => {
                    /* non-fatal */
                });
        },
        cancel() {
            cleanupListeners();
        },
    });

    // Bootstrap connected frame — sent once, immediately.
    const bootstrapChunk = encoder.encode(
        `event: connected\ndata: ${JSON.stringify({ serverTime: Date.now() })}\n\n`,
    );

    // Merged output stream: emits bootstrap first, then concurrently drains
    // hub and extra, forwarding all chunks to the client.
    const merged = new ReadableStream<Uint8Array>({
        start(controller) {
            // Emit the bootstrap frame immediately.
            controller.enqueue(bootstrapChunk);

            const hubReader = hubStream.getReader();
            const extraReader = extraStream.getReader();

            let done = false;

            function close() {
                if (done) return;
                done = true;
                cleanupListeners();
                hubReader.cancel().catch(() => {});
                extraReader.cancel().catch(() => {});
                try {
                    controller.close();
                } catch {
                    /* already closed */
                }
            }

            event.request.signal.addEventListener('abort', close);

            // Pump hub frames
            function pumpHub() {
                hubReader
                    .read()
                    .then(({ value, done: d }) => {
                        if (d || done) {
                            close();
                            return;
                        }
                        try {
                            controller.enqueue(value);
                        } catch {
                            close();
                            return;
                        }
                        pumpHub();
                    })
                    .catch(() => close());
            }

            // Pump extra frames
            function pumpExtra() {
                extraReader
                    .read()
                    .then(({ value, done: d }) => {
                        if (d || done) {
                            close();
                            return;
                        }
                        try {
                            controller.enqueue(value);
                        } catch {
                            close();
                            return;
                        }
                        pumpExtra();
                    })
                    .catch(() => close());
            }

            pumpHub();
            pumpExtra();
        },
        cancel() {
            cleanupListeners();
        },
    });

    return new Response(merged, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        },
    });
}

/**
 * Wire documentation for the frames this endpoint emits.
 *
 * SSE bodies cannot be typed structurally in OpenAPI (the response is one
 * long `text/event-stream`), so the frame shapes are published as named
 * component schemas for every direct payload and hub envelope, registered in
 * `scripts/openapi/sse-frames.ts`. A generated client therefore gets the
 * decodable types even though the transport stays a string, and this
 * description is what points at them.
 *
 * Kept as a const rather than inlined because it is long, and because the
 * frame contract is the thing third-party clients build against — it deserves
 * to be findable.
 */
const EVENTS_DESCRIPTION = [
    'Opens a persistent Server-Sent Events (SSE) connection for the authenticated user.',
    'Keepalive `: ping` comments every ~10 s. `EventSource` reconnects on its own.',
    '',
    '### Frames',
    '',
    'Every frame is `event: <name>` + a JSON `data:` line. `name` is the literal SSE',
    'event field — subscribe to it verbatim. The per-install list is advertised at',
    '`GET /server` → `capabilities.events.kinds[].name`.',
    '',
    '| `event:` | `data` schema | Class |',
    '| --- | --- | --- |',
    '| `connected` | `SseConnectedFrame` | bootstrap, sent once immediately |',
    '| `admin` | `SseAdminMessageFrame` \\| `SseMaintenanceNoticeFrame` \\| `SseMaintenanceClearedFrame` | signal |',
    '| `device.command` | `SseDeviceCommandFrame` | signal |',
    '| `device.command_cancelled` | `SseDeviceCommandCancelledFrame` | signal |',
    '| `device.command_status` | `SseDeviceCommandStatusFrame` | signal |',
    '| `device.state` | `SseDeviceStateFrame` | signal |',
    '| `session_changed` | `SseSessionChangedFrame` | signal |',
    '| `watch_state_set_changed` | `SseWatchStateSetChangedFrame` | signal |',
    '| `library.new_episode` | `SseLibraryNewEpisodeFrame` | durable — also in `GET /notifications` |',
    '| `request.available` | `SseRequestAvailableFrame` | durable — also in `GET /notifications` |',
    '| `admin.broadcast` | `SseAdminBroadcastFrame` | durable — also in `GET /notifications` |',
    '| `jellyfin.readonly_token` | `SseJellyfinReadonlyTokenFrame` | durable — also in `GET /notifications` |',
    '',
    '### `event: admin` — one event name, three payloads',
    '',
    'Discriminate on `data.type`, whose complete value list is',
    '`admin_message` | `maintenance_notice` | `maintenance_cleared`. There is no',
    'other value and no other `event:` name for these features.',
    '',
    '- **`admin_message`** (`SseAdminMessageFrame`) — a perishable toast an operator',
    '  sent from the admin Active Sessions view. `severity` is ADVISORY: it selects a',
    '  colour and must never decide whether the message is shown, and a value outside',
    '  `info` | `warning` | `error` MUST decode as `info` rather than failing the',
    '  frame. `durationMs` is advisory too — clamp it to whatever your transport can',
    '  honour. `message` is operator-typed free text and is rendered VERBATIM; it is',
    '  not localisable.',
    '- **`maintenance_notice`** (`SseMaintenanceNoticeFrame`) — the pinned banner.',
    '  `endsAt` (epoch ms, UTC) is the canonical absolute end instant; `endsAtIso` is',
    '  the same instant as ISO-8601; `remainingMs` is computed at delivery time for',
    '  clients whose clock disagrees with the server. Render the countdown yourself',
    '  from `endsAt` — the server never sends a formatted duration string.',
    '- **`maintenance_cleared`** (`SseMaintenanceClearedFrame`) — no notice is in',
    '  effect. Sent on cancellation AND on connect when none is active, so a client',
    '  that missed a cancellation while disconnected still converges.',
    '',
    '### Targeting: this stream is per-USER, not per-client',
    '',
    'One user can have several clients connected (two Apple TVs, a phone, a browser)',
    'and the server cannot tell their connections apart. So an `admin_message` names',
    'its target on the frame and the CLIENT filters:',
    '',
    '- `playSessionId` / `deviceId` **absent** → render on every client of this user.',
    '  This is the broadcast case, and it is what `maintenance_notice` always is.',
    '- `playSessionId` **present** → render only where it equals the play session this',
    '  client owns. `deviceId`, when present, identifies the same target by device and',
    '  can be matched instead by a client that does not track its play-session id.',
    '',
    'Ignoring the fields shows one extra toast on a second device; honouring them is',
    'correct. Both are better than dropping the message.',
    '',
    '### Replay, and what is NOT replayed',
    '',
    'Hub frames use `{targetUserId, targetDeviceSessionId?, replay?, kind, data, notificationId?}`',
    'and carry a numeric SSE `id:`. Reconnect with `Last-Event-ID` to replay from a shared',
    '500-entry, 1 h Valkey ring, filtered per recipient (not 500 entries per user).',
    '`device.command` and `device.command_cancelled` target one device and are never',
    'replayed; catch up with `GET /devices/{id}/commands`. `device.state` and',
    '`device.command_status` carry `replay: false` and are also never replayed.',
    '`connected`, `admin`, `session_changed` and `watch_state_set_changed` are direct,',
    'unnumbered frames and never replayed. `: ping` is a comment, not an event.',
    '',
    '**`event: admin` frames carry no `id:` and are never replayed.** Deliberate: a',
    'toast written for the moment ("restarting in five minutes") replayed forty',
    'minutes later is worse than a dropped one, and a message sent to a session that',
    'is mid-reconnect is DROPPED, not queued. Current maintenance STATE is not lost',
    'that way — it is re-sent as a snapshot frame right after `connected`, and can be',
    'read over HTTP at `GET /server/notice` at any time.',
    '',
    '### Durability',
    '',
    '`admin_message` and the maintenance frames NEVER write a durable row and carry no',
    '`notificationId`; they will not appear in `GET /notifications`, so an inbox can',
    'render them without double-showing anything. The durable operator announcement is',
    'the separate `admin.broadcast` notification kind, which does carry a',
    '`notificationId` and does appear in the inbox.',
].join('\n');

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Events'],
            summary: 'Subscribe to the per-user SSE event stream',
            // Promoted from 'beta' when the frame contract above was frozen and
            // published as component schemas. Evolution is additive only: new
            // `event:` names and new optional fields may appear (a client must
            // ignore what it does not know), but no published frame changes
            // shape and no `data.type` value is removed or repurposed.
            stability: 'stable',
            auth: 'bearer',
            description: EVENTS_DESCRIPTION,
            responses: {
                200: {
                    sse: true,
                    description:
                        'SSE stream — `text/event-stream`. Frame payloads are the ' +
                        '`Sse*Frame` component schemas; see the operation description.',
                },
                401: 'Authentication required',
                429: 'Per-user SSE connection limit reached — too many concurrent streams for this user',
                500: 'Internal server error',
                503: {
                    description: 'Process-wide SSE connection capacity reached — try again shortly',
                    code: 'stream_limit',
                },
            },
        },
    },

    auth: { kind: 'user' },
    raw: true, // SSE = Class R response
    // P1: bound CONNECT churn (not concurrency — that's streamResponse()'s
    // per-user ceiling inside the hub). A client that reconnect-loops still
    // costs a connection setup + Valkey/pubsub wiring even when each one is
    // short-lived.
    rateLimit: {
        limit: 30,
        windowSec: 60,
        keyBy: (event) =>
            `sse-connect:events:${event.locals.principal?.username ?? event.locals.user?.username ?? 'anonymous'}`,
    },
    handlers: {
        GET: handleGet,
    },
});
