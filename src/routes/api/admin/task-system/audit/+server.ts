// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/admin/task-system/audit (Slice 0, EXTENDED by Slice 3 §5)
//
// Lists audit_log (source='subsystem') rows newest-first for the unified audit-feed UI.
//
// Slice 0 contract (preserved): `?category=` single filter + `?limit=` (1..200,
// default 50). Slice 3 adds, for the feed's filters + infinite scroll:
//   ?category=  — now MULTI-VALUE (repeat the param) as well as single
//   ?severity=  — info | warn | error
//   ?since=     — ISO timestamp lower bound
//   ?before=    — keyset cursor (an `id`); returns rows strictly older
// The response adds `nextCursor` (the oldest returned `id`, or null when the
// page wasn't full) alongside the existing `events` array — a superset of the
// Slice 0 shape, so existing consumers keep working.

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    listAuditFeed,
    type AuditSeverity,
} from '$lib/server/database/queries/observability.queries.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseSeverity(raw: string | null | undefined): AuditSeverity | undefined {
    return raw === 'info' || raw === 'warn' || raw === 'error' ? raw : undefined;
}

const def = defineEndpoint({
    // Operational surface (subsystem audit rows, heartbeats, queue depth) —
    // moved from tasks:read to tasks:admin. security review 2026-09-12, C16.
    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    visibility: 'internal',
    handlers: {
        GET: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not configured');

            const { url } = event;
            if (url.searchParams.has('before'))
                return ApiProblem.validationFailed('before is retired; use cursor');

            // Multi-value category (repeated param) — also accepts a single value.
            const categories = url.searchParams.getAll('category').filter((c) => c.length > 0);

            const severity = parseSeverity(url.searchParams.get('severity'));

            const sinceRaw = url.searchParams.get('since');
            let since: Date | undefined;
            if (sinceRaw) {
                const parsed = new Date(sinceRaw);
                if (!Number.isNaN(parsed.getTime())) since = parsed;
            }

            const beforeRaw = Number(url.searchParams.get('cursor') || NaN);
            const before =
                Number.isFinite(beforeRaw) && beforeRaw > 0 ? Math.trunc(beforeRaw) : undefined;

            // `|| NaN`: Number(null) and Number('') are 0, which would clamp a missing
            // param to the minimum instead of falling back to the default.
            const rawLimit = Number(url.searchParams.get('limit') || NaN);
            const limit = Number.isFinite(rawLimit)
                ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(rawLimit)))
                : DEFAULT_LIMIT;

            const { events, nextCursor } = await listAuditFeed(sql, {
                categories,
                severity,
                since,
                before,
                limit,
            });

            return json({
                items: events,
                page: {
                    limit,
                    hasMore: nextCursor !== null,
                    ...(nextCursor !== null ? { nextCursor: String(nextCursor) } : {}),
                },
            });
        },
    },
});

export const { GET } = mount(def, { surface: 'internal' });
