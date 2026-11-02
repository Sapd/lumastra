// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    LIVE_TV_QUALITY_PROFILES,
    appliedLiveTvProfile,
    currentAdaptiveVariant,
    formatLiveTvDefaultQuality,
    formatLiveTvQualityStatus,
    liveTvQualityState,
} from './livetv-quality.js';

describe('Live TV player quality contract', () => {
    it('derives player choices from the shared server ladder', () => {
        expect(LIVE_TV_QUALITY_PROFILES.map((profile) => profile.maxBitrate)).toEqual([
            8_000_000, 4_000_000, 2_000_000, 1_000_000,
        ]);
        expect(LIVE_TV_QUALITY_PROFILES[0]).toMatchObject({ height: 1080, width: 1920 });
    });

    it('normalizes a snapped request to the profile actually applied by the server', () => {
        const requested = {
            maxBitrate: 3_000_000,
            width: 1920,
            height: 1080,
            label: '3 Mbps',
            mode: 'fixed' as const,
        };
        const info = {
            streamUrl: '/r/540p2m/master.m3u8',
            requiresProxy: true,
            rungId: '540p2m',
            requestedMaxBitrateBps: 3_000_000,
            appliedMaxBitrateBps: 2_000_000,
            appliedMaxHeight: 540,
            reason: null,
        };

        expect(appliedLiveTvProfile(requested, info)).toEqual(
            expect.objectContaining({ maxBitrate: 2_000_000, height: 540 }),
        );
        expect(formatLiveTvQualityStatus(liveTvQualityState(info, '540p2m'))).toBe('540p · 2 Mbps');
    });

    it('surfaces a successful source-within-cap verdict without inventing a rung', () => {
        const requested = LIVE_TV_QUALITY_PROFILES[1];
        const info = {
            streamUrl: '/master.m3u8',
            requiresProxy: true,
            rungId: null,
            requestedMaxBitrateBps: 4_000_000,
            appliedMaxBitrateBps: null,
            appliedMaxHeight: null,
            reason: 'source_within_cap' as const,
        };

        expect(appliedLiveTvProfile(requested, info)).toBe(requested);
        expect(formatLiveTvQualityStatus(liveTvQualityState(info, 'original'))).toBe(
            'Original · source is already within the limit',
        );
    });

    it('selects Original when the server falls back to an uncapped source', () => {
        const requested = LIVE_TV_QUALITY_PROFILES[1];
        const info = {
            streamUrl: '/master.m3u8',
            requiresProxy: true,
            rungId: null,
            requestedMaxBitrateBps: 4_000_000,
            appliedMaxBitrateBps: null,
            appliedMaxHeight: null,
            reason: 'capacity' as const,
        };

        expect(appliedLiveTvProfile(requested, info)).toBeNull();
        expect(formatLiveTvQualityStatus(liveTvQualityState(info, 'original'))).toBe(
            'Original · no encoder capacity free',
        );
    });

    it('does not mark the request active when a newer server applies an unknown rung', () => {
        const requested = LIVE_TV_QUALITY_PROFILES[1];
        const info = {
            streamUrl: '/r/720p3m/master.m3u8',
            requiresProxy: true,
            rungId: '720p3m',
            requestedMaxBitrateBps: 4_000_000,
            appliedMaxBitrateBps: 3_000_000,
            appliedMaxHeight: 720,
            reason: null,
        };

        expect(appliedLiveTvProfile(requested, info)).toBeNull();
        expect(formatLiveTvQualityStatus(liveTvQualityState(info, '720p4m'))).toBe('720p · 3 Mbps');
    });

    it('marks Original when Adaptive falls back or the administrator disables the ladder', () => {
        const info = {
            streamUrl: '/master.m3u8',
            requiresProxy: true,
            rungId: null,
            requestedMaxBitrateBps: null,
            appliedMaxBitrateBps: null,
            appliedMaxHeight: null,
            reason: 'capacity' as const,
        };
        expect(liveTvQualityState(info, 'adaptive').selection).toBe('original');
        expect(liveTvQualityState({ ...info, reason: null }, '540p2m').selection).toBe('original');
        expect(liveTvQualityState({ ...info, reason: null }, 'server').selection).toBe('server');
    });

    it('unchecks a rung the server declined to apply, even on a 200', () => {
        // Under LIVETV_CAP_FALLBACK=source a declined ceiling is a SUCCESS response
        // serving the uncapped stream, so nothing else moves the selection. The menu
        // used to keep a checkmark on 720p while the footer read "Original · ...".
        const declined = {
            streamUrl: '/master.m3u8',
            requiresProxy: true,
            rungId: null,
            requestedMaxBitrateBps: 4_000_000,
            appliedMaxBitrateBps: null,
            appliedMaxHeight: null,
        };

        for (const reason of [
            'capacity',
            'hdr_source',
            'unprobeable',
            'insufficient_ladder',
        ] as const) {
            expect(liveTvQualityState({ ...declined, reason }, '720p4m').selection).toBe(
                'original',
            );
        }
    });

    it('keeps the rung checked when the source already sits under the requested ceiling', () => {
        // source_within_cap is the one uncapped answer that HONOURS the request: the
        // ceiling holds, there is simply nothing to encode. Moving the checkmark here
        // would tell the viewer their pick was ignored when it was satisfied.
        const info = {
            streamUrl: '/master.m3u8',
            requiresProxy: true,
            rungId: null,
            requestedMaxBitrateBps: 4_000_000,
            appliedMaxBitrateBps: null,
            appliedMaxHeight: null,
            reason: 'source_within_cap' as const,
        };

        expect(liveTvQualityState(info, '720p4m').selection).toBe('720p4m');
    });
});

describe('Live TV adaptive ladder display', () => {
    const ladder = {
        rungs: [
            { id: '1080p8m', height: 1080, maxBitrateBps: 8_000_000, codec: 'h264' as const },
            { id: '720p4m', height: 720, maxBitrateBps: 4_000_000, codec: 'h264' as const },
            { id: '540p2m', height: 540, maxBitrateBps: 2_000_000, codec: 'h264' as const },
        ],
        includesOriginal: false,
    };

    it('keeps the applied ladder in the quality state', () => {
        const info = {
            streamUrl: '/a/master.m3u8',
            requiresProxy: true,
            rungId: null,
            requestedMaxBitrateBps: null,
            appliedMaxBitrateBps: null,
            appliedMaxHeight: null,
            reason: null,
            adaptive: ladder,
        };
        expect(liveTvQualityState(info, 'adaptive').ladder).toEqual(ladder);
        expect(liveTvQualityState({ ...info, adaptive: undefined }, 'server').ladder).toBeNull();
    });

    it('names the playing variant from the decoded height', () => {
        expect(currentAdaptiveVariant(ladder, '1280x720')).toEqual({ kind: 'rung', id: '720p4m' });
        // A non-16:9 channel still decodes at the rung height.
        expect(currentAdaptiveVariant(ladder, '720x540')).toEqual({ kind: 'rung', id: '540p2m' });
        expect(currentAdaptiveVariant(ladder, null)).toBeNull();
    });

    it('falls back to Original only when the ladder carries it', () => {
        expect(currentAdaptiveVariant(ladder, '3840x2160')).toBeNull();
        expect(currentAdaptiveVariant({ ...ladder, includesOriginal: true }, '3840x2160')).toEqual({
            kind: 'original',
        });
    });

    it('formats the server default quality for the menu', () => {
        expect(formatLiveTvDefaultQuality('adaptive')).toBe('Adaptive');
        expect(formatLiveTvDefaultQuality(undefined)).toBe('Adaptive');
        expect(formatLiveTvDefaultQuality('original')).toBe('Original');
        expect(formatLiveTvDefaultQuality('720p4m')).toBe('720p · 4 Mbps');
    });
});
