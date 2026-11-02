// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Schema-parity guard for GET /api/v1/people/{id}.
 *
 * `handlePersonGet` (`$lib/server/services/person.service.js`) always sends
 * `typedJson(PersonDetailResponseSchema, filtered)` — a FLAT object carrying
 * `movieCredits`/`tvCredits` arrays. This test asserts the schema registered
 * in this route's OpenAPI metadata is that exact schema (not a stale,
 * unrelated inline shape), and that it round-trips a realistic real-shaped
 * payload without stripping any fields — a schema drift here breaks the
 * tvOS client's strict decoder even though the live handler works fine.
 */

import { describe, it, expect } from 'vitest';
import { def } from '$lib/server/api/defs/catalog/people-id.js';
import { PersonDetailResponseSchema } from '$lib/schemas/api-person-responses.js';
import { personImageSet } from '$lib/server/services/image-descriptor/resources.js';

// The route's OpenAPI metadata now lives on the def as `def.docs` (migrated off
// the sibling `_openapi.ts`). Read it here so the contract assertions below run
// against the exact object the generator publishes.
const route = def.docs!;

// Mirrors the exact shape `handlePersonGet` builds and sends via typedJson
// (see person.service.ts's `PersonDetails`/`PersonMovieCredit`/`PersonTvCredit`).
const realPersonDetailPayload = {
    id: 'tmdb:6384',
    ids: { tmdb: '6384' },
    images: personImageSet('v1', 'tmdb:6384', '/profile.jpg'),
    creditsTruncated: false,
    name: 'Keiran Vale',
    biography: 'Canadian actor.',
    birthday: '1964-09-02',
    deathday: undefined,
    placeOfBirth: 'Beirut, Lebanon',
    knownForDepartment: 'Acting',
    popularity: 45.2,
    movieCredits: [
        {
            id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
            catalogId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
            ids: { tmdb: '603' },
            images: {},
            type: 'movie' as const,
            title: 'The Lantern',
            character: 'Neo',
            year: 1999,
            rating: 8.7,
            overview: 'A hacker learns the truth.',
            availability: { isAvailable: true, canRequest: false },
        },
    ],
    tvCredits: [
        {
            id: 'tmdb:1399:series',
            catalogId: null,
            ids: { tmdb: '1399' },
            images: {},
            type: 'series' as const,
            title: 'Some Series',
            character: 'Guest',
            year: 2011,
            rating: 9.0,
            overview: 'Kings and queens.',
            availability: { isAvailable: false, canRequest: true },
            episodeCount: 3,
        },
    ],
};

describe('/api/v1/people/{id} response schema', () => {
    it('registers the real PersonDetailResponseSchema, not a stale inline shape', () => {
        const responseDef = route.GET?.responses[200];
        if (!responseDef || typeof responseDef === 'string' || !('schema' in responseDef)) {
            throw new Error('Expected the 200 response to declare a schema');
        }
        expect(responseDef.schema).toBe(PersonDetailResponseSchema);
    });

    it('parses the real handler payload without stripping movieCredits/tvCredits or any field', () => {
        const responseDef = route.GET?.responses[200];
        if (!responseDef || typeof responseDef === 'string' || !('schema' in responseDef)) {
            throw new Error('Expected the 200 response to declare a schema');
        }

        const parsed = responseDef.schema.parse(realPersonDetailPayload) as Record<string, unknown>;

        expect(Object.keys(parsed).sort()).toEqual(Object.keys(realPersonDetailPayload).sort());
        expect(parsed.movieCredits).toEqual(realPersonDetailPayload.movieCredits);
        expect(parsed.tvCredits).toEqual(realPersonDetailPayload.tvCredits);
        expect(parsed.id).toBe(realPersonDetailPayload.id);
    });
});
