// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests pinning the derived getter composition for features.sonicQueue.
 *
 * These tests exercise the CONFIG-LEVEL logic by replicating the minimal
 * composition logic inline — they do NOT import `config` or `features` from
 * the module (which have module-level side effects) so the suite stays fast
 * and isolated.
 *
 * Composition rule (from config.ts):
 *   features.sonicQueue
 *     = FEATURE_MUSIC_SONIC_QUEUE && features.sonicEmbeddings
 *     = FEATURE_MUSIC_SONIC_QUEUE && FEATURE_MUSIC_SONIC && FEATURE_AI_RECOMMENDATIONS
 *
 * All three flags must be true for sonicQueue to be active.
 * Defaults: FEATURE_MUSIC_SONIC_QUEUE=false, FEATURE_MUSIC_SONIC=false,
 *           FEATURE_AI_RECOMMENDATIONS=true.
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Inline replica of the normalisation + composition logic in config.ts
// ---------------------------------------------------------------------------

function parseBool(raw: string | undefined, defaultValue: boolean): boolean {
    if (raw === undefined || raw === '') return defaultValue;
    return raw.toLowerCase() === 'true' || raw === '1';
}

/**
 * Replica of features.sonicEmbeddings getter composition.
 * FEATURE_MUSIC_SONIC defaults to false; FEATURE_AI_RECOMMENDATIONS defaults to true.
 */
function sonicEmbeddings(
    featureSonic: string | undefined,
    featureAiRec: string | undefined,
): boolean {
    return parseBool(featureSonic, false) && parseBool(featureAiRec, true);
}

/**
 * Replica of features.sonicQueue getter composition.
 * FEATURE_MUSIC_SONIC_QUEUE defaults to false.
 * Requires sonicEmbeddings (featureSonic && featureAiRec) to also be true.
 */
function sonicQueue(
    featureSonicQueue: string | undefined,
    featureSonic: string | undefined,
    featureAiRec: string | undefined,
): boolean {
    return parseBool(featureSonicQueue, false) && sonicEmbeddings(featureSonic, featureAiRec);
}

// ---------------------------------------------------------------------------
// features.sonicQueue composition
// ---------------------------------------------------------------------------

describe('features.sonicQueue getter composition', () => {
    it('is false by default (all flags absent — sonicQueue and sonic both default off)', () => {
        expect(sonicQueue(undefined, undefined, undefined)).toBe(false);
    });

    it('is false when only FEATURE_MUSIC_SONIC_QUEUE=true but sonic embeddings are off', () => {
        // sonicEmbeddings requires FEATURE_MUSIC_SONIC — absent means false
        expect(sonicQueue('true', undefined, undefined)).toBe(false);
    });

    it('is false when FEATURE_MUSIC_SONIC_QUEUE=false even if sonic embeddings are on', () => {
        expect(sonicQueue('false', 'true', 'true')).toBe(false);
    });

    it('is false when FEATURE_MUSIC_SONIC_QUEUE=true and FEATURE_MUSIC_SONIC=true but FEATURE_AI_RECOMMENDATIONS=false', () => {
        // AI recommendations infrastructure is required by sonicEmbeddings
        expect(sonicQueue('true', 'true', 'false')).toBe(false);
    });

    it('is false when FEATURE_MUSIC_SONIC_QUEUE=true and FEATURE_MUSIC_SONIC=false even if aiRec=true', () => {
        expect(sonicQueue('true', 'false', 'true')).toBe(false);
    });

    it('is true only when all three flags are true', () => {
        expect(sonicQueue('true', 'true', 'true')).toBe(true);
    });

    it('is true when FEATURE_MUSIC_SONIC_QUEUE=true, FEATURE_MUSIC_SONIC=true, aiRec absent (defaults true)', () => {
        expect(sonicQueue('true', 'true', undefined)).toBe(true);
    });

    it('accepts numeric "1" for true on all three flags', () => {
        expect(sonicQueue('1', '1', '1')).toBe(true);
    });

    it('is false when FEATURE_MUSIC_SONIC_QUEUE="0"', () => {
        expect(sonicQueue('0', 'true', 'true')).toBe(false);
    });

    it('is false when FEATURE_MUSIC_SONIC="0"', () => {
        expect(sonicQueue('true', '0', 'true')).toBe(false);
    });

    it('is false when FEATURE_AI_RECOMMENDATIONS="0"', () => {
        expect(sonicQueue('true', 'true', '0')).toBe(false);
    });

    it('sonicQueue being off leaves sonicEmbeddings unaffected (other sonic features still work)', () => {
        // sonicQueue off does NOT block sonicEmbeddings — they compose independently
        expect(sonicEmbeddings('true', 'true')).toBe(true);
        expect(sonicQueue('false', 'true', 'true')).toBe(false);
    });

    it('is false when FEATURE_MUSIC_SONIC_QUEUE has an unexpected string value', () => {
        expect(sonicQueue('yes', 'true', 'true')).toBe(false);
    });
});
