// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * sse-frames.ts — published component schemas for the SSE frames a client
 * decodes off `GET /api/v1/events`.
 *
 * ============================================================================
 * WHY THESE LIVE IN THE SPEC AT ALL
 * ============================================================================
 * An SSE response body cannot be typed structurally in OpenAPI: it is one long
 * `text/event-stream`, so `responses.200` is a string and always will be. That
 * left the whole admin/maintenance wire protocol undocumented — no `event:`
 * names, no discriminator, no field sets — and a client team could not code
 * against it without reading our source.
 *
 * Registering the frames as NAMED COMPONENT SCHEMAS fixes that without lying
 * about the transport: the body stays a string, and generated clients still get
 * decodable model types (Swift/TypeScript generators emit every entry under
 * `components.schemas`, referenced or not). The operation description in
 * `defs/events/index.ts` is what ties an `event:` name to a schema name.
 *
 * ============================================================================
 * SHAPES ARE FROZEN; EVOLUTION IS ADDITIVE ONLY
 * ============================================================================
 * New `event:` names and new OPTIONAL fields may appear — a client must ignore
 * what it does not recognise. A published frame does not change shape, and a
 * `data.type` value is never removed or repurposed.
 *
 * Hence `z.looseObject` and not `z.object`: the latter renders
 * `additionalProperties: false`, which turns "a client must ignore unknown
 * fields" into "a strict validator REJECTS the frame the moment the server adds
 * one" — the exact opposite of the compatibility promise above.
 *
 * `unusedIO: 'output'` on every schema: these are server→client payloads and
 * no operation references them, so zod-openapi has to be told which direction
 * to render or it would emit request-shaped variants.
 *
 * Keep these in agreement with the runtime producers:
 *   - `AdminMessagePayload` / `MaintenanceNoticeFrame` in
 *     `src/lib/server/services/play-session-events.service.ts`
 *   - the `sendExtra('admin', …)` calls in `src/lib/server/api/defs/events/index.ts`
 */

import { z } from 'zod';
import { DeviceCommandSchema, DeviceStateSchema } from '../../src/lib/schemas/device-commands';

/** Bootstrap frame — `event: connected`, sent once on connect. */
export const SseConnectedFrame = z
    .looseObject({
        serverTime: z
            .number()
            .int()
            .meta({
                description:
                    "Server clock at connect, epoch milliseconds. Anchor your countdowns' " +
                    'clock skew against this rather than trusting the device clock.',
                example: 1757664000000,
            }),
    })
    .meta({
        id: 'SseConnectedFrame',
        unusedIO: 'output',
        description:
            'Payload of the `event: connected` frame on `GET /events`. Sent immediately ' +
            'and exactly once per connection, before any other frame.',
    });

/**
 * `event: admin`, `data.type = "admin_message"` — the perishable operator toast.
 */
export const SseAdminMessageFrame = z
    .looseObject({
        type: z.literal('admin_message').meta({
            description:
                'Discriminator for the `event: admin` frame. Complete value list: ' +
                '`admin_message`, `maintenance_notice`, `maintenance_cleared`.',
        }),
        id: z.string().meta({
            description:
                'Stable per-broadcast id. The same message can arrive on BOTH the per-user ' +
                'stream and the session-scoped `GET /play-sessions/{id}/events` stream — ' +
                'de-duplicate on this before showing it.',
            example: '6f1c0f8e-3b2a-4d51-9a77-2b0f9c1d4e55',
        }),
        message: z.string().meta({
            description:
                'Operator-typed free text, rendered VERBATIM. Not localisable and never ' +
                'pre-formatted by the server — no duration strings, no interpolation.',
            example: 'The server restarts in 5 minutes — your stream will resume after.',
        }),
        severity: z.string().meta({
            description:
                'ADVISORY colour hint. Current values: `info`, `warning`, `error`. Typed as ' +
                'an open string on purpose: a value outside that set MUST decode as `info` ' +
                'rather than failing the frame, and severity must never decide WHETHER the ' +
                'message is shown.',
            example: 'warning',
        }),
        durationMs: z
            .number()
            .int()
            .optional()
            .meta({
                description:
                    'Advisory display duration in milliseconds. Clamp it to what your transport ' +
                    'can honour — a player is not expected to hold focus or defer an auto-hide ' +
                    'because of a server-sent value.',
                example: 8000,
            }),
        playSessionId: z
            .string()
            .optional()
            .meta({
                description:
                    'The play session this message is FOR. ABSENT means every client of this ' +
                    'user should render it; PRESENT means render only where it equals the play ' +
                    'session this client owns. The stream is per-user, so this is the only way ' +
                    'to address one of several signed-in clients.',
            }),
        deviceId: z
            .string()
            .optional()
            .meta({
                description:
                    'The device the target session belongs to. Present alongside ' +
                    '`playSessionId` for a session-targeted message, and on its own for a ' +
                    'device-targeted message with no active playback. A client that does not ' +
                    'track its play-session id can filter on this instead.',
            }),
        sentBy: z.string().meta({
            description: 'Username of the operator who sent it.',
            example: 'admin',
        }),
        sentAt: z
            .number()
            .int()
            .meta({
                description:
                    'Send time, epoch milliseconds. Use it to drop a stale message — the web ' +
                    'client ignores anything older than 60 s.',
                example: 1757664000000,
            }),
    })
    .meta({
        id: 'SseAdminMessageFrame',
        unusedIO: 'output',
        description:
            'A perishable admin toast. NEVER durable: it writes no row, carries no ' +
            '`notificationId`, never appears in `GET /notifications`, and is never replayed ' +
            'on `Last-Event-ID`. A message sent to a session that is mid-reconnect is ' +
            'DROPPED, not queued. The durable operator announcement is the separate ' +
            '`admin.broadcast` notification kind.',
    });

/** `event: admin`, `data.type = "maintenance_notice"` — the pinned banner. */
export const SseMaintenanceNoticeFrame = z
    .looseObject({
        type: z.literal('maintenance_notice').meta({
            description: 'Discriminator for the `event: admin` frame.',
        }),
        id: z.string().meta({
            description:
                'Notice id. Stable for the lifetime of one notice, including across the ' +
                'snapshot frame re-sent on every reconnect — so a client can tell "the same ' +
                'notice again" from "a new notice".',
        }),
        message: z.string().meta({
            description: 'Operator-typed free text, rendered verbatim.',
            example: 'Scheduled maintenance — playback may be interrupted.',
        }),
        endsAt: z
            .number()
            .int()
            .meta({
                description:
                    'CANONICAL end instant, epoch milliseconds UTC. Absolute, not relative, so ' +
                    'a client that connects or reconnects mid-notice can still compute the ' +
                    'remaining time. Render the countdown in the viewer locale yourself.',
                example: 1757665800000,
            }),
        endsAtIso: z.string().meta({
            description:
                'The same instant as `endsAt`, ISO-8601. Provided for clients whose decoder ' +
                'maps a date string onto a native date type; `endsAt` remains canonical.',
            example: '2026-09-12T10:30:00.000Z',
        }),
        remainingMs: z
            .number()
            .int()
            .meta({
                description:
                    'Milliseconds left, computed at DELIVERY time on the pod that sent the ' +
                    'frame. A convenience for clients whose clock disagrees with the server. ' +
                    'Do not persist it; it is only valid at the moment of receipt.',
                example: 1800000,
            }),
        createdBy: z.string().meta({ description: 'Username of the operator who started it.' }),
        createdAt: z.number().int().meta({
            description: 'When the notice was created, epoch milliseconds.',
        }),
    })
    .meta({
        id: 'SseMaintenanceNoticeFrame',
        unusedIO: 'output',
        description:
            'An in-effect maintenance notice. Always a broadcast — it carries no ' +
            '`playSessionId`/`deviceId` and applies to every client of every user. ' +
            'Re-sent as a snapshot immediately after `event: connected` whenever one is ' +
            'active, so a client that launches mid-window still shows the banner. ' +
            'A notice cannot be EXTENDED or replaced in place: a second one is refused ' +
            'with 409 while the first holds, so the operator clears and re-issues — which ' +
            'a client sees as `maintenance_cleared` followed by a new notice with a new `id`. ' +
            'Also readable over HTTP at `GET /server/notice`.',
    });

/** `event: admin`, `data.type = "maintenance_cleared"` — no notice in effect. */
export const SseMaintenanceClearedFrame = z
    .looseObject({
        type: z.literal('maintenance_cleared').meta({
            description: 'Discriminator for the `event: admin` frame.',
        }),
    })
    .meta({
        id: 'SseMaintenanceClearedFrame',
        unusedIO: 'output',
        description:
            'No maintenance notice is in effect — hide the banner. Sent when an operator ' +
            'cancels a notice, AND on connect when none is active. That second case is why ' +
            'the frame exists: a client that missed a cancellation while disconnected would ' +
            'otherwise keep a stale banner pinned until `endsAt` elapsed.',
    });

/** Direct watch-state signals are unnumbered and are never replayed. */
export const SseSessionChangedFrame = z
    .looseObject({
        type: z.literal('session_changed'),
        sessionId: z.string(),
        status: z.string(),
        mediaId: z.string(),
        at: z.number(),
    })
    .meta({ id: 'SseSessionChangedFrame', unusedIO: 'output' });

export const SseWatchStateSetChangedFrame = z
    .looseObject({
        type: z.literal('watch_state_set_changed'),
        mediaId: z.string(),
        reason: z.string(),
        at: z.number(),
    })
    .meta({ id: 'SseWatchStateSetChangedFrame', unusedIO: 'output' });

/** The JSON data line of a hub frame contains this routing envelope. */
const hubEnvelope = {
    targetUserId: z.string(),
    targetDeviceSessionId: z.string().optional(),
    replay: z.literal(false).optional(),
    notificationId: z
        .string()
        .optional()
        .describe('Present only when a durable notification row was persisted.'),
};

export const SseDeviceCommandFrame = z
    .looseObject({
        ...hubEnvelope,
        targetDeviceSessionId: z.string(),
        kind: z.literal('device.command'),
        data: DeviceCommandSchema,
    })
    .meta({ id: 'SseDeviceCommandFrame', unusedIO: 'output' });

export const SseDeviceCommandCancelledFrame = z
    .looseObject({
        ...hubEnvelope,
        targetDeviceSessionId: z.string(),
        kind: z.literal('device.command_cancelled'),
        data: z.looseObject({ id: z.string() }),
    })
    .meta({ id: 'SseDeviceCommandCancelledFrame', unusedIO: 'output' });

export const SseDeviceCommandStatusFrame = z
    .looseObject({
        ...hubEnvelope,
        replay: z.literal(false),
        kind: z.literal('device.command_status'),
        data: DeviceCommandSchema,
    })
    .meta({ id: 'SseDeviceCommandStatusFrame', unusedIO: 'output' });

export const SseDeviceStateFrame = z
    .looseObject({
        ...hubEnvelope,
        replay: z.literal(false),
        kind: z.literal('device.state'),
        data: DeviceStateSchema,
    })
    .meta({ id: 'SseDeviceStateFrame', unusedIO: 'output' });

export const SseLibraryNewEpisodeFrame = z
    .looseObject({
        ...hubEnvelope,
        kind: z.literal('library.new_episode'),
        data: z.looseObject({
            mediaId: z.string(),
            seriesId: z.string(),
            seriesTitle: z.string(),
            episodeTitle: z.string(),
            seasonNumber: z.number().nullable(),
            episodeNumber: z.number().nullable(),
            posterUrl: z.string(),
            coalesceKey: z.string(),
            reason: z.enum(['watching', 'watchlist', 'following']),
        }),
    })
    .meta({ id: 'SseLibraryNewEpisodeFrame', unusedIO: 'output' });

export const SseRequestAvailableFrame = z
    .looseObject({
        ...hubEnvelope,
        kind: z.literal('request.available'),
        data: z.looseObject({
            mediaId: z.string(),
            mediaType: z.enum(['movie', 'series']),
            title: z.string(),
            year: z.number().nullable(),
            posterUrl: z.string(),
            requestId: z.number(),
            coalesceKey: z.string(),
        }),
    })
    .meta({ id: 'SseRequestAvailableFrame', unusedIO: 'output' });

export const SseJellyfinReadonlyTokenFrame = z
    .looseObject({
        ...hubEnvelope,
        kind: z.literal('jellyfin.readonly_token'),
        data: z.looseObject({ linkUrl: z.string() }),
    })
    .meta({ id: 'SseJellyfinReadonlyTokenFrame', unusedIO: 'output' });

export const SseAdminBroadcastFrame = z
    .looseObject({
        ...hubEnvelope,
        kind: z.literal('admin.broadcast'),
        data: z.looseObject({
            broadcastId: z.string(),
            title: z.string(),
            body: z.string().optional(),
            linkUrl: z.string().optional(),
        }),
    })
    .meta({ id: 'SseAdminBroadcastFrame', unusedIO: 'output' });

/**
 * Registered by generate.ts in both documents. Keep the three admin variants
 * individually named: nesting registered members in an output union can create
 * duplicate *Output components. The endpoint documents discrimination on type.
 */
export const SSE_FRAME_SCHEMAS = {
    SseConnectedFrame,
    SseAdminMessageFrame,
    SseMaintenanceNoticeFrame,
    SseMaintenanceClearedFrame,
    SseSessionChangedFrame,
    SseWatchStateSetChangedFrame,
    SseDeviceCommandFrame,
    SseDeviceCommandCancelledFrame,
    SseDeviceCommandStatusFrame,
    SseDeviceStateFrame,
    SseLibraryNewEpisodeFrame,
    SseRequestAvailableFrame,
    SseAdminBroadcastFrame,
    SseJellyfinReadonlyTokenFrame,
} as const;
