// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { EMBEDDING_PROJECTION_VERSION } from './music-embedding-projection.queries.js';

describe('EMBEDDING_PROJECTION_VERSION', () => {
    // Pinned like ROTATION_SCORE_VERSION (music-downloads.queries.test.ts).
    // Bumping this without a deliberate re-fit + backfill is a much worse
    // failure than a stale score: getActiveProjectionBasis only ever returns
    // a basis whose version EXACTLY matches this constant, so a bump with no
    // corresponding basis row makes every candidate's embeddingProjection
    // silently go back to null until the operator re-fits — see the eval doc
    // and migration 16.224.0 for why serving a mismatched version instead
    // would be far worse than that.
    it('is pinned to 1 — bump deliberately alongside a basis re-fit + backfill, never casually', () => {
        expect(EMBEDDING_PROJECTION_VERSION).toBe(1);
    });
});
