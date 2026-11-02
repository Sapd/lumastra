// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { isCatalogUuid, buildVirtualSeasonHandle, parseVirtualSeasonHandle, buildPreviewIdentity } from './media-handle.js';

const uuid = '550e8400-e29b-41d4-a716-446655440000';

describe('catalog handles', () => {
    it('recognises only dashed catalog UUIDs', () => {
        expect(isCatalogUuid(uuid)).toBe(true);
        expect(isCatalogUuid(uuid.toUpperCase())).toBe(true);
        for (const raw of [null, undefined, '', 'tmdb:550:movie', uuid.replaceAll('-', ''), `${uuid}-s1`]) {
            expect(isCatalogUuid(raw)).toBe(false);
        }
    });
    it.each(['standard', 'dvd', 'absolute', 'regional', 'other'] as const)('round-trips %s virtual seasons including specials', (ordering) => {
        for (const n of [0, 1, 99]) {
            const handle = buildVirtualSeasonHandle(uuid, ordering, n);
            expect(handle).toBe(`vseason:${uuid}:${ordering}:${n}`);
            expect(parseVirtualSeasonHandle(handle)).toEqual({ seriesUuid: uuid, ordering, seasonNumber: n });
        }
    });
    it.each(['', uuid, `${uuid}-s1`, `vseason:bad:dvd:1`, `vseason:${uuid}:unknown:1`,
        `vseason:${uuid}:dvd:-1`, `vseason:${uuid}:dvd:1.5`, `vseason:${uuid}:dvd:1junk`,
        `vseason:${uuid}:dvd:1:extra`, `vseason:${uuid}:dvd:`, `vseason:${uuid}:dvd:9007199254740992`])('rejects malformed virtual handle %s', (raw) => {
        expect(parseVirtualSeasonHandle(raw)).toBeNull();
    });
    it('does not build malformed virtual handles', () => {
        expect(() => buildVirtualSeasonHandle('bad', 'dvd', 1)).toThrow();
        for (const n of [-1, 1.5, NaN, Infinity]) expect(() => buildVirtualSeasonHandle(uuid, 'dvd', n)).toThrow();
    });
    it('prefers catalog identity regardless of provider and media type', () => {
        expect(buildPreviewIdentity({ uuid, provider: 'sonarr', providerId: 5, type: 'episode' }))
            .toEqual({ id: uuid, catalogId: uuid });
    });
    it.each(['movie', 'series'])('builds resolvable three-part %s discovery handles', (type) => {
        expect(buildPreviewIdentity({ provider: 'tmdb', providerId: 550, type }))
            .toEqual({ id: `tmdb:550:${type}`, catalogId: null });
    });
    it.each([
        { type: 'movie' }, { provider: 'sonarr', providerId: '123', type: 'series' },
        { provider: 'tmdb', providerId: '', type: 'movie' },
        { provider: 'tmdb', providerId: 0, type: 'movie' },
        { provider: 'tmdb', providerId: '123junk', type: 'movie' },
        { provider: 'tmdb', providerId: '1:movie', type: 'movie' },
        { provider: 'tmdb', providerId: 123, type: 'episode' },
        { uuid: 'invalid', type: 'movie' },
    ])('drops identities that cannot resolve: %j', (input) => {
        expect(buildPreviewIdentity(input)).toBeNull();
    });
});
