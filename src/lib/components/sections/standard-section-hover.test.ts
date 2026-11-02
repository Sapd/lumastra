// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { canWrapMediaHoverCard } from './standard-section-hover';

describe('canWrapMediaHoverCard', () => {
    for (const mediaType of ['audiobook', 'AudioBook', 'AUDIOBOOK']) {
        it(`refuses audiobook mediaType='${mediaType}'`, () => {
            expect(canWrapMediaHoverCard({ mediaType })).toBe(false);
        });
    }

    for (const mediaType of ['track', 'album', 'artist', 'audio', 'music']) {
        it(`keeps existing music/audio suppression for mediaType='${mediaType}'`, () => {
            expect(canWrapMediaHoverCard({ mediaType })).toBe(false);
        });
    }

    for (const mediaType of ['movie', 'series', 'episode']) {
        it(`allows video mediaType='${mediaType}'`, () => {
            expect(canWrapMediaHoverCard({ mediaType })).toBe(true);
        });
    }
});
