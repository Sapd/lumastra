// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * access/groups/ — access group collection.
 *
 * GET  /access/groups   list all access groups   (access:admin)
 * POST /access/groups   create an access group   (access:admin)
 *
 * Response contract:
 *   GET  → { items: AccessGroup[], page }
 *   POST → { group: AccessGroup }  (201)
 * Errors: problem+json (incl. 503 dependency_unavailable).
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/index.js';
import {
    listAccessGroups,
    type AccessGroupWithCapsRow,
} from '$lib/server/database/queries/access-groups.queries.js';
import { createAccessGroup } from '$lib/server/services/access-control.service.js';
import { requireAdminCeiling } from '$lib/server/api/token-minting.js';
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { AccessGroupCapabilitySchema, AccessGroupSchema } from '$lib/schemas/api-admin-access.js';

// mapGroupRow emits a UUID-string id and a capabilities[] array; the previous
// local schema declared id as a number and omitted capabilities entirely, so a
// strict decoder rejected the whole response. Reuse the canonical
// AccessGroupSchema (which the mapper's shape already matches). The list keeps
// its { items, page } envelope (the canonical wrapper uses { groups }).
const AccessGroupsListResponseSchema = z.object({
    items: z.array(AccessGroupSchema),
    page: z.object({
        limit: z.number().int(),
        offset: z.number().int(),
        hasMore: z.boolean(),
    }),
});

const CreateGroupBodySchema = z.object({
    name: z
        .string()
        .min(1)
        .max(64)
        .meta({ description: 'Alphanumeric/dash/underscore identifier' }),
    displayName: z.string().min(1).max(128).optional(),
    description: z.string().max(512).optional(),
});

const CreateGroupResponseSchema = z.object({
    group: AccessGroupSchema,
});

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const CreateGroupBody = z.object({
    name: z.string().trim().min(1).max(64).describe('Unique case-insensitive group name'),
    displayName: z.string().trim().min(1).max(128).optional().describe('Human-readable label'),
    description: z.string().trim().max(512).nullable().optional(),
    capabilities: z
        .array(AccessGroupCapabilitySchema)
        .optional()
        .describe('Initial capabilities; defaults to none'),
});

// ---------------------------------------------------------------------------
// Response mapper (canonical shape including capabilities)
// ---------------------------------------------------------------------------

export function mapGroupRow(row: AccessGroupWithCapsRow) {
    return {
        id: row.id,
        name: row.name,
        displayName: row.display_name,
        description: row.description ?? undefined,
        isSystem: row.is_system,
        memberCount: row.member_count,
        capabilities: (row.capabilities ?? []).map((c) => ({
            capability: c.capability,
            value: c.value ?? undefined,
        })),
        createdAt:
            row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
        updatedAt:
            row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    };
}

// ---------------------------------------------------------------------------
// Endpoint def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Access'],
            summary: 'List access groups',
            stability: 'beta',
            auth: 'bearer',
            description: 'Returns all access groups. Requires `access:admin` scope.',
            responses: {
                200: {
                    schema: AccessGroupsListResponseSchema,
                    description: 'Access group list',
                },
                401: 'Authentication required',
                403: 'Insufficient scope (requires access:admin)',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        POST: {
            tags: ['Access'],
            summary: 'Create an access group',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Creates a new access group. `name` must be unique and alphanumeric/dash/underscore. ' +
                'Requires `access:admin` scope.',
            body: CreateGroupBodySchema,
            responses: {
                201: {
                    schema: CreateGroupResponseSchema,
                    description: 'Access group created',
                },
                400: 'Validation error or name already taken',
                401: 'Authentication required',
                403: 'Insufficient scope',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['access:admin'] },
    visibility: 'internal',
    request: {
        body: CreateGroupBody,
    },
    handlers: {
        GET: async (_event, _ctx) => {
            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            const groups = await listAccessGroups(db);
            return json(
                paginate(groups.map(mapGroupRow), {
                    limit: groups.length,
                    offset: 0,
                    hasMore: false,
                }),
            );
        },

        POST: async (event, ctx) => {
            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            // Body validated by mount(); ctx.input!.body is typed + stripped.
            const { name, displayName, description, capabilities } = ctx.input!.body;

            // Admin ceiling (security review 2026-09-23 final fix wave, X1a):
            // creating a group with the `admin` capability confers admin to
            // every future member — the same ceiling `requireAdminCeiling()`
            // already applies to `isAdmin:true` on the users:admin endpoints
            // (security review 2026-09-13, C1). A delegated non-admin
            // `access:admin` credential must not be able to mint its own
            // route to admin this way.
            if (capabilities?.some((c) => c.capability === 'admin')) {
                const ceilingErr = await requireAdminCeiling(
                    event,
                    'Only administrators can create a group with the admin capability',
                );
                if (ceilingErr) return ceilingErr;
            }

            const result = await createAccessGroup(db, {
                name,
                displayName,
                description: description ?? null,
                capabilities,
            });

            if (!result.ok) {
                if (result.status === 409) return ApiProblem.conflict(result.message);
                if (result.status === 403) return ApiProblem.forbidden(result.message);
                if (result.status === 400) return ApiProblem.validationFailed(result.message);
                return ApiProblem.internalError(result.message);
            }

            return json({ group: mapGroupRow(result.data) }, { status: 201 });
        },
    },
});
