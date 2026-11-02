// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Manifest-guard regression tests: scheduled global-identity tasks whose
 * `timeout.hard` exceeds their `schedule.every` MUST declare `exclusiveWith`,
 * or a run still in flight at the next tick spawns a redundant concurrent run
 * (the watch-sync pile-up class). The SDK already rejects `ttl < hard` at
 * definition time; these assert the guard is present and stays present.
 */

import { describe, it, expect } from 'vitest';
import { lumastraIntroAnalyzerTask } from '../lumastra-intro-analyzer.js';
import { libraryEmbeddingsTask } from '../library-embeddings-task.js';

describe('singleton guards for scheduled global drains', () => {
    it('lumastra-intro-analyzer declares exclusiveWith (hard 7h > every 6h, constant global identity)', () => {
        expect(lumastraIntroAnalyzerTask.exclusiveWith).toMatchObject({ scope: 'global' });
        // ttl must be >= timeout.hard (7h); 8h gives margin.
        expect(lumastraIntroAnalyzerTask.exclusiveWith?.ttl).toBe('8h');
        expect(lumastraIntroAnalyzerTask.timeout?.hard).toBe('7h');
        // The scheduled (empty-input) path resolves to a constant identity.
        expect(lumastraIntroAnalyzerTask.identityFor?.({})).toBe('global');
        // Global modes share one execution slot, preventing two full-library
        // FFmpeg passes from modifying the same evidence pool concurrently.
        expect(
            lumastraIntroAnalyzerTask.identityFor?.({
                outroOnly: true,
            }),
        ).toBe('global');
    });

    it('library-embeddings declares exclusiveWith (hard 60m > every 15m, constant tgt-library identity)', () => {
        expect(libraryEmbeddingsTask.exclusiveWith).toMatchObject({ scope: 'global' });
        expect(libraryEmbeddingsTask.exclusiveWith?.ttl).toBe('70m');
        expect(libraryEmbeddingsTask.timeout?.hard).toBe('60m');
        expect(libraryEmbeddingsTask.identityFor?.({})).toBe('tgt-library');
    });
});
