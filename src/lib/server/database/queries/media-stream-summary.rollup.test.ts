// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { rollupMajority, type UnitFacts } from './media-stream-summary.queries';

const base: Omit<UnitFacts, 'unitId'> = {
    audioLanguages: [],
    subtitleLanguages: [],
    hasAudioStream: false,
    hasSubtitleTrack: false,
    hasVideoStream: false,
    cc: false,
    sdh: false,
    ad: false,
};
const unit = (id: string, o: Partial<UnitFacts>): UnitFacts => ({ ...base, unitId: id, ...o });

describe('rollupMajority', () => {
    it('single unit (movie) = its own union', () => {
        const r = rollupMajority([
            unit('m', {
                audioLanguages: ['en', 'de'],
                subtitleLanguages: ['en'],
                hasAudioStream: true,
                hasSubtitleTrack: true,
                hasVideoStream: true,
                cc: true,
                sdh: true,
                ad: false,
            }),
        ]);
        expect(r.audioLanguages.sort()).toEqual(['de', 'en']);
        expect(r.subtitleLanguages).toEqual(['en']);
        expect(r.hasClosedCaptions).toBe(true);
        expect(r.hasSDH).toBe(true);
        expect(r.hasAudioDescription).toBe(false);
    });

    it('series: includes a language in a strict majority of episodes', () => {
        const r = rollupMajority([
            unit('1', { audioLanguages: ['en', 'de'], hasAudioStream: true }),
            unit('2', { audioLanguages: ['en', 'de'], hasAudioStream: true }),
            unit('3', { audioLanguages: ['en'], hasAudioStream: true }),
        ]);
        // en: 3/3, de: 2/3 (>50%) → both; denom 3
        expect(r.audioLanguages.sort()).toEqual(['de', 'en']);
    });

    it('series: excludes a language at exactly 50%', () => {
        const r = rollupMajority([
            unit('1', { audioLanguages: ['de'], hasAudioStream: true }),
            unit('2', { audioLanguages: [], hasAudioStream: true }),
        ]);
        // de: 1/2 → NOT strict majority
        expect(r.audioLanguages).toEqual([]);
    });

    it('per-kind denominator: episodes without subtitles do not dilute audio', () => {
        const r = rollupMajority([
            unit('1', { audioLanguages: ['en'], hasAudioStream: true }),
            unit('2', {
                audioLanguages: ['en'],
                hasAudioStream: true,
                subtitleLanguages: ['en'],
                hasSubtitleTrack: true,
            }),
        ]);
        // subtitle denom = 1 (only ep2 has subs); en subs 1/1 → included
        expect(r.subtitleLanguages).toEqual(['en']);
        expect(r.audioLanguages).toEqual(['en']);
    });

    it('CC majority uses episodes-with-video as denominator', () => {
        const r = rollupMajority([
            unit('1', { hasVideoStream: true, cc: true }),
            unit('2', { hasVideoStream: true, cc: true }),
            unit('3', { hasVideoStream: true, cc: false }),
        ]);
        expect(r.hasClosedCaptions).toBe(true); // 2/3
    });

    it('empty input → all empty/false', () => {
        const r = rollupMajority([]);
        expect(r).toEqual({
            audioLanguages: [],
            subtitleLanguages: [],
            hasClosedCaptions: false,
            hasSDH: false,
            hasAudioDescription: false,
        });
    });
});
