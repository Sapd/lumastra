// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/downloads/index.ts
 *
 * GET /api/admin/downloads?user=&kind=&before=&limit=
 * GET /api/admin/downloads?group=<id>
 *
 * Running downloads (from the shared leases, with speed) and the download log
 * (newest first, bursts grouped: see `listDownloadGroups`), joined to titles and
 * usernames, for the admin Downloads page. `user` is a username, `kind` video or music.
 * `group` returns the downloads of one grouped row instead (as `events`, nothing running).
 * Cookie/forward-auth only: the admin UI cannot use /api/v1.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { AdminDownloadsResponseSchema } from '$lib/schemas/api-admin-responses.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    getDownloadTitles,
    isDownloadCursor,
    getUsernamesByIds,
    listDownloadGroupMembers,
    listDownloadGroups,
    listOpenDownloadEvents,
    type DownloadEventRow,
    type DownloadGroupRow,
    type DownloadTitleInfo,
} from '$lib/server/database/queries/download-events.queries.js';
import { getUserByUsername } from '$lib/server/database/queries/users.queries.js';
import {
    isDownloadLeasingDegraded,
    listActiveDownloads,
} from '$lib/server/services/download-leases.js';
import { kbpsToBytesPerSecond } from '$lib/server/utils/throttled-stream.js';
import { config } from '$lib/server/config.js';

const MAX_LIMIT = 200;

const QuerySchema = z.object({
    user: z.string().min(1).optional(),
    before: z
        .string()
        .refine(isDownloadCursor, 'before must be a cursor from nextBefore')
        .optional(),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional().default(50),
    kind: z.enum(['video', 'music']).optional(),
    group: z.string().uuid().optional(),
});

/** A ZIP of a season or series (explicit kind; a refused single file may also lack a file id). */
const isArchive = (e: Pick<DownloadEventRow, 'kind'>): boolean => e.kind === 'archive';

function titleFields(t: DownloadTitleInfo | undefined) {
    return {
        title: t?.title,
        seriesTitle: t?.seriesTitle ?? undefined,
        season: t?.season ?? undefined,
        episode: t?.episode ?? undefined,
        artist: t?.artist ?? undefined,
        album: t?.album ?? undefined,
    };
}

/** What every download of a group shares: its album (with artist) or its series and season. */
function groupTitleFields(
    g: Pick<DownloadGroupRow, 'contextId' | 'season' | 'mediaType'>,
    t: DownloadTitleInfo | undefined,
) {
    if (!t) return {};
    if (g.mediaType === 'track') return { album: t.title, artist: t.artist ?? undefined };
    if (g.mediaType === 'episode') return { seriesTitle: t.title, season: g.season ?? undefined };
    return {};
}

const capBytesPerSec = (): number => kbpsToBytesPerSecond(config.DOWNLOAD_TOTAL_BANDWIDTH_KBPS);

/** One logged download, as a row of a `group` request. */
function eventOf(
    r: DownloadEventRow,
    titles: Map<string, DownloadTitleInfo>,
    names: Map<string, string>,
) {
    return {
        id: r.id,
        userId: r.userId,
        username: names.get(r.userId),
        ...titleFields(titles.get(r.mediaItemId)),
        archive: isArchive(r) ? true : undefined,
        clientName: r.clientName ?? undefined,
        surface: r.surface,
        bytesTotal: r.bytesTotal ?? undefined,
        bytesSent: r.bytesSent,
        outcome: r.outcome ?? undefined,
        startedAt: r.startedAt.toISOString(),
        endedAt: r.endedAt?.toISOString(),
        count: 1,
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
                'and the download log, newest first, optionally for one user or kind. Downloads ' +
                'a client fetched one after another are one row (`count`); `group` lists them.',
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
            const { user, before, limit, kind, group } = ctx.input!.query!;

            if (group) {
                const members = await listDownloadGroupMembers(sql, group);
                const [titles, names] = await Promise.all([
                    getDownloadTitles(sql, [...new Set(members.map((r) => r.mediaItemId))]),
                    getUsernamesByIds(sql, [...new Set(members.map((r) => r.userId))]),
                ]);
                return json(
                    AdminDownloadsResponseSchema.parse({
                        totalBytesPerSec: 0,
                        totalCapBytesPerSec: capBytesPerSec(),
                        active: [],
                        events: members.map((r) => eventOf(r, titles, names)),
                    }),
                );
            }

            let userId: string | undefined;
            if (user) {
                const found = await getUserByUsername(sql, user);
                if (!found) {
                    return json(
                        AdminDownloadsResponseSchema.parse({
                            totalBytesPerSec: 0,
                            totalCapBytesPerSec: capBytesPerSec(),
                            active: [],
                            events: [],
                            degraded: isDownloadLeasingDegraded(),
                        }),
                    );
                }
                userId = found.id;
            }

            const leases = await listActiveDownloads();
            const [open, rows] = await Promise.all([
                listOpenDownloadEvents(sql, [...new Set(leases.map((l) => l.userId))]),
                listDownloadGroups(sql, { userId, mediaClass: kind, limit, before }),
            ]);
            const totalBytesPerSec = leases.reduce((n, l) => n + l.bytesPerSec, 0);
            const shownLeases = userId ? leases.filter((l) => l.userId === userId) : leases;

            // A lease's fileId is a file id or a rendition id: match it to its open log row.
            const openFor = (l: { userId: string; fileId: string; deviceKey: string }) =>
                open.find(
                    (e: DownloadEventRow) =>
                        e.userId === l.userId &&
                        e.deviceKey === l.deviceKey &&
                        (e.fileId === l.fileId ||
                            e.renditionId === l.fileId ||
                            // an archive's lease has a fresh per-request key: match it to the
                            // user's open archive row on the same device
                            isArchive(e)),
                );

            const matched = shownLeases.map((l) => ({ lease: l, event: openFor(l) }));
            const mediaIds = new Set<string>(
                rows
                    .map((r) => (r.count > 1 ? r.contextId : r.mediaItemId))
                    .filter((id): id is string => id !== null),
            );
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
                totalCapBytesPerSec: capBytesPerSec(),
                degraded: isDownloadLeasingDegraded(),
                active: matched.map(({ lease, event }) => ({
                    userId: lease.userId,
                    username: names.get(lease.userId),
                    fileId: lease.fileId,
                    ...titleFields(event ? titles.get(event.mediaItemId) : undefined),
                    archive: event && isArchive(event) ? true : undefined,
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
                    ...(r.count > 1
                        ? groupTitleFields(r, r.contextId ? titles.get(r.contextId) : undefined)
                        : titleFields(titles.get(r.mediaItemId))),
                    archive: isArchive(r) ? true : undefined,
                    clientName: r.clientName ?? undefined,
                    surface: r.surface,
                    bytesTotal: r.bytesTotal ?? undefined,
                    bytesSent: r.bytesSent,
                    outcome: r.outcome,
                    startedAt: r.startedAt.toISOString(),
                    endedAt: r.endedAt?.toISOString(),
                    count: r.count,
                    mediaClass: r.mediaClass,
                    mediaType: r.mediaType ?? undefined,
                })),
                nextBefore: rows.length === limit ? rows[rows.length - 1].cursor : undefined,
            };
            return json(AdminDownloadsResponseSchema.parse(body));
        },
    },
});
