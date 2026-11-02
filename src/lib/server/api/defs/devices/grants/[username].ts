// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/devices/grants/[username].ts
 *   DELETE /devices/grants/{username} — stop allowing a user to control my devices
 *
 * Takes effect on the helper's next request: every command and state call
 * reads the grant from the database. Commands the helper still has waiting on
 * the owner's devices are cancelled, and the live state frames stop at once.
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    findUserByUsernameFolded,
    removeGrant,
} from '$lib/server/database/queries/device-control-grants.queries.js';
import {
    cancelCommandsFromSender,
    invalidateHelpersCache,
} from '$lib/server/services/device-commands.service.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import { grantWriteGate } from '../device-access.js';

export const def = defineEndpoint({
    docs: {
        DELETE: {
            tags: ['Devices'],
            summary: 'Stop allowing a user to control my devices',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Removes the household grant and cancels the commands that user still has ' +
                'waiting on your devices. The username is matched case-insensitively. Needs a ' +
                'signed-in session (every API token, device token and service token is refused). ' +
                '10 changes a minute.',
            responses: {
                204: 'Removed',
                401: 'Authentication required',
                403: 'Session required: API tokens, device tokens and service tokens cannot change grants (reason session_required)',
                429: 'Too many changes',
                404: 'No such user or grant',
                503: 'Database unavailable',
            },
        },
    },
    auth: { kind: 'feature', flag: 'DEVICE_AUTH', then: { kind: 'user' } },
    request: { params: z.object({ username: z.string().min(1).max(128) }) },
    handlers: {
        DELETE: async (event, ctx) => {
            const denied = await grantWriteGate(event);
            if (denied) return denied;
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not initialised');
            const me = event.locals.user!;
            const target = await findUserByUsernameFolded(sql, ctx.input!.params.username);
            if (!target) return ApiProblem.notFound('No such user or grant');
            const removed = await removeGrant.execute(sql, {
                ownerUserId: String(me.userId),
                granteeUserId: target.id,
            });
            if (removed.length === 0) return ApiProblem.notFound('No such user or grant');
            invalidateHelpersCache(String(me.userId));
            await cancelCommandsFromSender(String(me.userId), target.id);
            auditLog('device.grant.remove', target.username, auditActor(event), {
                owner: me.username,
                grantee: target.username,
            });
            return new Response(null, { status: 204 });
        },
    },
});
