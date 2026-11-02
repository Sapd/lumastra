// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { mapMediaCredits } from '../catalog/media-id.js';
import { PersonCreditsSchema } from '$lib/schemas/api-person-responses.js';

describe('media detail credits', () => {
    it('maps cast order, characters and every crew job with canonical identities', () => {
        const out = mapMediaCredits(
            {
                cast: [
                    {
                        name: 'Actor',
                        person_id: '00123',
                        character: 'Hero',
                        order: 7,
                        profile_path: '/actor.jpg',
                    },
                ],
                crew: [
                    {
                        name: 'Director',
                        person_id: 'tmdb:00456',
                        job: 'Director',
                        department: 'Directing',
                    },
                    { name: 'Writer', tmdb_id: 789, job: 'Writer', department: 'Writing' },
                ],
                directors: ['Director'],
                creators: ['Creator'],
                writers: ['Writer'],
            },
            'v1',
        );
        expect(PersonCreditsSchema.safeParse(out).success).toBe(true);
        expect(out.cast[0]).toMatchObject({
            person: { id: 'tmdb:123', name: 'Actor' },
            character: 'Hero',
            order: 7,
        });
        expect(out.cast[0].person.images?.primary?.href).toContain(
            '/api/v1/people/tmdb%3A123/images/profile?size=w185&v=',
        );
        expect(out.crew.map((c) => c.job)).toEqual(['Director', 'Writer', 'Creator']);
        expect(out.crew[0]).toMatchObject({ person: { id: 'tmdb:456' }, department: 'Directing' });
    });
    it('uses null and omits images only for unknown identities', () => {
        const out = mapMediaCredits(
            {
                actors: ['Unknown'],
                directors: ['Flat director'],
                crew: [{ name: 'Bad id', person_id: 'jellyfin:abc', job: 'Writer' }],
            },
            'internal',
        );
        for (const row of [...out.cast, ...out.crew]) {
            expect(row.person.id).toBeNull();
            expect(row.person).not.toHaveProperty('images');
        }
        expect(out.cast[0].order).toBe(0);
    });
    it('recovers identities/order from preserved raw credits and creators', () => {
        const out = mapMediaCredits(
            {
                cast: [{ name: 'Actor', character: 'Hero' }],
                crew: [{ name: 'Writer', job: 'Screenplay' }],
                writers: ['Writer'],
                creators: ['Creator'],
                created_by: [{ id: 456, name: 'Creator' }],
                credits: {
                    cast: [{ id: 123, name: 'Actor', character: 'Hero', order: 4 }],
                    crew: [{ id: 789, name: 'Writer', job: 'Screenplay', department: 'Writing' }],
                },
            },
            'v1',
        );
        expect(out.cast[0]).toMatchObject({ person: { id: 'tmdb:123' }, order: 4 });
        expect(out.crew.map((c) => [c.job, c.person.id])).toEqual([
            ['Screenplay', 'tmdb:789'],
            ['Creator', 'tmdb:456'],
            ['Writer', 'tmdb:789'],
        ]);
    });
    it('recovers ids from the TMDB row when aggregated metadata dropped the raw credits', () => {
        const out = mapMediaCredits({ crew: [{ name: 'Director', job: 'Director' }] }, 'v1', {
            credits: { crew: [{ id: 123, name: 'Director', job: 'Director' }] },
        });
        expect(out.crew[0].person.id).toBe('tmdb:123');
    });
    it('returns both arrays for missing metadata', () => {
        expect(mapMediaCredits({}, 'v1')).toEqual({ cast: [], crew: [] });
    });
});
