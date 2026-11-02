// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/config', () => ({ config: { JWT_SECRET: 'test-jwt-secret' } }));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));
vi.mock('$lib/server/database', () => ({ getDb: () => null }));
vi.mock('$lib/server/services/image-proxy', () => ({
    getImageProxyService: vi.fn(),
    imageResponse: vi.fn(),
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({ checkMediaAccess: vi.fn() }));
vi.mock('./access-context', () => ({ buildJellyfinAccessContext: vi.fn() }));
vi.mock('$lib/server/utils/api-responses', () => ({ ApiResponses: {} }));
vi.mock('$lib/server/database/queries/jellyfin-people.queries', () => ({
    getItemCredits: vi.fn(),
    getItemStudiosAndTags: vi.fn(),
}));

import {
    parseCreditFields,
    parsePersonTypes,
    personImageTag,
    serializePersonItem,
    serializeStudioItem,
    verifyPersonImageTag,
} from './people-studios';
import { studioOwnerTypes } from './people-studios-handlers';

const PERSON = '7d77590c-beb3-3d09-2b32-c0d51e5e359e';
const OTHER = '0d0f9b5e-2f0e-4a59-9a3e-5d0c2b3e1a11';

describe('person types', () => {
    it('maps Jellyfin kinds to credit roles, case-insensitively', () => {
        expect(parsePersonTypes(null)).toEqual(['actor', 'director', 'writer', 'producer']);
        expect(parsePersonTypes('Actor,director')).toEqual(['actor', 'director']);
        expect(parsePersonTypes('Writer|Producer')).toEqual(['writer', 'producer']);
    });

    it('kinds Lumastra keeps no credits for match nothing', () => {
        expect(parsePersonTypes('GuestStar')).toEqual([]);
        expect(parsePersonTypes('GuestStar,Actor')).toEqual(['actor']);
    });

    it('excludePersonTypes removes roles', () => {
        expect(parsePersonTypes(null, 'Actor,Producer')).toEqual(['director', 'writer']);
        expect(parsePersonTypes('Actor', 'Actor')).toEqual([]);
    });
});

describe('person image tag', () => {
    it('is 40 hex chars, carries the TMDB id and verifies only for its person', () => {
        const tag = personImageTag(PERSON, '1234')!;
        expect(tag).toMatch(/^[0-9a-f]{40}$/);
        expect(verifyPersonImageTag(PERSON, tag)).toBe(1234);
        expect(verifyPersonImageTag(PERSON.replace(/-/g, '').toUpperCase(), tag)).toBe(1234);
        expect(verifyPersonImageTag(OTHER, tag)).toBeNull();
    });

    it('rejects a forged TMDB id, junk and a missing tag', () => {
        const tag = personImageTag(PERSON, 1234)!;
        const forged = (5678).toString(16).padStart(8, '0') + tag.slice(8);
        expect(verifyPersonImageTag(PERSON, forged)).toBeNull();
        expect(verifyPersonImageTag(PERSON, 'abc')).toBeNull();
        expect(verifyPersonImageTag(PERSON, null)).toBeNull();
        expect(personImageTag(PERSON, 'x')).toBeUndefined();
        expect(personImageTag(PERSON, 0)).toBeUndefined();
    });
});

describe('Fields', () => {
    it('reads People / Studios / Tags', () => {
        expect(parseCreditFields('Overview,people,Tags')).toEqual({
            people: true,
            studios: false,
            tags: true,
        });
        expect(parseCreditFields(null)).toEqual({ people: false, studios: false, tags: false });
    });
});

describe('Person and Studio items', () => {
    const row = {
        id: PERSON,
        name: 'Ana Actor',
        movie_count: 2,
        series_count: 1,
        tmdb_id: '101',
        has_profile: null,
    };

    it('a person carries the SDK-required fields, image tag and provider id', () => {
        const item = serializePersonItem(row);
        expect(item).toMatchObject({
            Id: PERSON,
            Type: 'Person',
            MediaType: 'Unknown',
            MovieCount: 2,
            SeriesCount: 1,
            ProviderIds: { Tmdb: '101' },
        });
        expect(verifyPersonImageTag(PERSON, item.ImageTags!.Primary)).toBe(101);
    });

    it('no image tag when the provider has no headshot', () => {
        expect(serializePersonItem({ ...row, has_profile: false }).ImageTags).toEqual({});
        expect(serializePersonItem({ ...row, tmdb_id: null }).ImageTags).toEqual({});
    });

    it('biography: overview, birthday, deathday, birthplace; junk dates dropped', () => {
        const item = serializePersonItem(row, {
            biography: 'Bio',
            birthday: '1950-01-02',
            deathday: '2020-03-04',
            placeOfBirth: 'Graz',
        });
        expect(item).toMatchObject({
            Overview: 'Bio',
            PremiereDate: '1950-01-02T00:00:00.0000000Z',
            ProductionYear: 1950,
            EndDate: '2020-03-04T00:00:00.0000000Z',
            ProductionLocations: ['Graz'],
        });
        expect(serializePersonItem(row, { birthday: 'unknown' }).PremiereDate).toBeUndefined();
    });

    it('a studio has no artwork', () => {
        expect(
            serializeStudioItem({ id: OTHER, name: 'Acme', movie_count: 1, series_count: 0 }),
        ).toMatchObject({ Type: 'Studio', ImageTags: {}, BackdropImageTags: [] });
    });
});

describe('studio owner types', () => {
    it('IncludeItemTypes / ExcludeItemTypes pick movies and series', () => {
        expect(studioOwnerTypes(null, null)).toEqual(['movie', 'tv']);
        expect(studioOwnerTypes('Series', null)).toEqual(['tv']);
        expect(studioOwnerTypes(null, 'Movie')).toEqual(['tv']);
        expect(studioOwnerTypes('MusicAlbum', null)).toEqual([]);
    });
});
