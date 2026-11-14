// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/devices/index.ts — GET /devices?scope=mine
 *
 * GET /devices?scope=mine
 *   Returns all device sessions for the authenticated user, enriched with
 *   live presence data from Valkey (heartbeat state).  Query params:
 *     - scope: currently only "mine" (reserved for future scope=all admin view)
 *     - onlineOnly: boolean — filter to only online devices
 *     - watchTogether: boolean — filter to only Watch-Together-capable devices
 *
 * Auth: feature:DEVICE_AUTH → user
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { parsePagination } from '$lib/server/utils/pagination.js';
import { getDb } from '$lib/server/database/connection.js';
import { getUserDevices } from '$lib/server/services/user-devices.service.js';
import { listExternalRemoteDevices } from '$lib/server/services/external-remote-targets.js';

import { DevicesListResponseSchema } from '$lib/schemas/devices.js';

// ---------------------------------------------------------------------------
// Request contract schemas
// ---------------------------------------------------------------------------

/**
 * Combined query schema for GET + DELETE /devices.
 *
 * All fields are optional so neither method rejects the other's calls.
 * Booleans arrive as strings from URLSearchParams; the handler re-evaluates
 * them as `=== 'true'`. The DELETE handler validates `id` presence itself.
 * Unknown fields are stripped (no .strict()).
 */
const DevicesQuery = z.object({
    /** GET: currently only "mine" — reserved for future admin scope=all */
    scope: z.string().optional(),
    /** GET: filter to only online devices */
    onlineOnly: z.enum(['true', 'false']).optional(),
    /** GET: filter to Watch-Together-capable devices */
    watchTogether: z.enum(['true', 'false']).optional(),
    /** GET: pagination — coercion only; parsePagination() clamps in the handler. */
    limit: z.coerce.number().int().optional(),
    offset: z.coerce.number().int().optional(),
    /** DELETE: device session ID to revoke */
    id: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Alias for clarity in this file

// ---------------------------------------------------------------------------
// Endpoint definition
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Devices'],
            summary: 'List device sessions',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Returns all device sessions for the authenticated user, enriched with live ' +
                'presence data from Valkey (heartbeat state). Requires `FEATURE_DEVICE_AUTH`. ' +
                'Sessions are sorted: online first, then by most recent activity. ' +
                '?onlineOnly=true — filter to online devices only. ' +
                '?watchTogether=true — filter to Watch-Together-capable devices.',
            query: z.object({
                onlineOnly: z
                    .enum(['true', 'false'])
                    .optional()
                    .meta({ description: 'Filter to online devices only' }),
                watchTogether: z
                    .enum(['true', 'false'])
                    .optional()
                    .meta({ description: 'Filter to Watch-Together-capable devices' }),
                limit: z.coerce.number().optional(),
                offset: z.coerce.number().optional(),
            }),
            responses: {
                200: {
                    schema: DevicesListResponseSchema,
                    description: 'Paginated device session list',
                },
                401: 'Authentication required',
                404: 'Feature not enabled',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: {
        kind: 'feature',
        flag: 'DEVICE_AUTH',
        then: { kind: 'user' },
    },
    request: {
        query: DevicesQuery,
    },
    handlers: {
        /**
         * GET /devices?scope=mine
         *
         * Lists all device sessions belonging to the authenticated user,
         * enriched with live presence data from Valkey.
         */
        GET: async (event, _ctx) => {
            const { locals, url } = event;

            const { limit, offset } = parsePagination(url, { defaultLimit: 50, maxLimit: 200 });
            const onlineOnly = url.searchParams.get('onlineOnly') === 'true';
            const watchTogetherOnly = url.searchParams.get('watchTogether') === 'true';

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database not initialised');
            }

            const userId = locals.user!.userId;

            // Single read model — see services/user-devices.service.ts.
            //
            // This deliberately does NOT consult any Jellyfin table. Jellyfin is an
            // optional integration, so the device list must look identical whether it
            // is installed or not. The previous merge read the Jellyfin token table
            // first, which meant its stored credential string ("Lumastra - Wohnzimmer")
            // shadowed the real device name on every Jellyfin-enabled install, and the
            // list silently changed shape when the integration was toggled.
            let sessions = await getUserDevices(sql, userId, { withPresence: true });

            // Remote targets that are not Lumastra device sessions (Jellyfin
            // clients, id `jf:…`) list next to the real devices. Empty without
            // the module provider.
            const external = await listExternalRemoteDevices({
                userId: String(userId),
                username: locals.user!.username,
            });
            if (external.length) {
                // A date that does not parse sorts last instead of poisoning the comparator.
                const activity = (d: (typeof sessions)[number]): number => {
                    const t = new Date(d.lastHeartbeat ?? d.lastUsedAt ?? d.createdAt).getTime();
                    return Number.isFinite(t) ? t : 0;
                };
                sessions = [...sessions, ...external].sort((a, b) => {
                    if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
                    return activity(b) - activity(a);
                });
            }

            if (onlineOnly) {
                sessions = sessions.filter((s) => s.isOnline);
            }
            if (watchTogetherOnly) {
                sessions = sessions.filter((s) => s.supportsWatchTogether);
            }

            // Paginate: fetch limit + 1 to compute hasMore
            const paginatedSessions = sessions.slice(offset, offset + limit);
            const hasMore = sessions.length > offset + limit;

            return json(
                paginate(
                    paginatedSessions.map((device) =>
                        DevicesListResponseSchema.shape.items.element.parse(device),
                    ),
                    { limit, offset, hasMore, total: sessions.length },
                ),
            );
        },

        /**
         * DELETE /devices?id=<deviceSessionId>
         *
         * Revoke a device session (both OAuth + Jellyfin tokens).
         * Returns 204 on success.
         */
    },
});
