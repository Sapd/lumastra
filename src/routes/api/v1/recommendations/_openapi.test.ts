// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The `mood` query param was accepted by the handler (defs/recommendations.ts)
 * but entirely undeclared in the public OpenAPI spec — tvOS's generated
 * client had no way to send it, so `type=mood` always resolved to an empty
 * result (MoodStrategy short-circuits without a mood). This test guards the
 * fix: the documented enum must stay in exact sync with the service's real
 * mood keys, or the same "spec silently drifts from server reality" bug
 * this whole contract-mismatch investigation has been about recurs here too.
 */

import { describe, it, expect } from 'vitest';
// The documented query schema moved onto the def during the _openapi.ts →
// def.docs migration. It collided with the def's own runtime-validation
// `RecommendationsQuerySchema` (a leaner, coercing gate), so the codemod copied
// the DOCUMENTED one under `RecommendationsQuerySchemaFromDocs`. This test
// asserts the DOCUMENTED enum stays in sync with the service — so it must read
// the docs copy, not the runtime gate.
import { RecommendationsQuerySchemaFromDocs as RecommendationsQuerySchema } from '$lib/server/api/defs/recommendations/recommendations.js';
import { MOOD_PROFILES } from '$lib/server/services/mood-recommendations.service.js';

describe('RecommendationsQuerySchema — mood enum', () => {
    it('documents exactly the mood keys the service actually recognises (no drift)', () => {
        const documented = RecommendationsQuerySchema.shape.mood.def.innerType.def.entries as
            string[] | Record<string, string>;
        const documentedKeys = Array.isArray(documented) ? documented : Object.values(documented);
        const serviceKeys = Object.keys(MOOD_PROFILES);

        expect(new Set(documentedKeys)).toEqual(new Set(serviceKeys));
    });

    it('accepts every real mood key', () => {
        for (const mood of Object.keys(MOOD_PROFILES)) {
            const result = RecommendationsQuerySchema.safeParse({ mood });
            expect(result.success, `mood "${mood}" should validate`).toBe(true);
        }
    });

    it('also documents genre/seed/domain/types/hideWatched/theme, with no GET refresh flag', () => {
        for (const key of ['genre', 'seed', 'domain', 'types', 'hideWatched', 'theme']) {
            expect(RecommendationsQuerySchema.shape).toHaveProperty(key);
        }
        expect(RecommendationsQuerySchema.shape).not.toHaveProperty('mediaType');
        expect(RecommendationsQuerySchema.shape).not.toHaveProperty('refresh');
    });
});
