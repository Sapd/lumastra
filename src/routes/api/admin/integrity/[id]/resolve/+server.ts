// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/admin/integrity/[id]/resolve
 *
 * Marks a single integrity violation resolved. Body (optional):
 *   { resolution?: string }
 *
 * Defaults the resolution to "manually resolved by <username>" when the body
 * doesn't supply one — the underlying query throws when the row is missing
 * or already resolved, so the admin sees the stale state instead of a silent
 * no-op.
 *
 * Auth: media:admin. Surface: internal.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { resolveViolationById } from '$lib/server/database/queries/integrity-violations.queries.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const ParamsSchema = z.object({
    id: z.string().regex(UUID_RE, 'Invalid UUID'),
});

const BodySchema = z.object({
    resolution: z.string().min(1).optional(),
});

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['media:admin'] },
    visibility: 'internal',
    request: {
        params: ParamsSchema,
        body: BodySchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const { id } = ctx.input!.params;

            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const resolution = ctx.input!.body?.resolution;
            const username = event.locals.user?.username ?? 'admin';
            const finalResolution = resolution ?? `manually resolved by ${username}`;

            try {
                await resolveViolationById(sql, id, finalResolution);
            } catch (error) {
                if (
                    error instanceof Error &&
                    /already resolved or not found/i.test(error.message)
                ) {
                    return ApiProblem.notFound(error.message);
                }
                throw error;
            }

            return json({ resolved: true, id });
        },
    },
});

export const { POST } = mount(def, { surface: 'internal' });
