// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, test, expect } from 'vitest';
import { classifyLiveTvHevcSupport } from './livetv-hevc-support.js';

const SAFARI =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
const CHROME =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0';

function env(userAgent: string, opts: { native: boolean; hevcVideo: boolean; mse: boolean }) {
    return {
        userAgent,
        video: {
            canPlayType: (type: string) =>
                type === 'application/vnd.apple.mpegurl'
                    ? opts.native
                        ? 'maybe'
                        : ''
                    : opts.hevcVideo
                      ? 'probably'
                      : '',
        } as Pick<HTMLVideoElement, 'canPlayType'>,
        mediaSource: { isTypeSupported: () => opts.mse },
    } as Parameters<typeof classifyLiveTvHevcSupport>[0];
}

describe('classifyLiveTvHevcSupport', () => {
    test('Safari with HEVC decode needs fMP4 (native HLS)', () => {
        expect(
            classifyLiveTvHevcSupport(env(SAFARI, { native: true, hevcVideo: true, mse: true })),
        ).toBe('fmp4');
    });

    test('Safari without HEVC decode gets none', () => {
        expect(
            classifyLiveTvHevcSupport(env(SAFARI, { native: true, hevcVideo: false, mse: false })),
        ).toBe('none');
    });

    test('Chrome on iOS is WebKit with native HLS: fmp4', () => {
        const crios =
            'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1';
        expect(
            classifyLiveTvHevcSupport(env(crios, { native: true, hevcVideo: true, mse: false })),
        ).toBe('fmp4');
    });

    test('Chrome with hardware HEVC uses hls.js: any', () => {
        expect(
            classifyLiveTvHevcSupport(env(CHROME, { native: false, hevcVideo: true, mse: true })),
        ).toBe('any');
    });

    test('Chrome that reports native HLS still uses hls.js', () => {
        expect(
            classifyLiveTvHevcSupport(env(CHROME, { native: true, hevcVideo: true, mse: true })),
        ).toBe('any');
    });

    test('Firefox has no HEVC: none', () => {
        expect(
            classifyLiveTvHevcSupport(
                env(FIREFOX, { native: false, hevcVideo: false, mse: false }),
            ),
        ).toBe('none');
    });

    test('a throwing isTypeSupported counts as unsupported', () => {
        const e = env(CHROME, { native: false, hevcVideo: false, mse: false });
        e.mediaSource = {
            isTypeSupported: () => {
                throw new Error('boom');
            },
        };
        expect(classifyLiveTvHevcSupport(e)).toBe('none');
    });
});
