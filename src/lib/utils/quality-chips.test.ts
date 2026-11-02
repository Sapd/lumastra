// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { buildQualityChips, qualitySummaryFromTiers } from './quality-chips.js';

describe('buildQualityChips', () => {
    it('returns no chips for missing/empty quality', () => {
        expect(buildQualityChips(undefined)).toEqual([]);
        expect(buildQualityChips(null)).toEqual([]);
        expect(buildQualityChips({})).toEqual([]);
    });

    it('badges 4K (but not sub-4K resolutions)', () => {
        expect(buildQualityChips({ is4k: true, resolution: '2160p' })).toEqual([
            { label: '4K', tooltip: '4K Ultra HD (2160p)', tone: 'amber' },
        ]);
        // 1080p carries no is4k → no resolution badge.
        expect(buildQualityChips({ resolution: '1080p' })).toEqual([]);
    });

    it('maps each videoRange to its badge, and omits SDR', () => {
        expect(buildQualityChips({ videoRange: 'DolbyVision' })[0]).toMatchObject({
            label: 'Dolby Vision',
            tone: 'purple',
        });
        expect(buildQualityChips({ videoRange: 'HDR10Plus' })[0]).toMatchObject({
            label: 'HDR10+',
            tone: 'orange',
        });
        expect(buildQualityChips({ videoRange: 'HDR10' })[0]).toMatchObject({
            label: 'HDR',
            tone: 'orange',
        });
        expect(buildQualityChips({ videoRange: 'HLG' })[0]).toMatchObject({
            label: 'HLG',
            tone: 'orange',
        });
        expect(buildQualityChips({ videoRange: 'SDR' })).toEqual([]);
    });

    it('badges Atmos only when the audio codec says so', () => {
        expect(buildQualityChips({ audioCodec: 'TrueHD Atmos' })).toEqual([
            { label: 'Atmos', tooltip: 'Dolby Atmos (TrueHD Atmos)', tone: 'cyan' },
        ]);
        expect(buildQualityChips({ audioCodec: 'EAC3 Atmos' })[0]?.label).toBe('Atmos');
        // Plain codecs → no audio chip.
        expect(buildQualityChips({ audioCodec: 'EAC3' })).toEqual([]);
        expect(buildQualityChips({ audioCodec: 'DTS-HD' })).toEqual([]);
    });

    it('assembles resolution → range → audio in order for a top-tier item', () => {
        const chips = buildQualityChips({
            is4k: true,
            resolution: '2160p',
            videoRange: 'DolbyVision',
            audioCodec: 'TrueHD Atmos',
        });
        expect(chips.map((c) => c.label)).toEqual(['4K', 'Dolby Vision', 'Atmos']);
    });

    it('badges CC, SDH, and AD when flags are set', () => {
        expect(buildQualityChips({ hasClosedCaptions: true })).toEqual([
            { label: 'CC', tooltip: 'Closed captions available', tone: 'cyan' },
        ]);
        expect(buildQualityChips({ hasSDH: true })).toEqual([
            { label: 'SDH', tooltip: 'Subtitles for the deaf and hard-of-hearing', tone: 'cyan' },
        ]);
        expect(buildQualityChips({ hasAudioDescription: true })).toEqual([
            { label: 'AD', tooltip: 'Audio description available', tone: 'cyan' },
        ]);
    });

    it('omits CC, SDH, AD when flags are false or absent', () => {
        expect(buildQualityChips({ hasClosedCaptions: false })).toEqual([]);
        expect(buildQualityChips({ hasSDH: false })).toEqual([]);
        expect(buildQualityChips({ hasAudioDescription: false })).toEqual([]);
    });

    it('orders quality chips: resolution → range → audio → CC/SDH/AD', () => {
        const chips = buildQualityChips({
            is4k: true,
            videoRange: 'HDR10Plus',
            audioCodec: 'EAC3 Atmos',
            hasClosedCaptions: true,
            hasSDH: true,
            hasAudioDescription: true,
        });
        expect(chips.map((c) => c.label)).toEqual(['4K', 'HDR10+', 'Atmos', 'CC', 'SDH', 'AD']);
    });
});

describe('qualitySummaryFromTiers', () => {
    it('returns null when the projection has no tiers for the item', () => {
        expect(qualitySummaryFromTiers(null, null)).toBeNull();
        expect(qualitySummaryFromTiers(undefined, undefined)).toBeNull();
    });

    it('maps a 4K Dolby Vision item to the 4K + Dolby Vision badges', () => {
        const chips = buildQualityChips(qualitySummaryFromTiers('4K', 'dolby_vision'));
        expect(chips.map((c) => c.label)).toEqual(['4K', 'Dolby Vision']);
    });

    it('renders a generic HDR badge for the coarse hdr tier', () => {
        const chips = buildQualityChips(qualitySummaryFromTiers('1080p', 'hdr'));
        expect(chips.map((c) => c.label)).toEqual(['HDR']);
    });

    it('emits nothing for a plain 1080p SDR item', () => {
        expect(buildQualityChips(qualitySummaryFromTiers('1080p', 'sdr'))).toEqual([]);
    });

    it('emits the full Apple-TV-style badge row from projection flags', () => {
        const chips = buildQualityChips(
            qualitySummaryFromTiers('4K', 'dolby_vision', {
                hasAtmos: true,
                hasCc: true,
                hasSdh: true,
                hasAd: true,
            }),
        );
        expect(chips.map((c) => c.label)).toEqual([
            '4K',
            'Dolby Vision',
            'Atmos',
            'CC',
            'SDH',
            'AD',
        ]);
    });

    it('omits badges whose flags are false', () => {
        const chips = buildQualityChips(
            qualitySummaryFromTiers('1080p', 'sdr', {
                hasAtmos: false,
                hasCc: true,
                hasSdh: false,
                hasAd: false,
            }),
        );
        expect(chips.map((c) => c.label)).toEqual(['CC']);
    });

    it('does not render "Dolby Atmos (undefined)" when no codec label is carried', () => {
        const [atmos] = buildQualityChips(qualitySummaryFromTiers(null, null, { hasAtmos: true }));
        expect(atmos.tooltip).toBe('Dolby Atmos');
    });

    it('still returns null when there are neither tiers nor flags', () => {
        expect(
            qualitySummaryFromTiers(null, null, {
                hasAtmos: false,
                hasCc: false,
                hasSdh: false,
                hasAd: false,
            }),
        ).toBeNull();
    });
});
