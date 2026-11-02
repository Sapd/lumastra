// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/admin/task-system/trends (Slice 3 §4.4, §5)
//
// Retained trend samples from task_metrics_snapshot, oldest→newest, for the
// in-app trend charts (OSS users with no Prometheus scraper).
//
//   ?sinceHours=  (default 168, max 720)

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { listSnapshots } from '$lib/server/database/queries/task-metrics-snapshot.queries.js';

const DEFAULT_SINCE_HOURS = 168;
const MAX_SINCE_HOURS = 720;
// Cap the series so a long window over a busy snapshot cadence can't unbounded
// the payload (720h / 5min ≈ 8640 rows worst case).
const MAX_POINTS = 5000;

const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['metrics:read'] },
    visibility: 'internal',
    handlers: {
        GET: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not configured');

            // `|| NaN`: Number(null) and Number('') are 0, which would clamp a missing
            // param to the minimum instead of falling back to the default.
            const rawSince = Number(event.url.searchParams.get('sinceHours') || NaN);
            const sinceHours = Number.isFinite(rawSince)
                ? Math.min(MAX_SINCE_HOURS, Math.max(1, Math.trunc(rawSince)))
                : DEFAULT_SINCE_HOURS;

            const points = await listSnapshots(sql, {
                sinceHours,
                limit: MAX_POINTS,
            });

            return json({ points });
        },
    },
});

export const { GET } = mount(def, { surface: 'internal' });
