// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** GET /access/groups/{id}/members — membership collection (access:admin). */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/index.js';
import {
    listAccessGroupMembers,
    type AccessGroupMemberRow,
} from '$lib/server/database/queries/access-groups.queries.js';
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { AccessGroupMemberSchema, type AccessGroupMember } from '$lib/schemas/api-admin-access.js';

// mapMemberRow emits userId/username/displayName?/assignedAt/assignedBy? — the
// previous local schema instead required a `joinedAt` the mapper never emits and
// omitted the three fields it does. Reuse the canonical AccessGroupMemberSchema.
const MembersListResponseSchema = z.object({
    items: z.array(AccessGroupMemberSchema),
    page: z.object({
        limit: z.number().int(),
        offset: z.number().int(),
        hasMore: z.boolean(),
    }),
});

// ---------------------------------------------------------------------------
// Mapper
// ---------------------------------------------------------------------------

function mapMemberRow(row: AccessGroupMemberRow): AccessGroupMember {
    return {
        userId: row.user_id,
        username: row.username,
        displayName: row.display_name ?? undefined,
        assignedAt:
            row.assigned_at instanceof Date
                ? row.assigned_at.toISOString()
                : String(row.assigned_at),
        assignedBy: row.assigned_by ?? undefined,
    };
}

// ---------------------------------------------------------------------------
// Endpoint def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Access'],
            summary: 'List access group members',
            stability: 'beta',
            auth: 'bearer',
            description: 'Returns the members of an access group. Requires `access:admin` scope.',
            responses: {
                200: {
                    schema: MembersListResponseSchema,
                    description: 'Group member list',
                },
                401: 'Authentication required',
                403: 'Insufficient scope',
                404: 'Group not found',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['access:admin'] },
    visibility: 'internal',
    handlers: {
        GET: async (event, _ctx) => {
            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            const groupId = event.params.id ?? event.params.groupId ?? '';
            if (!groupId)
                return ApiProblem.validationFailed([{ field: 'id', message: 'Required' }]);

            const rows = await listAccessGroupMembers(db, groupId);
            return json(
                paginate(rows.map(mapMemberRow), {
                    limit: rows.length,
                    offset: 0,
                    hasMore: false,
                }),
            );
        },
    },
});
