// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/downloads/index.ts
 *
 * GET /api/admin/downloads?user=&before=&limit=
 *
 * Running downloads (from the shared leases, with speed) and the download log
 * (newest first), joined to titles and usernames, for the admin Downloads page.
 * `user` is a username. Cookie/forward-auth only: the admin UI cannot use /api/v1.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { AdminDownloadsResponseSchema } from '$lib/schemas/api-admin-responses.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    getDownloadTitles,
    getUsernamesByIds,
    listDownloadEvents,
    listOpenDownloadEvents,
    type DownloadEventRow,
    type DownloadTitleInfo,
} from '$lib/server/database/queries/download-events.queries.js';
import { getUserByUsername } from '$lib/server/database/queries/users.queries.js';
import { listActiveDownloads } from '$lib/server/services/download-leases.js';
import { kbpsToBytesPerSecond } from '$lib/server/utils/throttled-stream.js';
import { config } from '$lib/server/config.js';

const MAX_LIMIT = 200;

const QuerySchema = z.object({
    user: z.string().min(1).optional(),
    before: z.coerce.date().optional(),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional().default(50),
});

function titleFields(t: DownloadTitleInfo | undefined) {
    return {
        title: t?.title,
        seriesTitle: t?.seriesTitle ?? undefined,
        season: t?.season ?? undefined,
        episode: t?.episode ?? undefined,
    };
}

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    request: { query: QuerySchema },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Admin', 'Downloads'],
            summary: 'List running downloads and the download log',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Running downloads with their current speed, the total against the instance cap, ' +
                'and the download log, newest first, optionally for one user.',
            responses: {
                200: { schema: AdminDownloadsResponseSchema, description: 'Downloads' },
                401: 'Authentication required',
                403: 'Admin access required',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },
    handlers: {
        GET: async (_event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');
            const { user, before, limit } = ctx.input!.query!;

            let userId: string | undefined;
            if (user) {
                const found = await getUserByUsername(sql, user);
                if (!found) {
                    return json(
                        AdminDownloadsResponseSchema.parse({
                            totalBytesPerSec: 0,
                            totalCapBytesPerSec: kbpsToBytesPerSecond(
                                config.DOWNLOAD_TOTAL_BANDWIDTH_KBPS,
                            ),
                            active: [],
                            events: [],
                        }),
                    );
                }
                userId = found.id;
            }

            const leases = await listActiveDownloads();
            const [open, rows] = await Promise.all([
                listOpenDownloadEvents(sql, [...new Set(leases.map((l) => l.userId))]),
                listDownloadEvents(sql, { userId, limit, before }),
            ]);
            const totalBytesPerSec = leases.reduce((n, l) => n + l.bytesPerSec, 0);
            const shownLeases = userId ? leases.filter((l) => l.userId === userId) : leases;

            // A lease's fileId is a file id or a rendition id: match it to its open log row.
            const openFor = (l: { userId: string; fileId: string; deviceKey: string }) =>
                open.find(
                    (e: DownloadEventRow) =>
                        e.userId === l.userId &&
                        e.deviceKey === l.deviceKey &&
                        (e.fileId === l.fileId || e.renditionId === l.fileId),
                );

            const matched = shownLeases.map((l) => ({ lease: l, event: openFor(l) }));
            const mediaIds = new Set<string>(rows.map((r) => r.mediaItemId));
            const userIds = new Set<string>(rows.map((r) => r.userId));
            for (const { lease, event } of matched) {
                if (event) mediaIds.add(event.mediaItemId);
                userIds.add(lease.userId);
            }
            const [titles, names] = await Promise.all([
                getDownloadTitles(sql, [...mediaIds]),
                getUsernamesByIds(sql, [...userIds]),
            ]);

            const body = {
                totalBytesPerSec,
                totalCapBytesPerSec: kbpsToBytesPerSecond(config.DOWNLOAD_TOTAL_BANDWIDTH_KBPS),
                active: matched.map(({ lease, event }) => ({
                    userId: lease.userId,
                    username: names.get(lease.userId),
                    fileId: lease.fileId,
                    ...titleFields(event ? titles.get(event.mediaItemId) : undefined),
                    clientName: event?.clientName ?? undefined,
                    surface: event?.surface,
                    bytesTotal: event?.bytesTotal ?? undefined,
                    bytesSent: lease.bytesSent,
                    bytesPerSec: lease.bytesPerSec,
                    startedAt: new Date(lease.startedAt).toISOString(),
                })),
                events: rows.map((r) => ({
                    id: r.id,
                    userId: r.userId,
                    username: names.get(r.userId),
                    ...titleFields(titles.get(r.mediaItemId)),
                    clientName: r.clientName ?? undefined,
                    surface: r.surface,
                    bytesTotal: r.bytesTotal ?? undefined,
                    bytesSent: r.bytesSent,
                    outcome: r.outcome ?? undefined,
                    startedAt: r.startedAt.toISOString(),
                    endedAt: r.endedAt?.toISOString(),
                })),
                nextBefore:
                    rows.length === limit
                        ? rows[rows.length - 1].startedAt.toISOString()
                        : undefined,
            };
            return json(AdminDownloadsResponseSchema.parse(body));
        },
    },
});
