// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/devices/grants/index.ts
 *   GET  /devices/grants — the people allowed to remote-control my devices
 *   POST /devices/grants — allow another user of this server (`{username}`)
 *
 * The household grant: an owner (e.g. an older viewer) lets a helper with an
 * account of their own send commands to her devices and read their state.
 * Design: docs/superpowers/specs/2026-10-16-device-remote-control-design.md.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    MAX_GRANTS_PER_OWNER,
    addGrantCapped,
    findUserByUsernameFolded,
    listGrantsByOwner,
} from '$lib/server/database/queries/device-control-grants.queries.js';
import { invalidateHelpersCache } from '$lib/server/services/device-commands.service.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import { grantWriteGate } from '../device-access.js';

export const GrantSchema = z.object({
    username: z.string(),
    createdAt: z.string().meta({ description: 'ISO-8601 timestamp' }),
});

const GrantsResponseSchema = z.object({ items: z.array(GrantSchema) });

const AddGrantBody = z.object({
    username: z.string().trim().min(1).max(128),
});

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Devices'],
            summary: 'People allowed to control my devices',
            stability: 'beta',
            auth: 'bearer',
            description:
                'The users who may send commands to your devices and read their state ' +
                '(household grant). They sign in with their own account.',
            responses: {
                200: { schema: GrantsResponseSchema, description: 'Grants' },
                401: 'Authentication required',
                503: 'Database unavailable',
            },
        },
        POST: {
            tags: ['Devices'],
            summary: 'Allow a user to control my devices',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Lets another user of this server remote-control all your devices. The username ' +
                'is matched case-insensitively. 201 when new, 200 when already allowed (with the ' +
                'original `createdAt`). At most 20 people. Needs a signed-in session: ' +
                'every API token, device token and service token is refused (403, reason session_required). 10 changes a minute.',
            body: AddGrantBody,
            responses: {
                200: { schema: GrantSchema, description: 'Already allowed' },
                201: { schema: GrantSchema, description: 'Allowed' },
                401: 'Authentication required',
                403: 'Session required: API tokens, device tokens and service tokens cannot change grants (reason session_required)',
                404: 'No such user',
                422: 'Validation failed (including your own username, or more than 20 people)',
                429: 'Too many changes',
                503: 'Database unavailable',
            },
        },
    },
    auth: { kind: 'feature', flag: 'DEVICE_AUTH', then: { kind: 'user' } },
    request: { body: AddGrantBody },
    handlers: {
        GET: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not initialised');
            const rows = await listGrantsByOwner.all(sql, {
                ownerUserId: String(event.locals.user!.userId),
            });
            return json(
                {
                    items: rows.map((r) => ({
                        username: r.username,
                        createdAt: new Date(r.created_at).toISOString(),
                    })),
                },
                { headers: { 'Cache-Control': 'no-store' } },
            );
        },

        POST: async (event, ctx) => {
            const denied = await grantWriteGate(event);
            if (denied) return denied;
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not initialised');
            const me = event.locals.user!;
            const target = await findUserByUsernameFolded(sql, ctx.input!.body.username);
            if (!target) return ApiProblem.notFound('No such user');
            if (target.id === String(me.userId)) {
                return ApiProblem.validationFailed([
                    { field: 'username', message: 'You cannot allow yourself' },
                ]);
            }
            const added = await addGrantCapped(sql, {
                ownerUserId: String(me.userId),
                granteeUserId: target.id,
            });
            if (added.status === 'limit' || !added.createdAt) {
                return ApiProblem.validationFailed([
                    {
                        field: 'username',
                        message: `You can allow at most ${MAX_GRANTS_PER_OWNER} people`,
                    },
                ]);
            }
            if (added.status === 'added') {
                invalidateHelpersCache(String(me.userId));
                auditLog('device.grant.add', target.username, auditActor(event), {
                    owner: me.username,
                    grantee: target.username,
                });
            }
            return json(
                {
                    username: target.username,
                    createdAt: new Date(added.createdAt).toISOString(),
                },
                { status: added.status === 'added' ? 201 : 200 },
            );
        },
    },
});
