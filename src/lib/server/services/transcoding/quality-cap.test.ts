// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    parseQualityCapParams,
    isEmptyQualityCap,
    sourceExceedsQualityCap,
    effectiveCapHeight,
    computeImpliedBitrateBudgetBps,
    computeEffectiveBudgetBps,
    computeAudioReservationBps,
    computeCappedVideoBitrateMbps,
    computeCappedDimensions,
    resolveDeliveredAudioTracks,
    computeQualityCapReservation,
    parseBitrateString,
    parseMaxAudioChannelsParam,
    MIN_MAX_BITRATE_BPS,
    MAX_MAX_BITRATE_BPS,
    MIN_MAX_HEIGHT_PX,
    MAX_MAX_HEIGHT_PX,
    MIN_AUDIO_RESERVATION_BPS,
    MAX_AUDIO_RESERVATION_BPS,
    AUDIO_DOWNMIX_RESERVATION_THRESHOLD_BPS,
} from './quality-cap.js';
import type { AudioTrackInfo } from '../../utils/hls-audio-injection.js';
import { asAbsoluteStreamIndex } from '$lib/shared/stream-index';

describe('parseQualityCapParams', () => {
    it('parses valid maxBitrate and maxHeight', () => {
        const cap = parseQualityCapParams(new URLSearchParams('maxBitrate=8000000&maxHeight=1080'));
        expect(cap).toEqual({ maxBitrate: 8_000_000, maxHeight: 1080 });
    });

    it('returns an empty object when neither param is present', () => {
        expect(parseQualityCapParams(new URLSearchParams())).toEqual({});
    });

    it.each([
        ['maxBitrate', 'abc'],
        ['maxBitrate', '-100'],
        ['maxBitrate', '0'],
        ['maxBitrate', '12.5'],
        ['maxBitrate', ''],
        ['maxHeight', 'abc'],
        ['maxHeight', '-100'],
        ['maxHeight', '0'],
        ['maxHeight', '12.5'],
    ])('silently ignores an invalid %s value %p', (key, value) => {
        const cap = parseQualityCapParams(new URLSearchParams(`${key}=${value}`));
        expect(cap).toEqual({});
    });

    it('clamps maxBitrate below the floor up to MIN_MAX_BITRATE_BPS', () => {
        const cap = parseQualityCapParams(new URLSearchParams('maxBitrate=1000'));
        expect(cap.maxBitrate).toBe(MIN_MAX_BITRATE_BPS);
    });

    it('clamps maxBitrate above the ceiling down to MAX_MAX_BITRATE_BPS', () => {
        const cap = parseQualityCapParams(new URLSearchParams('maxBitrate=999999999999'));
        expect(cap.maxBitrate).toBe(MAX_MAX_BITRATE_BPS);
    });

    it('clamps maxHeight below the floor up to MIN_MAX_HEIGHT_PX', () => {
        const cap = parseQualityCapParams(new URLSearchParams('maxHeight=10'));
        expect(cap.maxHeight).toBe(MIN_MAX_HEIGHT_PX);
    });

    it('clamps maxHeight above the ceiling down to MAX_MAX_HEIGHT_PX', () => {
        const cap = parseQualityCapParams(new URLSearchParams('maxHeight=999999'));
        expect(cap.maxHeight).toBe(MAX_MAX_HEIGHT_PX);
    });

    it('leaves an in-range value unclamped', () => {
        const cap = parseQualityCapParams(new URLSearchParams('maxBitrate=5000000&maxHeight=720'));
        expect(cap).toEqual({ maxBitrate: 5_000_000, maxHeight: 720 });
    });

    // /info returns play_methods URLs that already carry the requested cap, and
    // a client may append its own on top. Same value twice must be harmless;
    // a different value is the client's explicit override, so the LAST wins.
    it('accepts a duplicated param with the same value', () => {
        const cap = parseQualityCapParams(
            new URLSearchParams(
                'maxHeight=720&maxBitrate=4000000&maxHeight=720&maxBitrate=4000000',
            ),
        );
        expect(cap).toEqual({ maxBitrate: 4_000_000, maxHeight: 720 });
    });

    it('lets the last occurrence of a duplicated param win', () => {
        const cap = parseQualityCapParams(
            new URLSearchParams(
                'maxHeight=720&maxBitrate=4000000&maxHeight=1080&maxBitrate=8000000',
            ),
        );
        expect(cap).toEqual({ maxBitrate: 8_000_000, maxHeight: 1080 });
    });
});

describe('parseMaxAudioChannelsParam', () => {
    it('parses a valid channel count', () => {
        expect(parseMaxAudioChannelsParam(new URLSearchParams('maxAudioChannels=2'))).toBe(2);
    });

    it('returns undefined when absent', () => {
        expect(parseMaxAudioChannelsParam(new URLSearchParams())).toBeUndefined();
    });

    it.each(['abc', '0', '-2', '2.5', ''])('silently ignores invalid value %p', (value) => {
        expect(
            parseMaxAudioChannelsParam(new URLSearchParams(`maxAudioChannels=${value}`)),
        ).toBeUndefined();
    });

    it('clamps above 8 down to 8', () => {
        expect(parseMaxAudioChannelsParam(new URLSearchParams('maxAudioChannels=32'))).toBe(8);
    });

    it('lets the last occurrence of a duplicated param win', () => {
        expect(
            parseMaxAudioChannelsParam(
                new URLSearchParams('maxAudioChannels=2&maxAudioChannels=6'),
            ),
        ).toBe(6);
    });
});

describe('isEmptyQualityCap', () => {
    it('is true for undefined', () => {
        expect(isEmptyQualityCap(undefined)).toBe(true);
    });

    it('is true for an object with neither field set', () => {
        expect(isEmptyQualityCap({})).toBe(true);
    });

    it('is false when either field is set', () => {
        expect(isEmptyQualityCap({ maxHeight: 1080 })).toBe(false);
        expect(isEmptyQualityCap({ maxBitrate: 1_000_000 })).toBe(false);
    });
});

describe('sourceExceedsQualityCap', () => {
    it('is false when the cap is empty', () => {
        expect(sourceExceedsQualityCap(undefined, 2160, 100_000_000)).toBe(false);
        expect(sourceExceedsQualityCap({}, 2160, 100_000_000)).toBe(false);
    });

    it('is true when the source height exceeds maxHeight', () => {
        expect(sourceExceedsQualityCap({ maxHeight: 1080 }, 2160, undefined)).toBe(true);
    });

    it('is false when the source height is within maxHeight', () => {
        expect(sourceExceedsQualityCap({ maxHeight: 2160 }, 1080, undefined)).toBe(false);
    });

    it('is true when the source bitrate exceeds maxBitrate', () => {
        expect(sourceExceedsQualityCap({ maxBitrate: 4_000_000 }, undefined, 120_000_000)).toBe(
            true,
        );
    });

    it('is false when the source bitrate is within maxBitrate', () => {
        expect(sourceExceedsQualityCap({ maxBitrate: 120_000_000 }, undefined, 4_000_000)).toBe(
            false,
        );
    });

    // Item D: an unprobed file (unknown height/bitrate) must NOT be remuxed
    // uncapped to a client that explicitly asked for a ceiling — unknown
    // counts as exceeding whenever that cap dimension is set.
    it('treats an unknown source height as exceeding a maxHeight cap', () => {
        expect(sourceExceedsQualityCap({ maxHeight: 1080 }, undefined, undefined)).toBe(true);
    });

    it('treats an unknown source bitrate as exceeding a maxBitrate cap', () => {
        expect(sourceExceedsQualityCap({ maxBitrate: 4_000_000 }, 1080, undefined)).toBe(true);
    });

    it('is false when neither cap dimension is set, even with unknown source info', () => {
        expect(sourceExceedsQualityCap({}, undefined, undefined)).toBe(false);
    });
});

describe('effectiveCapHeight', () => {
    it('is undefined when no height cap is set', () => {
        expect(effectiveCapHeight(undefined, 1080)).toBeUndefined();
        expect(effectiveCapHeight({ maxBitrate: 4_000_000 }, 1080)).toBeUndefined();
    });

    it('returns the cap height when no server bound is set', () => {
        expect(effectiveCapHeight({ maxHeight: 2160 }, undefined)).toBe(2160);
        expect(effectiveCapHeight({ maxHeight: 2160 }, 0)).toBe(2160);
    });

    it('lowers the bound with a smaller server MAX_HEIGHT, never raises it', () => {
        expect(effectiveCapHeight({ maxHeight: 2160 }, 1080)).toBe(1080);
        expect(effectiveCapHeight({ maxHeight: 720 }, 1080)).toBe(720);
    });
});

describe('computeImpliedBitrateBudgetBps', () => {
    it.each([
        [480, 1_500_000],
        [720, 4_000_000],
        [1080, 10_000_000],
        [1440, 20_000_000],
        [2160, 40_000_000],
        [4320, 40_000_000],
    ])('height %d -> %d bps', (height, expected) => {
        expect(computeImpliedBitrateBudgetBps(height)).toBe(expected);
    });
});

describe('computeEffectiveBudgetBps', () => {
    it('is undefined with no cap', () => {
        expect(computeEffectiveBudgetBps(undefined, 1080, undefined)).toBeUndefined();
        expect(computeEffectiveBudgetBps({}, 1080, undefined)).toBeUndefined();
    });

    it('bitrate-only cap: returns maxBitrate regardless of height', () => {
        expect(computeEffectiveBudgetBps({ maxBitrate: 8_000_000 }, 1080, undefined)).toBe(
            8_000_000,
        );
    });

    it('height-only cap that downscales: returns the implied budget for the output height', () => {
        // 4K source capped to 720p
        expect(computeEffectiveBudgetBps({ maxHeight: 720 }, 2160, undefined)).toBe(4_000_000);
    });

    it('height-only cap that does NOT downscale: undefined (change nothing)', () => {
        expect(computeEffectiveBudgetBps({ maxHeight: 2160 }, 1080, undefined)).toBeUndefined();
    });

    it('height cap with unknown source height: treated as binding (implied budget applies)', () => {
        expect(computeEffectiveBudgetBps({ maxHeight: 720 }, undefined, undefined)).toBe(4_000_000);
    });

    it('both set, height cap binding: the SMALLER of maxBitrate and the implied budget', () => {
        // Implied for 720p is 4M; a generous 100M maxBitrate must not win.
        expect(
            computeEffectiveBudgetBps({ maxHeight: 720, maxBitrate: 100_000_000 }, 2160, undefined),
        ).toBe(4_000_000);
        // A tighter maxBitrate than the implied budget wins instead.
        expect(
            computeEffectiveBudgetBps({ maxHeight: 720, maxBitrate: 2_000_000 }, 2160, undefined),
        ).toBe(2_000_000);
    });

    it('both set, height cap NOT binding: falls back to maxBitrate alone', () => {
        expect(
            computeEffectiveBudgetBps({ maxHeight: 2160, maxBitrate: 8_000_000 }, 1080, undefined),
        ).toBe(8_000_000);
    });

    it('respects a smaller server MAX_HEIGHT when computing the implied budget', () => {
        // Cap asks for 2160p but the server only allows 1080p.
        expect(computeEffectiveBudgetBps({ maxHeight: 2160 }, 3840, 1080)).toBe(10_000_000);
    });
});

describe('computeAudioReservationBps', () => {
    it('is undefined with no effective budget', () => {
        expect(computeAudioReservationBps(undefined)).toBeUndefined();
    });

    it('is 20% of the budget when within [MIN, MAX]', () => {
        expect(computeAudioReservationBps(2_000_000)).toBe(400_000);
    });

    it('clamps up to MIN_AUDIO_RESERVATION_BPS for a tiny budget', () => {
        expect(computeAudioReservationBps(250_000)).toBe(MIN_AUDIO_RESERVATION_BPS);
    });

    it('clamps down to MAX_AUDIO_RESERVATION_BPS for a huge budget', () => {
        expect(computeAudioReservationBps(100_000_000)).toBe(MAX_AUDIO_RESERVATION_BPS);
    });
});

describe('parseBitrateString', () => {
    it('parses a kbps string', () => {
        expect(parseBitrateString('256k')).toBe(256_000);
    });

    it('parses an Mbps string', () => {
        expect(parseBitrateString('1M')).toBe(1_000_000);
    });

    it('parses a bare number string', () => {
        expect(parseBitrateString('128000')).toBe(128_000);
    });

    it('returns 0 for undefined/unparseable input', () => {
        expect(parseBitrateString(undefined)).toBe(0);
        expect(parseBitrateString('not-a-bitrate')).toBe(0);
    });
});

describe('computeCappedVideoBitrateMbps', () => {
    it('returns undefined when there is no effective budget', () => {
        expect(computeCappedVideoBitrateMbps(undefined, undefined, 0)).toBeUndefined();
    });

    it('subtracts the audio reservation from the budget', () => {
        const mbps = computeCappedVideoBitrateMbps(4_000_000, 400_000, 0);
        expect(mbps).toBeCloseTo(3.6, 5);
    });

    it('treats an undefined reservation as zero', () => {
        expect(computeCappedVideoBitrateMbps(4_000_000, undefined, 0)).toBe(4);
    });

    it('never goes above the server VIDEO_BITRATE_MBPS when that is lower', () => {
        const mbps = computeCappedVideoBitrateMbps(100_000_000, 400_000, 8);
        expect(mbps).toBe(8);
    });

    it('floors the video budget rather than going to zero/negative on a tiny cap', () => {
        const mbps = computeCappedVideoBitrateMbps(250_000, MAX_AUDIO_RESERVATION_BPS, 0);
        expect(mbps).toBeGreaterThan(0);
    });

    // Height-only 4K→720p: implied budget 4M, reservation 20% clamped to
    // [128k,512k] -> 800k clamps down to 512k? 20% of 4M = 800_000, which is
    // ABOVE MAX_AUDIO_RESERVATION_BPS (512_000), so it clamps to 512_000.
    it('height-only 4K->720p end-to-end: ~3.49 Mbps VBV cap (4M - 512k reservation)', () => {
        const reservation = 512_000;
        const mbps = computeCappedVideoBitrateMbps(4_000_000, reservation, 0);
        expect(mbps).toBeCloseTo((4_000_000 - reservation) / 1_000_000, 5);
        expect(mbps).toBeCloseTo(3.488, 3);
    });
});

describe('computeCappedDimensions', () => {
    it('returns undefined when there is no maxHeight cap', () => {
        expect(computeCappedDimensions(3840, 2160, undefined, undefined)).toBeUndefined();
        expect(
            computeCappedDimensions(3840, 2160, { maxBitrate: 4_000_000 }, undefined),
        ).toBeUndefined();
    });

    it('returns undefined when the source is already within the cap', () => {
        expect(computeCappedDimensions(1920, 1080, { maxHeight: 2160 }, undefined)).toBeUndefined();
    });

    it('returns undefined when source dimensions are unknown (no explicit scale to emit)', () => {
        expect(
            computeCappedDimensions(undefined, undefined, { maxHeight: 1080 }, undefined),
        ).toBeUndefined();
    });

    it('scales down 4K to 1080p preserving 16:9 aspect ratio with even dimensions', () => {
        const dims = computeCappedDimensions(3840, 2160, { maxHeight: 1080 }, undefined);
        expect(dims).toEqual({ width: 1920, height: 1080 });
    });

    it('produces even width/height for a non-16:9 source', () => {
        const dims = computeCappedDimensions(1998, 1080, { maxHeight: 720 }, undefined);
        expect(dims).toBeDefined();
        expect(dims!.width % 2).toBe(0);
        expect(dims!.height % 2).toBe(0);
        expect(dims!.height).toBe(720);
    });

    it('further lowers the bound with a smaller server MAX_HEIGHT, never raises it', () => {
        // Cap asks for 2160 but the server only allows 1080.
        const dims = computeCappedDimensions(3840, 2160, { maxHeight: 2160 }, 1080);
        expect(dims).toEqual({ width: 1920, height: 1080 });
    });

    it('ignores a LARGER server MAX_HEIGHT (never grows the requested cap)', () => {
        const dims = computeCappedDimensions(3840, 2160, { maxHeight: 720 }, 1080);
        expect(dims?.height).toBe(720);
    });
});

describe('AUDIO_DOWNMIX_RESERVATION_THRESHOLD_BPS', () => {
    it('is 192 kbps', () => {
        expect(AUDIO_DOWNMIX_RESERVATION_THRESHOLD_BPS).toBe(192_000);
    });
});

function track(index: number, bitrate: number | undefined, isDefault = false): AudioTrackInfo {
    return {
        index: asAbsoluteStreamIndex(index),
        displayTitle: `Track ${index}`,
        channels: 2,
        codec: 'aac',
        bitrate,
        isDefault,
    };
}

describe('resolveDeliveredAudioTracks', () => {
    const tracks = [track(1, 192_000, true), track(2, 1_500_000, false)];

    it('demux mode: delivers every track', () => {
        expect(resolveDeliveredAudioTracks(tracks, 'demux', undefined)).toEqual(tracks);
    });

    it('undefined audio mode: treated the same as demux (every track)', () => {
        expect(resolveDeliveredAudioTracks(tracks, undefined, undefined)).toEqual(tracks);
    });

    it('muxed mode with no explicit index: delivers only the default track', () => {
        expect(resolveDeliveredAudioTracks(tracks, 'muxed', undefined)).toEqual([tracks[0]]);
    });

    it('muxed mode with an explicit index: delivers only that track', () => {
        expect(resolveDeliveredAudioTracks(tracks, 'muxed', 2)).toEqual([tracks[1]]);
    });

    it('muxed mode with an unmatched index: falls back to array position 0', () => {
        expect(resolveDeliveredAudioTracks(tracks, 'muxed', 99)).toEqual([tracks[0]]);
    });

    it('empty track list: delivers nothing in either mode', () => {
        expect(resolveDeliveredAudioTracks([], 'muxed', undefined)).toEqual([]);
        expect(resolveDeliveredAudioTracks([], 'demux', undefined)).toEqual([]);
    });
});

describe('computeQualityCapReservation', () => {
    it('is undefined/undefined with no cap', () => {
        expect(computeQualityCapReservation(undefined, 1080, undefined, false, [])).toEqual({
            effectiveBudgetBps: undefined,
            audioReservationBps: undefined,
        });
    });

    it('audio transcoded (not copied): reservation is the flat share, unaffected by track bitrates', () => {
        const result = computeQualityCapReservation(
            { maxBitrate: 3_000_000 },
            1080,
            undefined,
            false,
            [640_000],
        );
        expect(result.effectiveBudgetBps).toBe(3_000_000);
        // 20% of 3M = 600_000, clamped down to 512_000.
        expect(result.audioReservationBps).toBe(512_000);
    });

    it('audio copied: bumps the reservation to the largest delivered bitrate when it exceeds the flat share', () => {
        const result = computeQualityCapReservation(
            { maxBitrate: 3_000_000 },
            1080,
            undefined,
            true,
            [640_000],
        );
        expect(result.audioReservationBps).toBe(640_000);
    });

    it('audio copied: leaves the flat share alone when it already covers the largest delivered bitrate', () => {
        const result = computeQualityCapReservation(
            { maxBitrate: 3_000_000 },
            1080,
            undefined,
            true,
            [200_000],
        );
        // 512_000 flat share already covers 200_000.
        expect(result.audioReservationBps).toBe(512_000);
    });

    it('audio copied, multiple delivered tracks: uses the LARGEST', () => {
        const result = computeQualityCapReservation(
            { maxBitrate: 3_000_000 },
            1080,
            undefined,
            true,
            [200_000, 900_000, 300_000],
        );
        expect(result.audioReservationBps).toBe(900_000);
    });

    it('audio copied, unknown bitrate: falls back to the flat share for that track', () => {
        const result = computeQualityCapReservation(
            { maxBitrate: 3_000_000 },
            1080,
            undefined,
            true,
            [undefined],
        );
        expect(result.audioReservationBps).toBe(512_000);
    });

    it('audio copied, no delivered tracks: falls back to the flat share', () => {
        const result = computeQualityCapReservation(
            { maxBitrate: 3_000_000 },
            1080,
            undefined,
            true,
            [],
        );
        expect(result.audioReservationBps).toBe(512_000);
    });
});
