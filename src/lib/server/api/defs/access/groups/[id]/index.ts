// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * access/groups/[id] — single access-group resource.
 *
 * GET    /access/groups/{id}  read an access group          (access:admin)
 * PATCH  /access/groups/{id}  update display/caps           (access:admin)
 * DELETE /access/groups/{id}  delete (non-system) group     (access:admin)
 *
 * Response contract:
 *   GET/PATCH → { group: AccessGroup }
 *   DELETE    → 204 No Content
 * Errors: problem+json (incl. 503 dependency_unavailable).
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/index.js';
import { getAccessGroupById } from '$lib/server/database/queries/access-groups.queries.js';
import {
    updateAccessGroupWithCaps,
    deleteAccessGroupGuarded,
} from '$lib/server/services/access-control.service.js';
import { requireAdminCeiling } from '$lib/server/api/token-minting.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { AccessGroupCapabilitySchema, AccessGroupSchema } from '$lib/schemas/api-admin-access.js';
import { mapGroupRow } from '../index.js';

// Reuse the canonical AccessGroupSchema (UUID-string id + capabilities[]) that
// mapGroupRow already produces; the previous local copy declared a numeric id
// and omitted capabilities.
const GroupResponseSchema = z.object({
    group: AccessGroupSchema,
});

const PatchGroupBodySchema = z.object({
    displayName: z.string().min(1).max(128).optional(),
    description: z.string().max(512).nullable().optional(),
});

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const GroupIdParams = z.object({
    /** Route param: the access group UUID. Normalised from 'id' or 'groupId'. */
    id: z.string().min(1),
});

const UpdateGroupBody = z.object({
    displayName: z.string().trim().min(1).max(128).optional(),
    description: z.string().trim().max(512).nullable().optional(),
    capabilities: z
        .array(AccessGroupCapabilitySchema)
        .optional()
        .describe('Full replacement set of capabilities when present'),
});

// ---------------------------------------------------------------------------
// Endpoint def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Access'],
            summary: 'Get an access group',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Returns details for a single access group. Requires `access:admin` scope.',
            responses: {
                200: {
                    schema: GroupResponseSchema,
                    description: 'Access group details',
                },
                401: 'Authentication required',
                403: 'Insufficient scope',
                404: 'Group not found',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        PATCH: {
            tags: ['Access'],
            summary: 'Update an access group',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Updates `displayName` and/or `description` of an access group. ' +
                'System groups cannot be renamed. Requires `access:admin` scope.',
            body: PatchGroupBodySchema,
            responses: {
                200: {
                    schema: GroupResponseSchema,
                    description: 'Updated access group',
                },
                400: 'Validation error',
                401: 'Authentication required',
                403: 'Insufficient scope or system group modification',
                404: 'Group not found',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        DELETE: {
            tags: ['Access'],
            summary: 'Delete an access group',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Deletes an access group and removes all its members. ' +
                'System groups cannot be deleted. Requires `access:admin` scope.',
            responses: {
                204: 'Group deleted',
                401: 'Authentication required',
                403: 'Insufficient scope or system group',
                404: 'Group not found',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['access:admin'] },
    visibility: 'internal',
    request: {
        params: GroupIdParams,
        body: UpdateGroupBody,
        bodyMethods: ['PATCH'],
    },
    handlers: {
        GET: async (event, _ctx) => {
            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            // Route may expose param as 'id' or 'groupId' — normalise.
            const groupId = event.params.id ?? event.params.groupId ?? '';
            if (!groupId)
                return ApiProblem.validationFailed([{ field: 'id', message: 'Required' }]);

            const row = await getAccessGroupById(db, groupId);
            if (!row) return ApiProblem.notFound('Access group not found');

            return json({ group: mapGroupRow(row) });
        },

        PATCH: async (event, ctx) => {
            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            const groupId = event.params.id ?? event.params.groupId ?? '';
            if (!groupId)
                return ApiProblem.validationFailed([{ field: 'id', message: 'Required' }]);

            const body = ctx.input?.body ?? {};

            // Admin ceiling (security review 2026-09-23 final fix wave, X1a):
            // a full capability REPLACE that adds `admin` confers admin to
            // every current (and future) member — same ceiling as creating a
            // group with it. A replace that merely drops/keeps other
            // capabilities is unaffected (demotion is already guarded by the
            // last-admin check inside updateAccessGroupWithCaps()).
            if (body.capabilities?.some((c) => c.capability === 'admin')) {
                const ceilingErr = await requireAdminCeiling(
                    event,
                    'Only administrators can grant the admin capability to a group',
                );
                if (ceilingErr) return ceilingErr;
            }

            const result = await updateAccessGroupWithCaps(db, groupId, {
                displayName: body.displayName,
                ...('description' in body ? { description: body.description ?? null } : {}),
                capabilities: body.capabilities,
            });

            if (!result.ok) {
                if (result.status === 404) return ApiProblem.notFound(result.message);
                if (result.status === 409) return ApiProblem.conflict(result.message);
                if (result.status === 403) return ApiProblem.forbidden(result.message);
                return ApiProblem.internalError(result.message);
            }

            auditLog('access_group.update', groupId, auditActor(event), {
                name: result.data.name,
                capabilities: result.data.capabilities.map((c) => c.capability),
            });

            return json({ group: mapGroupRow(result.data) });
        },

        DELETE: async (event, _ctx) => {
            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            const groupId = event.params.id ?? event.params.groupId ?? '';
            if (!groupId)
                return ApiProblem.validationFailed([{ field: 'id', message: 'Required' }]);

            const result = await deleteAccessGroupGuarded(db, groupId);

            if (!result.ok) {
                if (result.status === 404) return ApiProblem.notFound(result.message);
                if (result.status === 409) return ApiProblem.conflict(result.message);
                if (result.status === 403) return ApiProblem.forbidden(result.message);
                return ApiProblem.internalError(result.message);
            }

            auditLog('access_group.delete', groupId, auditActor(event), {});

            // 204 no-content — matches the documented DELETE response (the
            // handler previously returned a 200 { deleted: true } body the spec
            // never advertised).
            return new Response(null, { status: 204 });
        },
    },
});
