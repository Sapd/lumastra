// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/server/notice/index.ts — GET /api/v1/server/notice
 *
 * The currently in-effect maintenance notice, or `null`.
 *
 * ============================================================================
 * WHY A READ PATH EXISTS FOR SOMETHING THAT IS ALSO AN EVENT
 * ============================================================================
 * "A persistent banner with a live countdown" is STATE, and an event cannot
 * deliver state. A client that launches — or returns from background, which
 * for a mobile app is the normal case and not an edge case — after the
 * broadcast must still show the banner for the remainder of the window, and an
 * SSE frame it never received cannot tell it that.
 *
 * `GET /events` does re-send a snapshot frame right after `event: connected`,
 * which covers a client that keeps a stream open. This endpoint covers the
 * ones that do not, and gives every client a way to answer the question
 * without holding a connection at all — a tvOS app checking on foreground, a
 * third-party dashboard polling, a script.
 *
 * **Both read the same Valkey key, so they cannot disagree about the facts.**
 * If they ever appear to, this endpoint is authoritative: it is a point-in-time
 * read of server state, whereas a frame is a push that may have been in flight
 * when the notice changed.
 *
 * Kept separate from `GET /server`: discovery describes the installation,
 * while a notice is moment-state and uses no-store so countdowns stay current.
 *
 * Auth: {kind:'user'} — the notice is not a secret, but this is not a
 * pre-auth surface either, and every client that can play can already
 * authenticate.
 *
 * Cache-Control: `no-store`. The body changes the moment an operator starts or
 * cancels a notice and carries a live countdown; there is no correct positive
 * max-age for it.
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { typedJson } from '$lib/server/utils/typed-response.js';
import {
    getActiveMaintenanceNotice,
    withRemaining,
} from '$lib/server/services/play-session-events.service.js';

const MaintenanceNoticeBodySchema = z.object({
    id: z.string().meta({
        description:
            'Notice id, stable for the lifetime of one notice. Matches the `id` on the ' +
            '`maintenance_notice` SSE frame, so a client can tell "same notice" from "new ' +
            'notice" across a reconnect.',
    }),
    message: z
        .string()
        .meta({ description: 'Operator-typed free text, rendered verbatim. Not localisable.' }),
    endsAt: z
        .number()
        .int()
        .meta({
            description:
                'CANONICAL end instant, epoch milliseconds UTC. Absolute, so a client that ' +
                'connects mid-window can still compute the remaining time. Render the countdown ' +
                'in the viewer locale yourself.',
        }),
    endsAtIso: z.string().meta({
        description: 'The same instant as `endsAt`, ISO-8601. `endsAt` remains canonical.',
    }),
    remainingMs: z
        .number()
        .int()
        .meta({
            description:
                'Milliseconds left, computed when this response was built. For clients whose ' +
                'clock disagrees with the server. Do not persist it.',
        }),
    createdBy: z.string().meta({ description: 'Username of the operator who started it.' }),
    createdAt: z
        .number()
        .int()
        .meta({ description: 'When the notice was created, epoch milliseconds.' }),
});

const ServerNoticeResponseSchema = z.object({
    notice: MaintenanceNoticeBodySchema.nullable().meta({
        description: 'The in-effect notice, or `null` when none is active.',
    }),
});

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Server'],
            summary: 'Get the active maintenance notice',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Returns the maintenance notice currently in effect, or `null`. This is the ' +
                'read path for state that `GET /events` also pushes as an `event: admin` / ' +
                '`maintenance_notice` frame — call it on launch and on foreground so a ' +
                'client that was not connected when the notice was broadcast still shows ' +
                'the banner for the remainder of the window. Both read the same state; this ' +
                'endpoint is authoritative if they ever appear to disagree. ' +
                'A notice cannot be extended in place — an operator clears and re-issues, ' +
                'which yields a new `id`. `Cache-Control: no-store`.',
            responses: {
                200: {
                    schema: ServerNoticeResponseSchema,
                    description: 'The active notice, or `{ "notice": null }`',
                },
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },
    raw: false,
    handlers: {
        GET: async () => {
            // Returns null both when no key exists and when a stored notice has
            // already passed its endsAt — a client never has to decide whether
            // an expired notice still counts.
            const notice = await getActiveMaintenanceNotice();

            return typedJson(
                ServerNoticeResponseSchema,
                { notice: notice ? withRemaining(notice) : null },
                { headers: { 'Cache-Control': 'no-store' } },
            );
        },
    },
});
