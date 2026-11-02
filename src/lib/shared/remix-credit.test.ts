// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { extractRemixerCandidates, findRemixCreditZones } from './remix-credit';

describe('extractRemixerCandidates', () => {
    it('extracts a bracketed remixer credit', () => {
        expect(extractRemixerCandidates('Harbortime (Ekoglow Remix)')).toEqual(['Ekoglow']);
    });

    it('extracts across a multi-keyword tail ("Remix Edit")', () => {
        expect(extractRemixerCandidates('Harbortime (Ekoglow Remix Edit)')).toEqual(['Ekoglow']);
    });

    it('is case-insensitive and keeps punctuation in the name (anonymized production shape)', () => {
        expect(extractRemixerCandidates('Where Is the Love (Cc.K remix edit)')).toEqual(['Cc.K']);
    });

    it('extracts a multi-word remixer before a "Bootleg Mix" tail (anonymized production shape)', () => {
        expect(
            extractRemixerCandidates('Bang The Drum (Allez Allez) (Dan Fenwick Bootleg Mix)'),
        ).toEqual(['Dan Fenwick']);
    });

    it('returns the whole collab candidate for later splitting', () => {
        expect(extractRemixerCandidates('Song (Megalanterns vs. DJ Lanternz Remix)')).toEqual([
            'Megalanterns vs. DJ Lanternz',
        ]);
    });

    it('supports the dash-suffix form', () => {
        expect(extractRemixerCandidates('Song - Ekoglow Remix')).toEqual(['Ekoglow']);
    });

    it('yields nothing for pure version tags', () => {
        expect(extractRemixerCandidates('Song (Club Mix)')).toEqual([]);
        expect(extractRemixerCandidates('Song (Radio Edit)')).toEqual([]);
        expect(extractRemixerCandidates('Song (Extended Mix)')).toEqual([]);
    });

    it('yields nothing for qualifier prefixes (blocklist)', () => {
        expect(extractRemixerCandidates('Song (Original Mix)')).toEqual([]);
        expect(extractRemixerCandidates('Song (Album Version)')).toEqual([]);
        expect(extractRemixerCandidates('Song (Single Edit)')).toEqual([]);
    });

    it('yields nothing for a year prefix', () => {
        expect(extractRemixerCandidates('Song (2005 Remaster)')).toEqual([]);
    });

    it('yields nothing when the tag has no version keyword', () => {
        expect(extractRemixerCandidates('Light The Way You Go (feat. Riona-Vale)')).toEqual([]);
        expect(extractRemixerCandidates('Song (Deluxe Edition)')).toEqual([]);
    });

    it('does not fire on plain titles', () => {
        expect(extractRemixerCandidates('Harbortime')).toEqual([]);
        expect(extractRemixerCandidates('Mixtape Anthem')).toEqual([]);
    });

    it('trims a stray leading bracket from a mixed-type double-wrapped tag', () => {
        expect(extractRemixerCandidates('Song [(Ekoglow Remix)]')).toEqual(['Ekoglow']);
    });

    it('trims a stray leading bracket from an unbalanced open-bracket tag', () => {
        expect(extractRemixerCandidates('((Ekoglow Remix)')).toEqual(['Ekoglow']);
    });

    it('unchanged: real punctuation in a name is never mistaken for a bracket (regression guard)', () => {
        expect(extractRemixerCandidates('Where Is the Love (Cc.K remix edit)')).toEqual(['Cc.K']);
    });
});

describe('findRemixCreditZones', () => {
    it('returns offsets that slice back to the candidate', () => {
        const title = 'Harbortime (Ekoglow Remix)';
        const [zone] = findRemixCreditZones(title);
        expect(title.slice(zone.start, zone.end)).toBe('Ekoglow');
    });

    it('zone for a multi-artist candidate spans the whole collab', () => {
        const title = 'Song (A x B Remix)';
        const [zone] = findRemixCreditZones(title);
        expect(title.slice(zone.start, zone.end)).toBe('A x B');
    });
});
