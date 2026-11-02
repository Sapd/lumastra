// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MDBList status API Endpoint
 *
 * GET: returns MDBList tag sync status (item counts, coverage percentage).
 *
 * Auth:    admin
 * Surface: internal
 *
 * GET 200 { synced, total, withTags, withoutTags, minRequired, percentage, message }
 * 503 dependency_unavailable on DB down.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database';
import { getMdblistTagStats } from '$lib/server/database/queries/ai-admin.queries.js';

const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async () => {
            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database unavailable');
            }

            const stats = await getMdblistTagStats(sql);
            const minRequired = 100;
            const hasSufficientTags = stats.withTags >= minRequired;

            return json({
                synced: hasSufficientTags,
                total: stats.total,
                withTags: stats.withTags,
                withoutTags: stats.withoutTags,
                minRequired,
                percentage: stats.total > 0 ? Math.round((stats.withTags / stats.total) * 100) : 0,
                message: hasSufficientTags
                    ? `MDBList tags synced (${stats.withTags} items)`
                    : `MDBList tags not synced yet (${stats.withTags}/${minRequired} required)`,
            });
        },
    },
});

export const { GET } = mount(def, { surface: 'internal' });
