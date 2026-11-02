// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/admin/task-system/failures/patterns (Slice 3 §4.1, §5)
//
// Grouped run + item failure patterns over a clamped window, count-sorted,
// Valkey-cached. Read-time fingerprinting — no persisted hash.
//
//   ?source=run|item|all   (default 'all')
//   ?sinceHours=           (default 24, max 168)
//   ?limit=                (default 50, max 200)
//   ?taskId=               (optional — scope to one task's detail panel)

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { getFailurePatterns } from '$lib/server/tasks/observability/failure-patterns.service.js';

const DEFAULT_SINCE_HOURS = 24;
const MAX_SINCE_HOURS = 168;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampInt(raw: string | null, def: number, min: number, max: number): number {
    // Number(null) and Number('') are 0: a missing param must take the default.
    const n = raw ? Number(raw) : NaN;
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, Math.trunc(n)));
}

const def = defineEndpoint({
    // Operational surface (failure pattern roll-up) — moved from tasks:read
    // to tasks:admin. security review 2026-09-12, C16.
    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    visibility: 'internal',
    handlers: {
        GET: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not configured');

            const { url } = event;
            const rawSource = url.searchParams.get('source');
            const source =
                rawSource === 'run' || rawSource === 'item' || rawSource === 'all'
                    ? rawSource
                    : 'all';
            const sinceHours = clampInt(
                url.searchParams.get('sinceHours'),
                DEFAULT_SINCE_HOURS,
                1,
                MAX_SINCE_HOURS,
            );
            const limit = clampInt(url.searchParams.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
            const taskId = url.searchParams.get('taskId') ?? undefined;

            const patterns = await getFailurePatterns(sql, {
                source,
                sinceHours,
                limit,
                taskId,
            });

            return json({ patterns, window: { sinceHours } });
        },
    },
});

export const { GET } = mount(def, { surface: 'internal' });
