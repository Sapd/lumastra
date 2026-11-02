// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, afterEach } from 'vitest';
import {
    FIELD_PRIORITY_DEFAULT,
    aggregateFieldsWithGroupOverrides,
    getEffectiveFieldPriorities,
    resetFieldAuthorityCache,
    setEffectiveFieldPriorities,
} from './metadata-aggregation.queries.js';

// Provider manifests only declare the fields they "author" (title, actors, …).
// Prod, 2026-09-24: once the loader installed manifest-derived priorities,
// every default field no manifest named — cast, keyword_slugs, genre_slugs,
// tmdb_keyword_ids, age_rating_numeric, … — vanished from the aggregated row,
// so the detail API served name-only actors for 11,494 items.
describe('manifest-derived field priorities', () => {
    afterEach(() => resetFieldAuthorityCache());

    it('keep default fields that no manifest declares', () => {
        setEffectiveFieldPriorities({ title: ['tmdb'], actors: ['tmdb', 'jellyfin'] });
        const effective = getEffectiveFieldPriorities();
        for (const field of ['cast', 'keyword_slugs', 'genre_slugs', 'tmdb_keyword_ids']) {
            expect(effective[field]).toEqual(FIELD_PRIORITY_DEFAULT[field]);
        }
    });

    it('still let a manifest override a default field it declares', () => {
        setEffectiveFieldPriorities({ actors: ['jellyfin', 'tmdb'] });
        expect(getEffectiveFieldPriorities().actors).toEqual(['jellyfin', 'tmdb']);
    });

    // Manifests name providers by definition id; source rows live under the
    // provider_metadata key. Fresh install 2026-09-29: overview/poster/backdrop
    // never reached 'aggregated' because 'tmdb-metadata-provider' matched no row.
    it('resolve definition ids to provider_metadata keys', () => {
        setEffectiveFieldPriorities({
            overview: ['tmdb-metadata-provider'],
            rt_audience_score: ['mdblist-metadata-provider'],
        });
        const effective = getEffectiveFieldPriorities();
        expect(effective.overview).toEqual(['tmdb', 'jellyfin', 'mdblist']);
        expect(effective.rt_audience_score).toEqual(['mdblist']);

        const { aggregated, fieldSources } = aggregateFieldsWithGroupOverrides(
            new Map([['tmdb', { overview: 'A farmhouse under siege.' }]]),
            null,
            'movie',
        );
        expect(aggregated.overview).toBe('A farmhouse under siege.');
        expect(fieldSources.overview).toBe('tmdb');
    });

    it('keep the default fallback behind a declared chain', () => {
        setEffectiveFieldPriorities({ poster_path: ['tmdb-metadata-provider'] });
        const { aggregated, fieldSources } = aggregateFieldsWithGroupOverrides(
            new Map([['jellyfin', { poster_path: '/jf.jpg' }]]),
            null,
            'movie',
        );
        expect(aggregated.poster_path).toBe('/jf.jpg');
        expect(fieldSources.poster_path).toBe('jellyfin');
    });

    it('carry structured cast into the aggregated row', () => {
        setEffectiveFieldPriorities({ title: ['tmdb'], actors: ['tmdb', 'jellyfin'] });
        const cast = [{ name: 'Jules Fenwick', character: 'Arthur Fleck', person_id: '73421' }];
        const { aggregated, fieldSources } = aggregateFieldsWithGroupOverrides(
            new Map([['tmdb', { title: 'Jasper', actors: ['Jules Fenwick'], cast }]]),
            null,
            'movie',
        );
        expect(aggregated.cast).toEqual(cast);
        expect(fieldSources.cast).toBe('tmdb');
    });
});
