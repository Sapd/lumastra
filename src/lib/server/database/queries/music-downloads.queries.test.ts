// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { ROTATION_MIN_RATING, ROTATION_SCORE_VERSION } from './music-downloads.queries.js';
import { MUSIC_FEEDBACK_IMPLICIT_CEILING } from '$lib/server/services/music/feedback.js';

describe('ROTATION_MIN_RATING', () => {
    // Nothing else in the codebase pins this value: every integration test is
    // written relative to the constant itself (`ROTATION_MIN_RATING - 1` /
    // `ROTATION_MIN_RATING`), so a re-tune back toward the old, wrong value
    // would leave every one of them green. Raising this from 7 to 8 was the
    // previous review round's headline correctness fix — it must equal
    // MUSIC_FEEDBACK_IMPLICIT_CEILING exactly. Below that ceiling, an
    // implicitly-completed track and an explicitly-skipped track can both
    // carry a rating in the "favourite" range, so the rotation lane would
    // start surfacing tracks the user only ever passively finished (or even
    // skipped) as if they were favourites.
    it('stays pinned to MUSIC_FEEDBACK_IMPLICIT_CEILING (8), not a re-tuned lower value', () => {
        expect(ROTATION_MIN_RATING).toBe(MUSIC_FEEDBACK_IMPLICIT_CEILING);
        expect(ROTATION_MIN_RATING).toBe(8);
    });
});

describe('ROTATION_SCORE_VERSION', () => {
    // Pinned so that changing the getRotationRescoreRanks ordering expression
    // without bumping this constant is a visible, deliberate test failure
    // rather than a silent break of the client contract described on the
    // wire schema: a client treats a changed scoreVersion as "my stored
    // ranks are stale, re-rescore". If this constant drifts unnoticed, a
    // ranking-function change ships with no signal telling clients their
    // cached ranks no longer mean what they used to.
    it('is pinned to 1 — bump deliberately alongside any ordering-expression change', () => {
        expect(ROTATION_SCORE_VERSION).toBe(1);
    });
});
