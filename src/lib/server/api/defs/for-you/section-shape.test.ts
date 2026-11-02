// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Contract guard for the music-because + explore-keywords section shapes.
 *
 * Both endpoints validate their emitted section against the SHARED
 * PageSectionSchema at runtime (`PageSectionSchema.parse(...)`), and the client
 * validates the response against the same schema. These tests assert the exact
 * object literals those defs emit still satisfy PageSectionSchema — a regression
 * here would 500 the endpoint (server .parse throws) and re-open the schema
 * drift that left cards imageless / keyword chips empty.
 */

import { describe, it, expect } from 'vitest';
import { PageSectionSchema } from '$lib/schemas/api-responses';

describe('music-because emits a valid PageSection', () => {
    it('a canonicalized track section validates', () => {
        const section = {
            id: 'music-because' as const,
            type: 'carousel' as const,
            title: 'Because you listened to…',
            meta: { sourceTitle: 'Seed Song' },
            items: [
                {
                    id: 'track-uuid-1',
                    externalIds: { internal: 'track-uuid-1' },
                    mediaType: 'track' as const,
                    title: 'Some Track',
                    subtitle: 'Some Artist',
                    image: '/api/image/catalog/track-uuid-1/thumb',
                    aspectRatio: 'square' as const,
                    isAvailable: true,
                    canRequest: false,
                },
            ],
        };
        expect(PageSectionSchema.safeParse(section).success).toBe(true);
    });

    it('validates an empty section (all id-less tracks dropped by the mapper)', () => {
        // The mapper drops tracks with no resolvable internal id, so the emitted
        // section can legitimately end up with zero items — still a valid PageSection.
        const section = {
            id: 'music-because' as const,
            type: 'carousel' as const,
            title: 'Because you listened to…',
            items: [],
        };
        expect(PageSectionSchema.safeParse(section).success).toBe(true);
    });
});

describe('explore-keywords emits a valid keyword-chips PageSection', () => {
    it('validates a chips section carrying keywords in meta (items: [])', () => {
        const section = {
            id: 'explore-keywords',
            type: 'keyword-chips' as const,
            title: 'Explore by Genre',
            items: [],
            meta: {
                keywords: [{ keyword: 'sci-fi', displayName: 'Sci-Fi', count: 42 }],
            },
        };
        const parsed = PageSectionSchema.safeParse(section);
        expect(parsed.success).toBe(true);
        // The renderer reads chips from section.meta.keywords — assert they survive parse.
        if (parsed.success) {
            expect(parsed.data.meta?.keywords?.[0]?.keyword).toBe('sci-fi');
        }
    });
});
