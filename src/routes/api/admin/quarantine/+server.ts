// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/admin/quarantine
 *
 * Returns unresolved sync_quarantine entries. The Jellyfin sync rework writes
 * these when an inbound payload would violate a series-identity invariant;
 * admins triage them here and via the resolve endpoint.
 *
 * Query params:
 *  - limit:  page size, default 100, capped at 500
 *  - offset: offset for pagination, default 0
 *
 * Auth: media:admin. Surface: internal.
 */

import { z } from 'zod';
import { isDelegatedAdmin } from '$lib/server/api/delegate.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';
import { inspectQuarantineGroup } from '$lib/server/services/quarantine-inspection.service.js';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import {
    listUnresolvedQuarantine,
    countUnresolvedQuarantine,
} from '$lib/server/database/queries/sync-quarantine.queries.js';

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const QuerySchema = z.object({
    group: z
        .string()
        .max(256)
        .refine(
            (value) => UUID_RE.test(value) || value === 'unknown' || /^tmdb:.+$/.test(value),
            'Invalid group',
        )
        .optional(),
    after: z.string().regex(UUID_RE).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    offset: z.coerce.number().int().min(0).optional(),
});

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['media:admin'] },
    visibility: 'internal',
    request: {
        query: QuerySchema,
    },
    handlers: {
        GET: async (event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            if (ctx.input!.query.group) {
                if (isDelegatedAdmin(event))
                    return ApiProblem.validationFailed(
                        'Inspection is available only on the internal admin endpoint',
                    );
                return json(
                    await inspectQuarantineGroup(sql, ctx.input!.query.group, {
                        after: ctx.input!.query.after,
                        limit: ctx.input!.query.limit,
                    }),
                );
            }

            const limit = Math.min(ctx.input!.query.limit ?? 100, 500);
            const offset = ctx.input!.query.offset ?? 0;

            // `offset` was accepted and echoed in the envelope but never
            // applied, so every page returned page 1 again.
            const entries = await listUnresolvedQuarantine(sql, limit, offset);
            const unresolved = await countUnresolvedQuarantine(sql);

            // Wrap in {items,page} collection envelope per contract
            return json({
                ...paginate(entries, {
                    limit,
                    offset,
                    hasMore: entries.length >= limit,
                    total: unresolved,
                }),
                counts: { unresolved },
            });
        },
    },
});

export const { GET } = mount(def, { surface: 'internal' });
