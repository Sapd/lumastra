// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { applyLiveQualityCap } from './hls-quality-cap-params';

// What /info returns since it bakes the requested cap into play_methods URLs.
const BAKED = 'videoCodec=h264&plan=p1&maxHeight=720&maxBitrate=4000000&maxAudioChannels=2';

describe('applyLiveQualityCap', () => {
    it('drops a baked-in cap once the user is back on auto', () => {
        const params = new URLSearchParams(BAKED);

        applyLiveQualityCap(params, 'auto', { maxBitrate: 4_000_000, height: 720 });

        expect(params.has('maxHeight')).toBe(false);
        expect(params.has('maxBitrate')).toBe(false);
    });

    it('replaces a baked-in cap with the live fixed profile (single value, no duplicate)', () => {
        const params = new URLSearchParams(BAKED);

        applyLiveQualityCap(params, 'fixed', { maxBitrate: 8_000_000, height: 1080 });

        expect(params.getAll('maxHeight')).toEqual(['1080']);
        expect(params.getAll('maxBitrate')).toEqual(['8000000']);
    });

    it('leaves the channel cap and other params alone', () => {
        const params = new URLSearchParams(BAKED);

        applyLiveQualityCap(params, 'auto', null);

        expect(params.get('maxAudioChannels')).toBe('2');
        expect(params.get('plan')).toBe('p1');
        expect(params.get('videoCodec')).toBe('h264');
    });
});
