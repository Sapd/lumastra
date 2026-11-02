// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: async () => ({}) },
}));
const features = vi.hoisted(() => ({ musicClusters: true }));
vi.mock('$lib/server/config.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/config.js')>()),
    features,
}));
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: async () => ({}),
    searchAccessBoundary: () => ({ library: 'all', age: 'all' }),
}));
const getClusterShuffleTrack = vi.fn();
vi.mock('$lib/server/database/queries/audio-clusters.queries.js', () => ({
    CLUSTER_MODEL_ID: 'msclap-2023',
    getClusterShuffleTrack: (...a: unknown[]) => getClusterShuffleTrack(...a),
}));

const { createClusterShuffleHandlers } = await import('./cluster-shuffle-route.js');

const ROW = {
    media_id: '11111111-1111-4111-8111-111111111111',
    title: 'Café del Mar',
    artist_title: 'Björk & Friends',
    position: 3,
    track_count: 40,
};

function event(path: string, method = 'GET'): RequestEvent {
    const url = new URL(`http://localhost/api/v1/music/sonic-mixes/${path}`);
    return {
        url,
        params: { id: path.split('/')[0] },
        request: new Request(url, { method }),
        locals: { user: { userId: 'usr_1', username: 'testlistener' } },
        route: { id: '/api/v1/music/sonic-mixes/[id]/shuffle' },
    } as unknown as RequestEvent;
}

const serveTrack = vi.fn(async () => new Response('MP3', { status: 200 }));
const handlers = () => createClusterShuffleHandlers({ serveTrack });

beforeEach(() => {
    vi.clearAllMocks();
    features.musicClusters = true;
    getClusterShuffleTrack.mockResolvedValue(ROW);
});

describe('cluster shuffle route', () => {
    it('picks by cluster, seed and i, and forces MP3 at 128 kbps by default', async () => {
        const res = await handlers().GET(event('5/shuffle?seed=4000000000&i=43'));
        expect(res.status).toBe(200);
        expect(getClusterShuffleTrack).toHaveBeenCalledWith(
            {},
            'msclap-2023',
            5,
            4_000_000_000,
            43,
            expect.anything(),
        );
        expect(serveTrack).toHaveBeenCalledWith(expect.anything(), ROW.media_id, {
            bitrateKbps: 128,
            headers: {
                'X-Track-Id': ROW.media_id,
                'X-Artist': 'Bj%C3%B6rk%20%26%20Friends',
                'X-Title': 'Caf%C3%A9%20del%20Mar',
                'X-Track-Index': '3',
                'X-Track-Count': '40',
            },
        });
    });

    it('snaps the bitrate to the MP3 ladder', async () => {
        await handlers().GET(event('5/shuffle?seed=1&i=0&bitrateKbps=100'));
        expect(serveTrack).toHaveBeenCalledWith(
            expect.anything(),
            ROW.media_id,
            expect.objectContaining({ bitrateKbps: 96 }),
        );
    });

    it('HEAD returns the metadata without starting an encode', async () => {
        const res = await handlers().HEAD(event('5/shuffle?seed=1&i=0', 'HEAD'));
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('audio/mpeg');
        expect(res.headers.get('X-Title')).toBe('Caf%C3%A9%20del%20Mar');
        expect(serveTrack).not.toHaveBeenCalled();
    });

    it.each([
        ['abc/shuffle?seed=1&i=0'],
        ['5/shuffle?i=0'],
        ['5/shuffle?seed=-1&i=0'],
        ['5/shuffle?seed=4294967296&i=0'],
        ['5/shuffle?seed=1&i=1.5'],
    ])('422 for %s', async (path) => {
        const res = await handlers().GET(event(path));
        expect(res.status).toBe(422);
        expect(getClusterShuffleTrack).not.toHaveBeenCalled();
    });

    it('404 for a retired or empty cluster', async () => {
        getClusterShuffleTrack.mockResolvedValue(null);
        const res = await handlers().GET(event('99/shuffle?seed=1&i=0'));
        expect(res.status).toBe(404);
        expect(serveTrack).not.toHaveBeenCalled();
    });

    it('404 when sonic clusters are off', async () => {
        features.musicClusters = false;
        const res = await handlers().GET(event('5/shuffle?seed=1&i=0'));
        expect(res.status).toBe(404);
    });
});
