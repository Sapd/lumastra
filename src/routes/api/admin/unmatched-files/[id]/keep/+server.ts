// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Explicit, reversible Keep classification for one unmatched personal item. */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    keepPersonalMediaItem,
    restoreKeptPersonalMediaItem,
} from '$lib/server/database/queries/unmatched-files.queries.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';
import { auditActor, auditLog } from '$lib/server/utils/audit-log.js';

const ParamsSchema = z.object({ id: z.string().regex(UUID_RE, 'Invalid UUID') });
const EmptyBodySchema = z.object({}).strict();

const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['media:admin'] },
    visibility: 'internal',
    request: { params: ParamsSchema, body: EmptyBodySchema, bodyMethods: ['POST'] },
    handlers: {
        POST: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');
            const { id } = ctx.input!.params;
            const result = await keepPersonalMediaItem(
                sql,
                id,
                auditActor(event).username ?? 'system',
            );
            if (result === 'not_found') return ApiProblem.notFound('Media item not found');
            if (result === 'ineligible')
                return ApiProblem.conflict('This item changed and can no longer be kept here');
            if (result === 'rematch_busy')
                return ApiProblem.conflict(
                    'A provider match is running for this item; try Keep again when it finishes',
                );
            auditLog('media.keep_personal', id, auditActor(event), { disposition: 'kept' });
            return json({ disposition: 'kept' as const });
        },
        DELETE: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');
            const { id } = ctx.input!.params;
            if (!(await restoreKeptPersonalMediaItem(sql, id)))
                return ApiProblem.notFound('No kept decision exists for this media item');
            auditLog('media.restore_personal', id, auditActor(event), { disposition: 'kept' });
            return json({ restored: true as const });
        },
    },
});

export const { POST, DELETE } = mount(def, { surface: 'internal' });
