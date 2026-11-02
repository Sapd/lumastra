// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { isDistinctStreamDuration, resolveEffectiveStreamDuration } from './hls-stream-duration';

describe('hls-stream-duration', () => {
    describe('isDistinctStreamDuration', () => {
        it('treats 4s -> 5s as a distinct cadence', () => {
            expect(isDistinctStreamDuration(5, 4)).toBe(true);
        });

        it('does not treat small drift above the base duration as distinct', () => {
            expect(isDistinctStreamDuration(7, 6)).toBe(true);
            expect(isDistinctStreamDuration(6.2, 6)).toBe(false);
        });
    });

    describe('resolveEffectiveStreamDuration', () => {
        it('keeps base duration for audio streams whose target duration was rounded up', () => {
            expect(
                resolveEffectiveStreamDuration(6, 7, [
                    { duration: 6.01 },
                    { duration: 5.98 },
                    { duration: 6.0 },
                ]),
            ).toBe(6);
        });

        it('uses the distinct target duration for 4s base / 5s video streams', () => {
            expect(
                resolveEffectiveStreamDuration(4, 5, [
                    { duration: 4.92 },
                    { duration: 4.98 },
                    { duration: 5.0 },
                ]),
            ).toBe(5);
        });

        it('falls back to the base duration when no useful manifest data exists', () => {
            expect(resolveEffectiveStreamDuration(6, undefined, [])).toBe(6);
        });

        it('returns base duration when TD is rounded up but no segment samples exist', () => {
            // Audio streams can have TD=7 (ceiling) with actual ~6s segments.
            // Without segment data, we can't distinguish this from video — return base.
            expect(resolveEffectiveStreamDuration(6, 7, [])).toBe(6);
            expect(resolveEffectiveStreamDuration(6, 7, undefined)).toBe(6);
        });
    });
});
