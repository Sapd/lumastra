// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

vi.mock('$lib/server/database/queries/image-descriptor.queries.js', async () => {
    const { musicImageOwnerFixture } =
        await import('$lib/server/services/music/__tests__/image-fixtures.js');
    return {
        getImageDescriptorOwners: vi.fn(async (_sql: unknown, ids: string[]) =>
            ids.map((id) => musicImageOwnerFixture(id)),
        ),
    };
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { MusicTasteStationsResponseSchema } from '$lib/schemas/api-music-responses.js';

const mockGetSql = vi.fn();
const mockGetUserStations = vi.fn();

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));
vi.mock('$lib/server/services/music/stations.service.js', () => ({
    getUserStations: (...args: unknown[]) => mockGetUserStations(...args),
}));

const { def } = await import('./taste-stations.js');

function makeEvent(): RequestEvent {
    const url = 'http://localhost/api/v1/me/music/taste-stations';
    return {
        locals: { user: { userId: 'u1', username: 'alice' } },
        url: new URL(url),
        params: {},
        request: new Request(url),
    } as unknown as RequestEvent;
}

describe('user/music/taste-stations', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue({});
    });

    it('attaches a collage of visible sample tracks and never leaks coverTrackIds', async () => {
        mockGetUserStations.mockResolvedValue([
            {
                id: 'aaaaaaaaaaaa.0',
                label: 'A',
                playedTrackCount: 9,
                tagline: 't',
                coverTrackIds: ['t1', 't2'],
            },
            {
                id: 'aaaaaaaaaaaa.1',
                label: 'B',
                playedTrackCount: 4,
                tagline: 't',
                coverTrackIds: [],
            },
        ]);
        const res = await def.handlers.GET!(makeEvent(), { surface: 'v1' } as never);
        const raw = (await res.json()) as { items: Array<Record<string, unknown>> };
        expect(raw.items[0]).not.toHaveProperty('coverTrackIds');

        const { items } = MusicTasteStationsResponseSchema.parse(raw);
        expect(items[0].images?.primary?.variants?.thumb).toContain(
            '/api/v1/music/images/collage?ids=t1,t2&size=thumb&v=',
        );
        expect(items[1]).not.toHaveProperty('images');
    });

    it('exposes the version-bound id and playedTrackCount', async () => {
        mockGetUserStations.mockResolvedValue([
            {
                id: 'aaaaaaaaaaaa.0',
                label: 'A',
                playedTrackCount: 9,
                tagline: 't',
                coverTrackIds: [],
            },
        ]);
        const res = await def.handlers.GET!(makeEvent(), { surface: 'v1' } as never);
        const raw = (await res.json()) as { items: Array<Record<string, unknown>> };
        expect(raw.items[0]).toMatchObject({ id: 'aaaaaaaaaaaa.0', playedTrackCount: 9 });
        expect(raw.items[0]).not.toHaveProperty('index');
        expect(raw.items[0]).not.toHaveProperty('size');
    });

    it('returns an empty list when the user has no stations', async () => {
        mockGetUserStations.mockResolvedValue(null);
        const res = await def.handlers.GET!(makeEvent(), { surface: 'v1' } as never);
        expect(await res.json()).toEqual({ items: [] });
    });
});
