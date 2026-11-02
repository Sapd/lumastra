// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    buildQualitySummary,
    audioCodecLabel,
    isAtmos,
    type BestAudioStream,
} from './media-quality-summary.js';

function audio(partial: Partial<BestAudioStream>): BestAudioStream {
    return { codec: null, channels: null, channel_layout: null, profile: null, ...partial };
}

describe('buildQualitySummary — resolution', () => {
    it('maps the 4K tier to "2160p" and flags is4k', () => {
        const q = buildQualitySummary({ resolutionTier: '4K', hdrTier: null, bestAudio: null });
        expect(q).toEqual({ resolution: '2160p', is4k: true });
    });

    it('maps 1080p/720p/SD tiers with is4k false', () => {
        expect(
            buildQualitySummary({ resolutionTier: '1080p', hdrTier: null, bestAudio: null }),
        ).toEqual({
            resolution: '1080p',
            is4k: false,
        });
        expect(
            buildQualitySummary({ resolutionTier: '720p', hdrTier: null, bestAudio: null }),
        ).toEqual({
            resolution: '720p',
            is4k: false,
        });
        expect(
            buildQualitySummary({ resolutionTier: 'SD', hdrTier: null, bestAudio: null }),
        ).toEqual({
            resolution: '480p',
            is4k: false,
        });
    });

    it('omits resolution for an unknown/absent tier', () => {
        expect(
            buildQualitySummary({ resolutionTier: null, hdrTier: null, bestAudio: null }),
        ).toBeUndefined();
        expect(
            buildQualitySummary({ resolutionTier: 'weird', hdrTier: null, bestAudio: null }),
        ).toBeUndefined();
    });
});

describe('buildQualitySummary — videoRange', () => {
    it('maps the fine hdr_type to the client enum (incl. HDR10Plus / HLG)', () => {
        const cases: Array<[string, string]> = [
            ['dolby_vision', 'DolbyVision'],
            ['hdr10_plus', 'HDR10Plus'],
            ['hdr10', 'HDR10'],
            ['hlg', 'HLG'],
            ['sdr', 'SDR'],
        ];
        for (const [hdrType, expected] of cases) {
            expect(
                buildQualitySummary({
                    resolutionTier: null,
                    hdrType,
                    hdrTier: null,
                    bestAudio: null,
                }),
            ).toEqual({ videoRange: expected });
        }
    });

    it('prefers the fine hdr_type over the coarse hdr_tier', () => {
        // hdr_tier collapses HDR10+ to 'hdr'; hdr_type must win.
        expect(
            buildQualitySummary({
                resolutionTier: null,
                hdrType: 'hdr10_plus',
                hdrTier: 'hdr',
                bestAudio: null,
            }),
        ).toEqual({ videoRange: 'HDR10Plus' });
    });

    it('falls back to the coarse hdr_tier when hdr_type is absent (legacy/un-migrated rows)', () => {
        expect(
            buildQualitySummary({
                resolutionTier: null,
                hdrType: null,
                hdrTier: 'dolby_vision',
                bestAudio: null,
            }),
        ).toEqual({ videoRange: 'DolbyVision' });
        // Coarse 'hdr' can't distinguish HDR10+/HLG → reports HDR10.
        expect(
            buildQualitySummary({
                resolutionTier: null,
                hdrType: null,
                hdrTier: 'hdr',
                bestAudio: null,
            }),
        ).toEqual({ videoRange: 'HDR10' });
        expect(
            buildQualitySummary({
                resolutionTier: null,
                hdrType: null,
                hdrTier: 'sdr',
                bestAudio: null,
            }),
        ).toEqual({ videoRange: 'SDR' });
    });
});

describe('isAtmos', () => {
    it('detects Atmos from a descriptive profile string', () => {
        expect(isAtmos(audio({ codec: 'truehd', profile: 'Dolby TrueHD + Dolby Atmos' }))).toBe(
            true,
        );
        expect(isAtmos(audio({ codec: 'eac3', profile: 'Dolby Digital Plus + Dolby Atmos' }))).toBe(
            true,
        );
    });

    it('detects E-AC-3 JOC as Atmos', () => {
        expect(isAtmos(audio({ codec: 'eac3', profile: 'JOC' }))).toBe(true);
    });

    it('falls back to 8-channel TrueHD when profile is uninformative (local files)', () => {
        expect(isAtmos(audio({ codec: 'truehd', channels: 8, profile: null }))).toBe(true);
    });

    it('does NOT flag plain 5.1 TrueHD as Atmos', () => {
        expect(isAtmos(audio({ codec: 'truehd', channels: 6, profile: null }))).toBe(false);
    });

    it('does NOT channel-fallback for E-AC-3 (plain 7.1 DD+ is not Atmos)', () => {
        // 8-channel EAC3 with no profile marker is plain discrete 7.1, not JOC/Atmos.
        expect(isAtmos(audio({ codec: 'eac3', channels: 8, profile: null }))).toBe(false);
        // ...but a profile/JOC marker still wins regardless of channel count.
        expect(isAtmos(audio({ codec: 'eac3', channels: 6, profile: 'JOC' }))).toBe(true);
    });

    it('does not flag ordinary codecs', () => {
        expect(isAtmos(audio({ codec: 'dts', channels: 6 }))).toBe(false);
        expect(isAtmos(audio({ codec: 'aac', channels: 2 }))).toBe(false);
    });
});

describe('audioCodecLabel', () => {
    it('produces friendly codec labels', () => {
        expect(audioCodecLabel(audio({ codec: 'eac3', channels: 6 }))).toBe('EAC3');
        expect(audioCodecLabel(audio({ codec: 'dts', channels: 6 }))).toBe('DTS');
        expect(audioCodecLabel(audio({ codec: 'aac', channels: 2 }))).toBe('AAC');
        expect(audioCodecLabel(audio({ codec: 'flac', channels: 2 }))).toBe('FLAC');
    });

    it('appends " Atmos" when inferred', () => {
        expect(audioCodecLabel(audio({ codec: 'truehd', channels: 8, profile: 'Atmos' }))).toBe(
            'TrueHD Atmos',
        );
    });

    it('uppercases unknown codecs', () => {
        expect(audioCodecLabel(audio({ codec: 'wavpack', channels: 2 }))).toBe('WAVPACK');
    });

    it('returns undefined for missing audio', () => {
        expect(audioCodecLabel(null)).toBeUndefined();
        expect(audioCodecLabel(undefined)).toBeUndefined();
        expect(audioCodecLabel(audio({ codec: null }))).toBeUndefined();
    });
});

describe('buildQualitySummary — combined', () => {
    it('assembles resolution + range + audio for a top-tier movie', () => {
        const q = buildQualitySummary({
            resolutionTier: '4K',
            hdrType: 'dolby_vision',
            hdrTier: 'dolby_vision',
            bestAudio: audio({ codec: 'truehd', channels: 8, profile: 'TrueHD Atmos' }),
        });
        expect(q).toEqual({
            resolution: '2160p',
            is4k: true,
            videoRange: 'DolbyVision',
            audioCodec: 'TrueHD Atmos',
        });
    });

    it('surfaces HDR10Plus end-to-end (fine hdr_type)', () => {
        const q = buildQualitySummary({
            resolutionTier: '4K',
            hdrType: 'hdr10_plus',
            hdrTier: 'hdr',
            bestAudio: audio({ codec: 'eac3', channels: 6 }),
        });
        expect(q).toEqual({
            resolution: '2160p',
            is4k: true,
            videoRange: 'HDR10Plus',
            audioCodec: 'EAC3',
        });
    });

    it('returns undefined when nothing is known', () => {
        expect(
            buildQualitySummary({ resolutionTier: null, hdrTier: null, bestAudio: null }),
        ).toBeUndefined();
    });
});

describe('buildQualitySummary accessibility flags', () => {
    it('emits the flags that are true and omits false ones', () => {
        const s = buildQualitySummary({
            resolutionTier: '4K',
            hdrTier: 'sdr',
            hdrType: 'sdr',
            bestAudio: null,
            hasClosedCaptions: true,
            hasSDH: false,
            hasAudioDescription: true,
        });
        expect(s?.hasClosedCaptions).toBe(true);
        expect(s?.hasAudioDescription).toBe(true);
        expect(s?.hasSDH).toBeUndefined();
    });

    it('returns a summary when only a flag is set (no res/hdr/audio)', () => {
        const s = buildQualitySummary({
            resolutionTier: null,
            hdrTier: null,
            hdrType: null,
            bestAudio: null,
            hasClosedCaptions: true,
        });
        expect(s).toBeDefined();
        expect(s?.hasClosedCaptions).toBe(true);
    });

    it('still returns undefined when nothing at all is known', () => {
        expect(
            buildQualitySummary({
                resolutionTier: null,
                hdrTier: null,
                hdrType: null,
                bestAudio: null,
            }),
        ).toBeUndefined();
    });
});
