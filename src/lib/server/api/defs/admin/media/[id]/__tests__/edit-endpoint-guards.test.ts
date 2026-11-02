// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Request-shape and conflict guards on the admin media detail endpoints.
 * Each case was a 500 (or a silent success) for an input an operator or a
 * client bug can produce.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetDb = vi.fn();
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => mockGetDb() }));

const { saveAlbumArtist } = vi.hoisted(() => ({ saveAlbumArtist: vi.fn() }));
vi.mock('$lib/server/services/music/album-artist-edit.js', () => ({
    saveAlbumArtist,
    albumArtistSnapshot: vi.fn(),
}));

const deleteExternalId = vi.fn();
vi.mock('$lib/server/services/catalog.service.js', () => ({
    createCatalogService: () => ({ deleteExternalId: (...a: unknown[]) => deleteExternalId(...a) }),
    ExternalIdOwnedByAnotherItemError: class extends Error {},
}));

const getFilePathForMediaItem = vi.fn();
vi.mock('$lib/server/database/queries/media-files.queries.js', () => ({
    getFilePathForMediaItem: (...a: unknown[]) => getFilePathForMediaItem(...a),
}));
const resolveMediaPath = vi.fn();
vi.mock('$lib/server/utils/media-path-resolver.js', () => ({
    resolveMediaPath: (...a: unknown[]) => resolveMediaPath(...a),
}));
const probeRaw = vi.fn();
vi.mock('$lib/server/utils/ffprobe.js', () => ({ probeRaw: (...a: unknown[]) => probeRaw(...a) }));

const ITEM = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ARTIST = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

function event(opts: {
    method?: string;
    body?: unknown;
    search?: string;
    params?: Record<string, string>;
}): RequestEvent {
    const url = new URL(`http://localhost/api/admin/media/${ITEM}/x${opts.search ?? ''}`);
    return {
        url,
        params: { id: ITEM, ...opts.params },
        request: new Request(url.toString(), {
            method: opts.method ?? 'POST',
            headers: { 'content-type': 'application/json' },
            body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        }),
        locals: { user: { username: 'admin', ownerIsAdmin: true } },
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = (body?: unknown): any => ({ surface: 'internal', input: { body, query: {} } });

/** A tagged-template stand-in whose queries answer from a queue of row sets. */
function fakeSql(...answers: unknown[][]) {
    const queue = [...answers];
    const sql = (() => Promise.resolve(queue.shift() ?? [])) as unknown as Record<string, unknown>;
    sql.begin = async (fn: (tx: unknown) => Promise<unknown>) => fn(sql);
    return sql;
}

const uniqueViolation = (): Error => Object.assign(new Error('duplicate key'), { code: '23505' });

beforeEach(() => {
    vi.clearAllMocks();
});

describe('artist assignment conflicts', () => {
    it('moving an album onto an artist with a same-titled album is a 409', async () => {
        mockGetDb.mockReturnValue(
            fakeSql([{ media_type: 'album' }], [{ id: ARTIST, title: 'Band' }]),
        );
        saveAlbumArtist.mockRejectedValue(uniqueViolation());
        const { def } = await import('../artist.js');

        const res = await def.handlers.PATCH!(
            event({ method: 'PATCH', body: { artistId: ARTIST } }),
            ctx(),
        );

        expect(res.status).toBe(409);
        expect(saveAlbumArtist).toHaveBeenCalledOnce();
    });

    it('creating an artist whose name already exists is a 409', async () => {
        mockGetDb.mockReturnValue(fakeSql([{ media_type: 'album' }]));
        saveAlbumArtist.mockRejectedValue(uniqueViolation());
        const { def } = await import('../artist.js');

        const res = await def.handlers.POST!(
            event({ body: { artistName: 'Woven Assembly' } }),
            ctx(),
        );

        expect(res.status).toBe(409);
        expect(saveAlbumArtist).toHaveBeenCalledOnce();
    });

    it('rejects an overlong artist name before writing', async () => {
        mockGetDb.mockReturnValue(fakeSql());
        const { def } = await import('../artist.js');

        const res = await def.handlers.POST!(
            event({ body: { artistName: 'x'.repeat(300) } }),
            ctx(),
        );

        expect(res.status).toBe(422);
        expect(saveAlbumArtist).not.toHaveBeenCalled();
    });
});

describe('external id delete', () => {
    it('is a 404 when no row was deleted', async () => {
        mockGetDb.mockReturnValue(fakeSql([{ media_type: 'movie' }]));
        deleteExternalId.mockResolvedValue(0);
        const { def } = await import('../external-ids.js');

        const res = await def.handlers.DELETE!(
            event({ method: 'DELETE', search: '?provider=tvdb' }),
            ctx(),
        );

        expect(res.status).toBe(404);
    });
});

describe('season health path parameter', () => {
    it.each(['1abc', '99999999999', '-1'])('rejects %s before querying', async (value) => {
        const sql = vi.fn(() => Promise.resolve([]));
        mockGetDb.mockReturnValue(sql);
        const { def } = await import('../health/season/[seasonNumber]/index.js');

        const res = await def.handlers.GET!(
            event({ method: 'GET', params: { seasonNumber: value } }),
            ctx(),
        );

        expect(res.status).toBe(422);
        expect(sql).not.toHaveBeenCalled();
    });
});

describe('raw probe', () => {
    it('reports an unreadable file as unavailable instead of throwing', async () => {
        mockGetDb.mockReturnValue(fakeSql());
        getFilePathForMediaItem.mockResolvedValue('/data/movies/a.mkv');
        resolveMediaPath.mockResolvedValue({ isAccessible: true, containerPath: '/media/a.mkv' });
        probeRaw.mockRejectedValue(new Error('ffprobe exited with code 1'));
        const { def } = await import('../probe-raw.js');

        const res = await def.handlers.POST!(event({}), ctx({ fileId: ITEM }));

        expect(res.status).toBe(503);
        expect(probeRaw).toHaveBeenCalledWith('/media/a.mkv');
    });
});
