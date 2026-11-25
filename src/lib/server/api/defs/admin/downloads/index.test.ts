// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** GET /api/admin/downloads: running downloads plus the download log. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';
import type {
    DownloadEventRow,
    DownloadGroupRow,
} from '$lib/server/database/queries/download-events.queries.js';

const m = vi.hoisted(() => ({
    listGroups: vi.fn(),
    listMembers: vi.fn(),
    listOpen: vi.fn(),
    titles: vi.fn(),
    names: vi.fn(),
    userByName: vi.fn(),
    active: vi.fn(),
    cap: { v: 0 },
    degraded: { v: false },
}));

vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/download-events.queries.js', () => ({
    listDownloadGroups: m.listGroups,
    listDownloadGroupMembers: m.listMembers,
    listOpenDownloadEvents: m.listOpen,
    getDownloadTitles: m.titles,
    isDownloadCursor: (v: string) => /^\d{4}-.*\|[0-9a-f-]{36}$/.test(v),
    getUsernamesByIds: m.names,
}));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserByUsername: m.userByName,
}));
vi.mock('$lib/server/services/download-leases.js', () => ({
    listActiveDownloads: m.active,
    isDownloadLeasingDegraded: () => m.degraded.v,
}));
vi.mock('$lib/server/config.js', () => ({
    config: {
        get DOWNLOAD_TOTAL_BANDWIDTH_KBPS() {
            return m.cap.v;
        },
    },
}));

import { def } from './index.js';

function row(over: Partial<DownloadEventRow>): DownloadEventRow {
    return {
        id: 'e1',
        userId: 'u1',
        mediaItemId: 'm1',
        fileId: 'f1',
        renditionId: null,
        kind: 'file',
        surface: 'web',
        deviceKey: 'd1',
        clientName: 'Firefox',
        bytesTotal: 1000,
        bytesSent: 1000,
        rangeStart: null,
        startedAt: new Date('2026-11-16T10:00:00Z'),
        lastActivityAt: new Date('2026-11-16T10:01:00Z'),
        endedAt: new Date('2026-11-16T10:01:00Z'),
        outcome: 'completed',
        cursor: '2026-11-16T10:00:00.000000Z|00000000-0000-4000-8000-000000000001',
        ...over,
    };
}

function grp(over: Partial<DownloadGroupRow>): DownloadGroupRow {
    return {
        id: 'e1',
        userId: 'u1',
        surface: 'web',
        kind: 'file',
        clientName: 'Firefox',
        mediaClass: 'video',
        outcome: 'completed',
        count: 1,
        mediaItemId: 'm1',
        bytesSent: 1000,
        bytesTotal: 1000,
        startedAt: new Date('2026-11-16T10:00:00Z'),
        endedAt: new Date('2026-11-16T10:01:00Z'),
        contextId: null,
        season: null,
        mediaType: 'episode',
        cursor: '2026-11-16T10:00:00.000000Z|00000000-0000-4000-8000-000000000001',
        ...over,
    };
}

function ctx(query: Record<string, unknown> = {}): ApiContext<NonNullable<typeof def.request>> {
    return {
        surface: 'internal',
        input: { query: { limit: 50, ...query } },
    } as unknown as ApiContext<NonNullable<typeof def.request>>;
}
const event = { url: new URL('http://localhost/api/admin/downloads') } as unknown as RequestEvent;

beforeEach(() => {
    vi.clearAllMocks();
    m.cap.v = 0;
    m.degraded.v = false;
    m.listGroups.mockResolvedValue([]);
    m.listMembers.mockResolvedValue([]);
    m.listOpen.mockResolvedValue([]);
    m.active.mockResolvedValue([]);
    m.titles.mockResolvedValue(new Map());
    m.names.mockResolvedValue(new Map([['u1', 'alice']]));
    m.userByName.mockResolvedValue(null);
});

describe('GET /api/admin/downloads', () => {
    // A non-admin gets 403 from enforce() for every `kind: 'admin'` def (mount.test.ts).
    it('is an admin, internal endpoint', () => {
        expect(def.auth).toEqual({ kind: 'admin' });
        expect(def.docs?.visibility).toBe('internal');
    });

    it('joins events to titles and usernames, keeping the newest-first query order', async () => {
        m.listGroups.mockResolvedValue([
            grp({ id: 'e2', mediaItemId: 'm2', outcome: 'denied', bytesSent: 0 }),
            grp({ id: 'e1' }),
        ]);
        m.titles.mockResolvedValue(
            new Map([
                ['m1', { title: 'Pilot', seriesTitle: 'Example Show', season: 1, episode: 2 }],
                ['m2', { title: 'A Movie', seriesTitle: null, season: null, episode: null }],
            ]),
        );
        const res = (await def.handlers.GET!(event, ctx())) as Response;
        const body = await res.json();
        expect(body.events.map((e: { id: string }) => e.id)).toEqual(['e2', 'e1']);
        expect(body.events[1]).toMatchObject({
            username: 'alice',
            title: 'Pilot',
            seriesTitle: 'Example Show',
            season: 1,
            episode: 2,
            clientName: 'Firefox',
            surface: 'web',
            outcome: 'completed',
            startedAt: '2026-11-16T10:00:00.000Z',
        });
        expect(body.events[0]).toMatchObject({ title: 'A Movie', outcome: 'denied' });
        expect(body.events[0].seriesTitle).toBeUndefined();
    });

    it('filters by user name', async () => {
        m.userByName.mockResolvedValue({ id: 'u1', username: 'alice' });
        await def.handlers.GET!(event, ctx({ user: 'alice' }));
        expect(m.listGroups).toHaveBeenCalledWith(
            {},
            { userId: 'u1', mediaClass: undefined, limit: 50, before: undefined },
        );
    });

    it('returns an empty list for an unknown user filter', async () => {
        const res = (await def.handlers.GET!(event, ctx({ user: 'nobody' }))) as Response;
        expect((await res.json()).events).toEqual([]);
        expect(m.listGroups).not.toHaveBeenCalled();
    });

    it('looks up open rows only for the users with running downloads', async () => {
        m.active.mockResolvedValue([
            {
                userId: 'u1',
                fileId: 'f1',
                deviceKey: 'd1',
                bytesSent: 1,
                startedAt: 1,
                bytesPerSec: 1,
            },
            {
                userId: 'u1',
                fileId: 'f2',
                deviceKey: 'd2',
                bytesSent: 1,
                startedAt: 1,
                bytesPerSec: 1,
            },
        ]);
        await def.handlers.GET!(event, ctx());
        expect(m.listOpen).toHaveBeenCalledWith({}, ['u1']);
    });

    it('passes the before cursor through', async () => {
        const before = '2026-11-16T09:00:00.123456Z|00000000-0000-4000-8000-000000000002';
        await def.handlers.GET!(event, ctx({ before }));
        expect(m.listGroups).toHaveBeenCalledWith(
            {},
            { userId: undefined, mediaClass: undefined, limit: 50, before },
        );
    });

    it('exposes degraded and a keyset nextBefore', async () => {
        m.degraded.v = true;
        m.listGroups.mockResolvedValue([grp({})]);
        const res = await def.handlers.GET!(event, ctx({ limit: 1 }));
        const body = await (res as Response).json();
        expect(body.degraded).toBe(true);
        expect(body.nextBefore).toBe(
            '2026-11-16T10:00:00.000000Z|00000000-0000-4000-8000-000000000001',
        );
    });

    it('reports running downloads with titles, speeds and the total against the cap', async () => {
        m.cap.v = 1024;
        m.active.mockResolvedValue([
            {
                userId: 'u1',
                fileId: 'f1',
                deviceKey: 'd1',
                bytesSent: 500,
                startedAt: 1_000,
                bytesPerSec: 300,
            },
            {
                userId: 'u1',
                fileId: 'r9',
                deviceKey: 'd2',
                bytesSent: 10,
                startedAt: 2_000,
                bytesPerSec: 200,
            },
        ]);
        m.listOpen.mockResolvedValue([
            row({ id: 'o1', fileId: 'f1', deviceKey: 'd1', endedAt: null, outcome: null }),
            row({
                id: 'o2',
                fileId: null,
                renditionId: 'r9',
                mediaItemId: 'm2',
                deviceKey: 'd2',
                endedAt: null,
                outcome: null,
                surface: 'api',
                clientName: null,
            }),
        ]);
        m.titles.mockResolvedValue(
            new Map([
                ['m1', { title: 'Pilot', seriesTitle: 'Example Show', season: 1, episode: 2 }],
                ['m2', { title: 'A Movie', seriesTitle: null, season: null, episode: null }],
            ]),
        );
        const body = await ((await def.handlers.GET!(event, ctx())) as Response).json();
        expect(body.totalBytesPerSec).toBe(500);
        expect(body.totalCapBytesPerSec).toBe(1024 * 1024);
        expect(body.active).toHaveLength(2);
        expect(body.active[0]).toMatchObject({
            username: 'alice',
            title: 'Pilot',
            bytesSent: 500,
            bytesTotal: 1000,
            bytesPerSec: 300,
            surface: 'web',
        });
        expect(body.active[1]).toMatchObject({
            title: 'A Movie',
            surface: 'api',
            bytesPerSec: 200,
        });
    });

    it('still lists a running download whose log row is missing', async () => {
        m.active.mockResolvedValue([
            {
                userId: 'u1',
                fileId: 'zz',
                deviceKey: 'd1',
                bytesSent: 5,
                startedAt: 1,
                bytesPerSec: 1,
            },
        ]);
        const body = await ((await def.handlers.GET!(event, ctx())) as Response).json();
        expect(body.active[0]).toMatchObject({ username: 'alice', bytesSent: 5 });
        expect(body.active[0].title).toBeUndefined();
    });

    it('flags archive rows (no file, no rendition) and matches a running archive lease by media item', async () => {
        m.active.mockResolvedValue([
            {
                userId: 'u1',
                fileId: 'per-request-lease-key',
                deviceKey: 'd1',
                bytesSent: 5,
                startedAt: 1_000,
                bytesPerSec: 10,
            },
        ]);
        m.listOpen.mockResolvedValue([
            row({
                id: 'z1',
                mediaItemId: 'season1',
                fileId: null,
                kind: 'archive',
                endedAt: null,
                outcome: null,
            }),
        ]);
        m.listGroups.mockResolvedValue([
            grp({ id: 'z2', mediaItemId: 'season1', kind: 'archive' }),
            // denied movie/episode rows have no file id either, but are not ZIPs
            grp({ id: 'd1', mediaItemId: 'm9', outcome: 'denied' }),
            grp({ id: 'f2' }),
        ]);
        m.titles.mockResolvedValue(
            new Map([
                [
                    'season1',
                    { title: 'Season 2', seriesTitle: 'Example Show', season: 2, episode: null },
                ],
            ]),
        );
        const res = (await def.handlers.GET!(event, ctx())) as Response;
        const body = await res.json();
        expect(body.active[0]).toMatchObject({
            archive: true,
            seriesTitle: 'Example Show',
            season: 2,
        });
        expect(body.events[0]).toMatchObject({ id: 'z2', archive: true });
        expect(body.events[1]).toMatchObject({ id: 'd1' });
        expect(body.events[1].archive).toBeUndefined();
        expect(body.events[2].archive).toBeUndefined();
    });
    it('passes the kind filter through', async () => {
        await def.handlers.GET!(event, ctx({ kind: 'music' }));
        expect(m.listGroups).toHaveBeenCalledWith(
            {},
            { userId: undefined, mediaClass: 'music', limit: 50, before: undefined },
        );
    });

    it('describes a group by what its downloads share: album and artist, or series and season', async () => {
        m.listGroups.mockResolvedValue([
            grp({
                id: 'g1',
                count: 192,
                mediaClass: 'music',
                mediaType: 'track',
                mediaItemId: 't9',
                contextId: 'alb1',
                surface: 'api',
            }),
            grp({ id: 'g2', count: 10, mediaType: 'episode', contextId: 'show1', season: 3 }),
            grp({ id: 'g3', count: 4, mediaType: 'movie' }),
        ]);
        m.titles.mockResolvedValue(
            new Map([
                [
                    'alb1',
                    {
                        title: 'Example Album',
                        seriesTitle: null,
                        season: null,
                        episode: null,
                        artist: 'Example Band',
                        album: null,
                    },
                ],
                [
                    'show1',
                    {
                        title: 'Example Show',
                        seriesTitle: null,
                        season: null,
                        episode: null,
                        artist: null,
                        album: null,
                    },
                ],
            ]),
        );
        const body = await ((await def.handlers.GET!(event, ctx())) as Response).json();
        // the context ids are looked up, not the newest member's item
        expect(m.titles).toHaveBeenCalledWith({}, ['alb1', 'show1']);
        expect(body.events[0]).toMatchObject({
            id: 'g1',
            count: 192,
            album: 'Example Album',
            artist: 'Example Band',
            mediaClass: 'music',
            mediaType: 'track',
        });
        expect(body.events[0].title).toBeUndefined();
        expect(body.events[1]).toMatchObject({ seriesTitle: 'Example Show', season: 3, count: 10 });
        expect(body.events[2]).toMatchObject({ count: 4, mediaType: 'movie' });
        expect(body.events[2].title).toBeUndefined();
    });

    it('a group request lists its downloads and nothing running', async () => {
        m.listMembers.mockResolvedValue([row({ id: 'a' }), row({ id: 'b', mediaItemId: 'm2' })]);
        m.titles.mockResolvedValue(
            new Map([
                [
                    'm1',
                    {
                        title: 'Song',
                        seriesTitle: null,
                        season: null,
                        episode: null,
                        artist: 'Example Band',
                        album: 'Example Album',
                    },
                ],
            ]),
        );
        const group = '00000000-0000-4000-8000-000000000009';
        const body = await ((await def.handlers.GET!(event, ctx({ group }))) as Response).json();
        expect(m.listMembers).toHaveBeenCalledWith({}, group);
        expect(m.listGroups).not.toHaveBeenCalled();
        expect(m.active).not.toHaveBeenCalled();
        expect(body.active).toEqual([]);
        expect(body.events.map((e: { id: string }) => e.id)).toEqual(['a', 'b']);
        expect(body.events[0]).toMatchObject({
            title: 'Song',
            artist: 'Example Band',
            album: 'Example Album',
            count: 1,
        });
        expect(body.nextBefore).toBeUndefined();
    });
});
