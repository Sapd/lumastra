// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { getImageDescriptorOwners, type ImageOwnerRow } from '$lib/server/database/queries/image-descriptor.queries.js';
import { resolveImageSet, resolveImageSets, userAvatarSet } from './index.js';
vi.mock('$app/paths', () => ({ base: '/lumastra' }));
vi.mock('$lib/server/database/queries/image-descriptor.queries.js', () => ({ getImageDescriptorOwners: vi.fn() }));
const query = vi.mocked(getImageDescriptorOwners);
const sql = {} as postgres.Sql;
function owner(id: string, media_type = 'movie', parent_id: string | null = null): ImageOwnerRow {
    return { id, media_type, parent_id, is_various_artists: false,
        preferred_provider: null, poster_blurhash: null,
        backdrop_blurhash: null, local_artwork: {}, provider_paths: {}, custom_urls: {} };
}
beforeEach(() => { query.mockReset(); });
describe('batched resolution', () => {
    it('does no read for empty input, and one read for hundreds of items', async () => {
        expect(await resolveImageSets(sql, 'v1', [])).toEqual(new Map());
        expect(query).not.toHaveBeenCalled();
        const rows = Array.from({ length: 500 }, (_, i) => owner(String(i)));
        query.mockResolvedValue(rows);
        const result = await resolveImageSets(sql, 'v1', rows.map(({ id }) => ({ id })));
        expect(result.size).toBe(500);
        expect(query).toHaveBeenCalledExactlyOnceWith(sql, rows.map(({ id }) => id));
    });
    it('reports only stored roles and missing items as empty sets', async () => {
        const row = owner('movie'); row.custom_urls.logo = 'https://example.com/logo';
        query.mockResolvedValue([row]);
        expect(Object.keys(await resolveImageSet(sql, 'v1', 'movie'))).toEqual(['logo']);
        expect(await resolveImageSet(sql, 'v1', 'missing')).toEqual({});
    });
    it('uses owner URLs, revisions, and blurhash, including primary mapped to poster', async () => {
        const album = owner('album', 'album'); album.provider_paths.poster = '/cover'; album.poster_blurhash = 'album-hash';
        query.mockResolvedValue([album, owner('track', 'track', 'album')]);
        const sets = await resolveImageSets(sql, 'v1', [{ id: 'track' }, { id: 'album' }]);
        expect(sets.get('track')?.primary).toEqual({ ...sets.get('album')?.primary, source: 'album' });
        expect(sets.get('track')?.primary?.href).toContain('/lumastra/api/v1/media/album/images/poster?size=card&v=');
        expect(sets.get('track')?.primary?.placeholder).toEqual({ blurhash: 'album-hash' });
        expect(await resolveImageSet(sql, 'v1', 'track', undefined, { inherit: 'none' })).toEqual({});
    });
    it('prioritizes own still, then own extracted backdrop, then series backdrop', async () => {
        const series = owner('series', 'tv'); series.provider_paths.poster = '/poster'; series.provider_paths.backdrop = '/bg';
        const season = owner('season', 'season', 'series'); season.provider_paths.thumb = '/season-still';
        const episode = owner('episode', 'episode', 'season');
        query.mockResolvedValue([series, season, episode]);
        expect((await resolveImageSet(sql, 'internal', 'episode')).thumb?.href).toContain('/series/images/backdrop?');
        episode.local_artwork.backdrop = { path: '/frame', updatedAt: 'today' };
        expect((await resolveImageSet(sql, 'internal', 'episode')).thumb?.href).toContain('/episode/images/backdrop?');
        expect((await resolveImageSet(sql, 'internal', 'episode')).thumb?.source).toBe('frame');
        episode.custom_urls.thumb = 'https://example.com/still';
        expect((await resolveImageSet(sql, 'internal', 'episode')).thumb?.href).toContain('/episode/images/thumb?');
        episode.local_artwork = {}; episode.custom_urls = {}; series.provider_paths.backdrop = null;
        expect((await resolveImageSet(sql, 'internal', 'episode')).thumb).toBeUndefined();
    });
    it('batches album artist fallbacks with owner revisions, then prefers a real album cover', async () => {
        const artist = owner('artist', 'artist');
        artist.local_artwork.poster = { path: '/artist', updatedAt: 'now' };
        artist.poster_blurhash = 'artist-hash';
        const albums = Array.from({ length: 500 }, (_, i) => owner(`album-${i}`, 'album', 'artist'));
        query.mockResolvedValue([artist, ...albums, owner('track', 'track', albums[0].id)]);
        const sets = await resolveImageSets(sql, 'internal', albums.map(({ id }) => ({ id })));
        expect(query).toHaveBeenCalledTimes(1);
        const fallback = sets.get(albums[0].id)?.primary;
        expect(fallback?.source).toBe('artist');
        expect(fallback?.href).toContain('/api/media/artist/images/poster?size=card&v=');
        expect(fallback?.placeholder).toEqual({ blurhash: 'artist-hash' });
        expect(fallback?.variants?.thumb).toContain(`&v=${fallback?.revision}`);
        expect([...sets.values()].every((set) => set.primary?.revision === fallback?.revision)).toBe(true);
        expect(await resolveImageSet(sql, 'internal', 'track')).toEqual({});
        expect(await resolveImageSet(sql, 'internal', albums[0].id, undefined, { inherit: 'none' })).toEqual({});
        albums[0].provider_paths.poster = '/cover';
        const own = (await resolveImageSet(sql, 'internal', albums[0].id)).primary;
        expect(own?.source).toBe('self');
        expect(own?.href).toContain(`/media/${albums[0].id}/images/poster?`);
        expect(own?.revision).not.toBe(fallback?.revision);
        expect(own?.variants?.thumb).not.toBe(fallback?.variants?.thumb);
    });
    it('omits album artwork when neither owner has a cover or the artist is Various Artists', async () => {
        const artist = owner('artist', 'artist');
        query.mockResolvedValue([artist, owner('album', 'album', 'artist')]);
        expect(await resolveImageSet(sql, 'v1', 'album')).toEqual({});
        artist.custom_urls.poster = 'https://example.com/artist';
        artist.is_various_artists = true;
        expect(await resolveImageSet(sql, 'v1', 'album')).toEqual({});
        const album = owner('album', 'album', 'artist');
        album.custom_urls.poster = 'https://example.com/album';
        query.mockResolvedValue([artist, album]);
        expect((await resolveImageSet(sql, 'v1', 'album')).primary?.source).toBe('self');
    });
    it('checks self before ancestors regardless of their source and respects the three-edge bound', async () => {
        const series = owner('series', 'tv'); series.local_artwork.poster = { path: '/series', updatedAt: 'now' };
        const season = owner('season', 'season', 'series'); season.custom_urls.poster = 'own';
        query.mockResolvedValue([series, season]);
        expect((await resolveImageSet(sql, 'v1', 'season')).poster?.source).toBe('self');
        query.mockResolvedValue([series, owner('a', 'season', 'series'), owner('b', 'season', 'a'), owner('c', 'season', 'b'), owner('e', 'episode', 'c')]);
        expect((await resolveImageSet(sql, 'v1', 'e')).poster).toBeUndefined();
    });
    it('uses the stored media type, not a caller-supplied one', async () => {
        const row = owner('x'); row.provider_paths.poster = '/cover'; query.mockResolvedValue([row]);
        expect((await resolveImageSet(sql, 'v1', 'x', 'album')).primary).toBeUndefined();
    });
    it('builds versioned avatars on both surfaces', () => {
        for (const surface of ['v1', 'internal'] as const) {
            const avatar = userAvatarSet(surface, { userId: 'user', version: '123' }).primary;
            expect(avatar?.href).toBe(`/lumastra/api${surface === 'v1' ? '/v1' : ''}/users/user/images/avatar?size=card&v=123`);
            expect(avatar?.source).toBe('self'); expect(avatar?.revision).toBe('123');
            expect(avatar?.variants?.thumb).toContain('size=thumb&v=123');
        }
    });
});
