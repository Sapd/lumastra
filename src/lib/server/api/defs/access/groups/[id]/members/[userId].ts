// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/index.js';
import { getAccessGroupById } from '$lib/server/database/queries/access-groups.queries.js';
import {
    addMember,
    removeMember,
    groupConfersAdmin,
} from '$lib/server/services/access-control.service.js';
import { requireAdminCeiling } from '$lib/server/api/token-minting.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import { z } from 'zod';

const MemberParams = z.object({ id: z.string().guid(), userId: z.string().guid() });
export const def = defineEndpoint({
    docs: {
        PUT: {
            tags: ['Access'],
            summary: 'Add a member to an access group',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Ensures the user belongs to the access group. Repeating PUT is a no-op (204). Requires `access:admin` scope; admin-conferring groups retain the admin ceiling.',
            responses: {
                204: 'Member present',
                422: 'Invalid group or user identifier',
                401: 'Authentication required',
                403: 'Insufficient scope',
                404: 'Group or user not found',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        DELETE: {
            tags: ['Access'],
            summary: 'Remove a member from an access group',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Removes a user from the access group by `userId` (users.id UUID). ' +
                'Requires `access:admin` scope.',
            responses: {
                204: 'Member removed',
                422: 'Invalid or missing userId',
                401: 'Authentication required',
                403: 'Insufficient scope',
                404: 'Group or member not found',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },
    auth: { kind: 'scope', anyOf: ['access:admin'] },
    visibility: 'internal',
    request: { params: MemberParams },
    handlers: {
        PUT: async (event, ctx) => {
            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            const groupId = event.params.id ?? event.params.groupId ?? '';
            if (!groupId)
                return ApiProblem.validationFailed([{ field: 'id', message: 'Required' }]);

            const body = ctx.input?.params;
            if (!body?.userId) {
                return ApiProblem.validationFailed([{ field: 'userId', message: 'Required' }]);
            }

            // Admin ceiling (security review 2026-09-23 final fix wave, X1a):
            // adding a member to a group that already confers admin (capability
            // OR a config.ADMIN_GROUPS name — same predicate the last-admin
            // guards use) is itself a privilege grant to that user. This is
            // exactly the escalation chain X1 found: a demoted in-app admin's
            // stale `['admin']` token still carries `access:admin`, and
            // without this ceiling it could re-add itself to the group it was
            // just removed from. A non-admin `access:admin` delegate may still
            // manage NON-admin-conferring groups freely.
            const targetGroup = await getAccessGroupById(db, groupId);
            if (targetGroup && groupConfersAdmin(targetGroup)) {
                const ceilingErr = await requireAdminCeiling(
                    event,
                    'Only administrators can add a member to an admin-conferring group',
                );
                if (ceilingErr) return ceilingErr;
            }

            const assignedBy = event.locals.principal?.userId ?? event.locals.user?.userId ?? null;
            const result = await addMember(db, groupId, body.userId, assignedBy);

            if (!result.ok) {
                if (result.status === 404) return ApiProblem.notFound(result.message);
                if (result.status === 409) return ApiProblem.conflict(result.message);
                return ApiProblem.internalError(result.message);
            }

            auditLog('access_group.add_member', groupId, auditActor(event), {
                userId: body.userId,
            });

            return new Response(null, { status: 204 });
        },

        DELETE: async (event, ctx) => {
            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            const groupId = event.params.id ?? event.params.groupId ?? '';
            if (!groupId)
                return ApiProblem.validationFailed([{ field: 'id', message: 'Required' }]);

            const body = ctx.input?.params;
            if (!body?.userId) {
                return ApiProblem.validationFailed([{ field: 'userId', message: 'Required' }]);
            }

            const result = await removeMember(db, groupId, body.userId);

            if (!result.ok) {
                if (result.status === 404) return ApiProblem.notFound(result.message);
                if (result.status === 409) return ApiProblem.conflict(result.message);
                if (result.status === 403) return ApiProblem.forbidden(result.message);
                return ApiProblem.internalError(result.message);
            }

            auditLog('access_group.remove_member', groupId, auditActor(event), {
                userId: body.userId,
            });

            // 204 no-content — matches the documented DELETE response.
            return new Response(null, { status: 204 });
        },
    },
});
