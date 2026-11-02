// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The metro map renders in the browser and cannot import the server-only task
 * registry, so it mirrors every stage's appliesTo + resourceClass. Both maps
 * are ESLint ERRORS when a stage id is missing
 * (callback-safety/stage-applies-to-mirror-in-sync, eslint.config.cjs:135).
 * This test gives the same guarantee a developer can see without running lint.
 */

import { describe, it, expect } from 'vitest';
import { STAGE_APPLIES_TO, STAGE_RESOURCE_CLASS, stageAppliesTo } from './ingest-map.constants.js';

const EXPECTED: Record<string, string[]> = {
    'provider-artwork-poster': ['movie', 'series', 'episode'],
    'provider-artwork-backdrop': ['movie', 'series', 'episode'],
    'provider-artwork-logo': ['movie', 'series'],
    'provider-artwork-thumb': ['episode'],
    'provider-artwork-season-poster': ['season'],
};

describe('provider-artwork stages in the metro mirror', () => {
    it.each(Object.entries(EXPECTED))('STAGE_APPLIES_TO[%s] matches the task file', (id, list) => {
        expect(STAGE_APPLIES_TO[id]).toBeDefined();
        expect([...STAGE_APPLIES_TO[id]]).toEqual(list);
    });

    it.each(Object.keys(EXPECTED))('STAGE_RESOURCE_CLASS[%s] is bulk', (id) => {
        expect(STAGE_RESOURCE_CLASS[id]).toBe('bulk');
    });

    it('translates the DB-side tv spelling to the SDK series spelling', () => {
        // canonicalMediaType promotes 'tv' -> 'series' before the lookup, so a
        // real media_items row (media_type='tv') must match the series stages.
        expect(stageAppliesTo('provider-artwork-logo', 'tv')).toBe(true);
        expect(stageAppliesTo('provider-artwork-logo', 'episode')).toBe(false);
        expect(stageAppliesTo('provider-artwork-season-poster', 'season')).toBe(true);
        expect(stageAppliesTo('provider-artwork-season-poster', 'tv')).toBe(false);
    });
});
