// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { RecommendationReasonSchema } from './api-for-you-responses.js';

describe('RecommendationReasonSchema — upcoming view fields', () => {
    it('accepts episodeTitle and overview (emitted by GET /api/v1/upcoming)', () => {
        // upcoming.ts (defs/recommendations/upcoming.ts) always sets these on the
        // `reason` block for ?view=episodes and ?view=alerts. This schema is the
        // one actually wired into the OpenAPI contract for /api/v1/upcoming (via
        // ForYouRecommendationItemSchema -> UpcomingEpisodeItemSchema), so it must
        // document every field the handler emits or strict client codegen (tvOS)
        // rejects the response as carrying an undeclared property.
        const result = RecommendationReasonSchema.safeParse({
            kind: 'upcoming',
            label: 'S1E2',
            airDate: '2026-07-10',
            episodeTitle: 'The Pilot',
            overview: 'An episode overview.',
        });

        expect(result.success).toBe(true);
        // Zod strips undeclared keys silently on a bare z.object(), so `success`
        // alone doesn't prove the field is part of the schema — assert it survives
        // parsing (i.e. the schema declares it, not that it merely tolerates it).
        expect(result.data?.episodeTitle).toBe('The Pilot');
        expect(result.data?.overview).toBe('An episode overview.');
    });
});
