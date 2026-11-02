// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { liveTvJoinCompat } from './livetv-join-compat.js';

describe('liveTvJoinCompat', () => {
    it('passes an explicit capability through, whatever the client', () => {
        expect(
            liveTvJoinCompat('none', 'lumastra-ios/112 CFNetwork/3826.500 Darwin/25.0.0'),
        ).toEqual({ client: { hevc: 'none' } });
        expect(liveTvJoinCompat('any', null)).toEqual({ client: { hevc: 'any' } });
    });

    it('defaults the Lumastra Apple app to fmp4', () => {
        for (const ua of [
            'lumastra-ios/112 CFNetwork/3826.500.62 Darwin/25.0.0',
            'stellar-tvos/41 CFNetwork/1568.100.1 Darwin/24.0.0',
        ]) {
            expect(liveTvJoinCompat(undefined, ua)).toEqual({ client: { hevc: 'fmp4' } });
        }
    });

    it('leaves browsers and other URLSession clients on the original', () => {
        expect(
            liveTvJoinCompat(undefined, 'Mozilla/5.0 (Macintosh) Safari/605.1.15'),
        ).toBeUndefined();
        expect(
            liveTvJoinCompat(undefined, 'SomeApp/3 CFNetwork/1568 Darwin/24.0.0'),
        ).toBeUndefined();
        expect(liveTvJoinCompat(undefined, null)).toBeUndefined();
    });
});
