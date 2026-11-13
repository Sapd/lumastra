// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The inverse mapping a resumed setup wizard hydrates step 3 from. The
 * endpoint round-trip (POST body → saved keys → back) is pinned in
 * src/routes/api/setup/preferences/server.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { getDefaultValues } from './schema.js';
import {
    SETUP_PREFERENCE_FIELDS,
    preferencesFromConfig,
    savedUseCases,
} from './setup-preferences.js';

describe('preferencesFromConfig', () => {
    it('defaults new accounts to sharing unless the admin switches it off', () => {
        expect(getDefaultValues().DEFAULT_ACTIVITY_SHARING).toBe(true);
        expect(preferencesFromConfig({}).defaultActivitySharing).toBe(true);
        expect(
            preferencesFromConfig({ DEFAULT_ACTIVITY_SHARING: false }).defaultActivitySharing,
        ).toBe(false);
        expect(
            preferencesFromConfig({ DEFAULT_ACTIVITY_SHARING: true }).defaultActivitySharing,
        ).toBe(true);
    });

    it('reads the operator audience separately from per-user sharing choices', () => {
        expect(
            preferencesFromConfig({ SOCIAL_DEFAULT_AUDIENCE: 'groups' }).shareActivityBetweenUsers,
        ).toBe(false);
        for (const audience of ['auto', 'household', undefined]) {
            expect(
                preferencesFromConfig({ SOCIAL_DEFAULT_AUDIENCE: audience })
                    .shareActivityBetweenUsers,
            ).toBe(true);
        }
    });

    it('keeps the saved metadata location, falling back to central', () => {
        expect(
            preferencesFromConfig({ METADATA_STORAGE_LOCATION: 'alongside' })
                .metadataStorageLocation,
        ).toBe('alongside');
        expect(
            preferencesFromConfig({ METADATA_STORAGE_LOCATION: 'bogus' }).metadataStorageLocation,
        ).toBe('central');
    });

    it('reads contact with lumastra.org as on unless explicitly off', () => {
        expect(preferencesFromConfig({}).licenseServerContact).toBe(true);
        expect(
            preferencesFromConfig({ LICENSE_SERVER_CONTACT_ENABLED: false }).licenseServerContact,
        ).toBe(false);
    });

    it('returns every wizard field (drift guard)', () => {
        expect(Object.keys(preferencesFromConfig({})).sort()).toEqual(
            [...SETUP_PREFERENCE_FIELDS].sort(),
        );
    });
});

describe('savedUseCases', () => {
    it('keeps known ids and treats anything else as never saved', () => {
        expect(savedUseCases(['music', 'nope', 'vod'])).toEqual(['music', 'vod']);
        expect(savedUseCases([])).toEqual([]);
        expect(savedUseCases('music')).toEqual([]);
    });
});
