// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the parts of the visibility builder that are NOT SQL.
 *
 * The integration suite always passes `trustGroups` explicitly so its cases are
 * readable, which means it never exercises the default. The default is exactly
 * where a silent failure lives: read the wrong config key and the feature is
 * dark forever, with no error and no failing SQL. That is what these pin.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const configMock: { SOCIAL_TRUST_GROUPS: string[]; SOCIAL_DEFAULT_AUDIENCE: string } = {
    SOCIAL_TRUST_GROUPS: [],
    SOCIAL_DEFAULT_AUDIENCE: 'auto',
};

vi.mock('../../../config.js', () => ({
    get config() {
        return configMock;
    },
}));

const { getDesignatedTrustGroups, isSocialSharingConfigured, resolveSocialAudienceMode } =
    await import('./social-visibility.builder.js');

describe('getDesignatedTrustGroups', () => {
    beforeEach(() => {
        configMock.SOCIAL_TRUST_GROUPS = [];
    });

    it('defaults to config.SOCIAL_TRUST_GROUPS', () => {
        configMock.SOCIAL_TRUST_GROUPS = ['Household'];
        expect(getDesignatedTrustGroups()).toEqual(['Household']);
    });

    it('re-reads the config on every call (settings.json is live-editable)', () => {
        configMock.SOCIAL_TRUST_GROUPS = ['household'];
        expect(getDesignatedTrustGroups()).toEqual(['household']);
        // An admin adds a second circle without restarting.
        configMock.SOCIAL_TRUST_GROUPS = ['household', 'buchklub'];
        expect(getDesignatedTrustGroups()).toEqual(['household', 'buchklub']);
    });

    it('trims, de-duplicates and drops empties', () => {
        configMock.SOCIAL_TRUST_GROUPS = [' Household ', 'Household', '', '   ', 'Buchklub'];
        expect(getDesignatedTrustGroups()).toEqual(['Household', 'Buchklub']);
    });

    it('does NOT lowercase — the fold belongs to Postgres alone', () => {
        // JS `toLowerCase()` is Unicode-aware; Postgres `lower()` is collation
        // dependent and folds ASCII only under a `C`-locale database. Folding here
        // AND there made the two sides disagree on any non-ASCII circle name, so
        // `= ANY(...)` matched nothing and the circle went dark with no error.
        // Case-insensitive matching is asserted end-to-end in the integration
        // suite; this pins that the JS half stopped guessing at it.
        configMock.SOCIAL_TRUST_GROUPS = ['FAMÍLIA', ' Haushalt '];
        expect(getDesignatedTrustGroups()).toEqual(['FAMÍLIA', 'Haushalt']);
    });

    it('keeps two spellings of one circle rather than picking one for Postgres', () => {
        // Under a collation that folds them together the SQL collapses the
        // duplicate itself; under one that does not, dropping either spelling
        // would silently un-designate a circle somebody is actually in.
        configMock.SOCIAL_TRUST_GROUPS = ['Família', 'FAMÍLIA'];
        expect(getDesignatedTrustGroups()).toEqual(['Família', 'FAMÍLIA']);
    });

    it('prefers an explicit list over the config', () => {
        configMock.SOCIAL_TRUST_GROUPS = ['household'];
        expect(getDesignatedTrustGroups(['Nachbarn'])).toEqual(['Nachbarn']);
        // An explicitly EMPTY list means "no circle", not "fall back to config" —
        // otherwise a caller could never express the dark state.
        expect(getDesignatedTrustGroups([])).toEqual([]);
    });
});

describe('isSocialSharingConfigured', () => {
    beforeEach(() => {
        configMock.SOCIAL_TRUST_GROUPS = [];
        // These cases are about the GROUP mode's dark state, so pin it. Under the
        // default 'auto', no groups now means household, which is configured.
        configMock.SOCIAL_DEFAULT_AUDIENCE = 'groups';
    });

    it('is false with no configured circle, so admin surfaces can say "dark"', () => {
        expect(isSocialSharingConfigured()).toBe(false);
        configMock.SOCIAL_TRUST_GROUPS = ['   '];
        expect(isSocialSharingConfigured()).toBe(false);
    });

    it('is true once a circle is named', () => {
        configMock.SOCIAL_TRUST_GROUPS = ['household'];
        expect(isSocialSharingConfigured()).toBe(true);
    });

    it('is true in household mode with no groups at all', () => {
        // The whole point of household: nothing to configure. An admin surface must
        // not report this as "dark" — and `user/stream-privacy` must not tell the
        // user their listening circle is unconfigured, which would grey out their
        // own toggle.
        configMock.SOCIAL_DEFAULT_AUDIENCE = 'household';
        expect(isSocialSharingConfigured()).toBe(true);
    });

    it('is true under the default auto on a fresh install', () => {
        configMock.SOCIAL_DEFAULT_AUDIENCE = 'auto';
        expect(isSocialSharingConfigured()).toBe(true);
    });
});

describe('resolveSocialAudienceMode', () => {
    beforeEach(() => {
        configMock.SOCIAL_TRUST_GROUPS = [];
        configMock.SOCIAL_DEFAULT_AUDIENCE = 'auto';
    });

    it('auto resolves to household on a fresh install', () => {
        expect(resolveSocialAudienceMode()).toBe('household');
    });

    it('auto resolves to groups as soon as one is named', () => {
        // The upgrade-safety case: an operator who narrowed the audience keeps that
        // narrowing. Verified against production, where only 4 of 43 users are in the
        // configured circle — 'auto' must not widen that to 43.
        configMock.SOCIAL_TRUST_GROUPS = ['Librarians'];
        expect(resolveSocialAudienceMode()).toBe('groups');
    });

    it('auto ignores blank-only group entries', () => {
        configMock.SOCIAL_TRUST_GROUPS = ['  ', ''];
        expect(resolveSocialAudienceMode()).toBe('household');
    });

    it('explicit modes override auto in both directions', () => {
        configMock.SOCIAL_TRUST_GROUPS = ['Librarians'];
        configMock.SOCIAL_DEFAULT_AUDIENCE = 'household';
        expect(resolveSocialAudienceMode()).toBe('household');

        configMock.SOCIAL_TRUST_GROUPS = [];
        configMock.SOCIAL_DEFAULT_AUDIENCE = 'groups';
        expect(resolveSocialAudienceMode()).toBe('groups');
    });

    it('is case- and whitespace-insensitive', () => {
        configMock.SOCIAL_DEFAULT_AUDIENCE = '  HouseHold ';
        expect(resolveSocialAudienceMode()).toBe('household');
    });

    it('falls back to groups on an unrecognised value, never household', () => {
        // A typo in settings.json must under-share, not over-share.
        configMock.SOCIAL_DEFAULT_AUDIENCE = 'everyone';
        expect(resolveSocialAudienceMode()).toBe('groups');
        configMock.SOCIAL_DEFAULT_AUDIENCE = '';
        expect(resolveSocialAudienceMode()).toBe('groups');
    });

    it('survives a non-string settings.json value instead of throwing', () => {
        // `getConfig` hands back settings.json values with a CAST, not a coercion, so
        // `"SOCIAL_DEFAULT_AUDIENCE": false` arrives here as a boolean. This function
        // is inside the predicate every social surface calls — a throw here is a 500
        // on all of them, from one bad character in a hand-edited file.
        for (const bad of [false, 0, 1, {}, []] as unknown[]) {
            configMock.SOCIAL_DEFAULT_AUDIENCE = bad as string;
            expect(() => resolveSocialAudienceMode()).not.toThrow();
            expect(resolveSocialAudienceMode()).toBe('groups');
        }

        // `null` is the one non-string that must NOT collapse to 'groups': it means
        // "unset", which is exactly how `getConfig` itself treats it (`val !== null`
        // before returning), so it has to reach the 'auto' default.
        configMock.SOCIAL_DEFAULT_AUDIENCE = null as unknown as string;
        expect(resolveSocialAudienceMode()).toBe('household');
        configMock.SOCIAL_TRUST_GROUPS = ['family'];
        expect(resolveSocialAudienceMode()).toBe('groups');
    });

    it('accepts explicit arguments over config', () => {
        configMock.SOCIAL_DEFAULT_AUDIENCE = 'household';
        expect(resolveSocialAudienceMode('auto', ['family'])).toBe('groups');
        expect(resolveSocialAudienceMode('auto', [])).toBe('household');
    });
});
