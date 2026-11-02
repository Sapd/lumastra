// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    AUTO_PROFILE,
    DEFAULT_TRANSCODING_PROFILES,
    ORIGINAL_PROFILE,
    type TranscodingProfile,
} from '$lib/types/playback.js';
import { LIVE_TV_QUALITY_PROFILES } from './livetv-quality.js';
import { qualityOptionKey } from './quality-option-key.js';

/** The resolution bands QualitySelector.getQualityGroups buckets profiles into. */
const BANDS = [
    { key: '4k', minHeight: 2160, maxHeight: undefined },
    { key: '1080p', minHeight: 1080, maxHeight: 2159 },
    { key: '720p', minHeight: 720, maxHeight: 1079 },
    { key: 'sd', minHeight: 0, maxHeight: 719 },
];

function band(profiles: readonly TranscodingProfile[], b: (typeof BANDS)[number]) {
    return profiles.filter((p) =>
        b.maxHeight ? p.height >= b.minHeight && p.height <= b.maxHeight : p.height >= b.minHeight,
    );
}

describe('quality option keys', () => {
    it('is unique within every resolution band of both ladders', () => {
        // The bug this pins: Svelte throws each_key_duplicate and kills the whole
        // menu render if two options in one {#each} share a key. The SD band of the
        // Live TV ladder holds 540p2m AND 360p1m, and both declare mode:'fixed' —
        // under the old `profile.mode ?? profile.maxBitrate` key they collapsed onto
        // the string 'fixed' and the quality menu could not be opened at all.
        for (const [name, profiles] of [
            ['live', LIVE_TV_QUALITY_PROFILES],
            ['vod', DEFAULT_TRANSCODING_PROFILES],
        ] as const) {
            for (const b of BANDS) {
                const keys = band(profiles, b).map(qualityOptionKey);
                expect(new Set(keys).size, `${name} band ${b.key}: ${keys.join(', ')}`).toBe(
                    keys.length,
                );
            }
        }
    });

    it('separates the smart options from each other and from every rung', () => {
        // Scoped per rendered menu, not across both ladders: a menu shows the smart
        // group plus EITHER the live ladder or the VOD one. The two overlap on purpose
        // (live 720p4m and VOD "720p - 4 Mbps" are the same option), so requiring
        // global uniqueness would assert something the UI never needs.
        for (const ladder of [LIVE_TV_QUALITY_PROFILES, DEFAULT_TRANSCODING_PROFILES]) {
            const keys = [AUTO_PROFILE, ORIGINAL_PROFILE, ...ladder].map(qualityOptionKey);
            expect(new Set(keys).size).toBe(keys.length);
        }
    });

    it('does not depend on a ladder populating `mode`', () => {
        // VOD profiles omit `mode` entirely, live rungs set it — the key must identify
        // the option either way, which is what the old expression got wrong.
        const noMode: TranscodingProfile = {
            maxBitrate: 2_000_000,
            width: 960,
            height: 540,
            label: '540p',
        };
        const withMode: TranscodingProfile = { ...noMode, mode: 'fixed' };
        expect(qualityOptionKey(noMode)).toBe(qualityOptionKey(withMode));
    });
});
