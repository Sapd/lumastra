// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** GET /api/admin/downloads: running downloads plus the download log. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';
import type { DownloadEventRow } from '$lib/server/database/queries/download-events.queries.js';

const m = vi.hoisted(() => ({
    listEvents: vi.fn(),
    listOpen: vi.fn(),
    titles: vi.fn(),
    names: vi.fn(),
    userByName: vi.fn(),
    active: vi.fn(),
    cap: { v: 0 },
}));

vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/download-events.queries.js', () => ({
    listDownloadEvents: m.listEvents,
    listOpenDownloadEvents: m.listOpen,
    getDownloadTitles: m.titles,
    getUsernamesByIds: m.names,
}));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserByUsername: m.userByName,
}));
vi.mock('$lib/server/services/download-leases.js', () => ({
    listActiveDownloads: m.active,
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
    m.listEvents.mockResolvedValue([]);
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
        m.listEvents.mockResolvedValue([
            row({ id: 'e2', mediaItemId: 'm2', outcome: 'denied', bytesSent: 0 }),
            row({ id: 'e1' }),
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
        expect(m.listEvents).toHaveBeenCalledWith(
            {},
            { userId: 'u1', limit: 50, before: undefined },
        );
    });

    it('returns an empty list for an unknown user filter', async () => {
        const res = (await def.handlers.GET!(event, ctx({ user: 'nobody' }))) as Response;
        expect((await res.json()).events).toEqual([]);
        expect(m.listEvents).not.toHaveBeenCalled();
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
        const before = new Date('2026-11-16T09:00:00Z');
        await def.handlers.GET!(event, ctx({ before }));
        expect(m.listEvents).toHaveBeenCalledWith({}, { userId: undefined, limit: 50, before });
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
});
