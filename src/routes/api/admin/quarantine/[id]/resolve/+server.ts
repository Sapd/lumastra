// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/admin/quarantine/[id]/resolve
 *
 * Resolves a sync_quarantine entry. Body:
 *   { resolution: 'reattached' | 'dismissed' | 'recreated' }
 *
 * `resolution` is required and constrained to the QuarantineResolution union.
 * `resolvedBy` is ALWAYS taken from the authenticated admin's username — the
 * body schema deliberately does not include a `resolvedBy` field so an admin
 * can't forge the audit-trail attribution. The underlying query throws when
 * the row is missing or already resolved.
 *
 * Auth: media:admin. Surface: internal.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { resolveQuarantine } from '$lib/server/database/queries/sync-quarantine.queries.js';
import { quarantineResolveBodySchema } from '$lib/schemas/admin.js';
import { dismissReviewedQuarantine } from '$lib/server/services/quarantine-inspection.service.js';
import { auditActor, auditLog } from '$lib/server/utils/audit-log.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const ParamsSchema = z.object({
    id: z.string().regex(UUID_RE, 'Invalid UUID'),
});

const BodySchema = quarantineResolveBodySchema;

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
            const { resolution } = ctx.input!.body;

            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            // resolvedBy is ALWAYS the authenticated admin's username — never from body.
            const actor = auditActor(event);
            const resolvedBy = actor.username ?? 'admin';
            if (ctx.input!.body.fingerprint) {
                if (resolution !== 'dismissed')
                    return ApiProblem.validationFailed(
                        'Reviewed inspection only supports dismissal',
                    );
                if (
                    !(await dismissReviewedQuarantine(
                        sql,
                        id,
                        ctx.input!.body.fingerprint,
                        resolvedBy,
                    ))
                )
                    return ApiProblem.conflict(
                        'Warning or current subject changed or is busy. Inspect again before dismissing.',
                    );
                auditLog('quarantine.dismiss', id, actor, { resolution, reviewed: true });
                return json({ resolved: true, id, resolution, resolvedBy });
            }

            try {
                await resolveQuarantine(sql, id, { resolvedBy, resolution });
            } catch (error) {
                if (
                    error instanceof Error &&
                    /already resolved or not found/i.test(error.message)
                ) {
                    return ApiProblem.notFound(error.message);
                }
                throw error;
            }

            return json({ resolved: true, id, resolution, resolvedBy });
        },
    },
});

export const { POST } = mount(def, { surface: 'internal' });
