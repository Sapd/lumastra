// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { HeroFirstSlideSchema } from './hero';

describe('HeroFirstSlideSchema', () => {
    it('parses a minimal valid slide', () => {
        const parsed = HeroFirstSlideSchema.parse({
            title: 'My Show',
            mediaType: 'episode',
            externalIds: { internal: 'ep-uuid' },
        });
        expect(parsed.title).toBe('My Show');
        expect(parsed.externalIds.internal).toBe('ep-uuid');
    });

    it('rejects a slide without an internal id', () => {
        expect(() =>
            HeroFirstSlideSchema.parse({ title: 'x', mediaType: 'movie', externalIds: {} }),
        ).toThrow();
    });
});
