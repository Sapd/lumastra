// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests pinning the derived getter composition for features.sonicTaste.
 *
 * These tests exercise the CONFIG-LEVEL logic by replicating the minimal
 * composition logic inline — they do NOT import `config` or `features` from
 * the module (which have module-level side effects) so the suite stays fast
 * and isolated.
 *
 * Composition rule (from config.ts):
 *   features.sonicTaste
 *     = FEATURE_MUSIC_SONIC_TASTE && features.sonicEmbeddings
 *     = FEATURE_MUSIC_SONIC_TASTE && FEATURE_MUSIC_SONIC && FEATURE_AI_RECOMMENDATIONS
 *
 * All three flags must be true for sonic taste to be active.
 * Defaults: FEATURE_MUSIC_SONIC_TASTE=false, FEATURE_MUSIC_SONIC=false,
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
 * Replica of features.sonicTaste getter composition.
 * FEATURE_MUSIC_SONIC_TASTE defaults to false.
 * Requires sonicEmbeddings (featureSonic && featureAiRec) to also be true.
 */
function sonicTaste(
    featureSonicTaste: string | undefined,
    featureSonic: string | undefined,
    featureAiRec: string | undefined,
): boolean {
    return parseBool(featureSonicTaste, false) && sonicEmbeddings(featureSonic, featureAiRec);
}

// ---------------------------------------------------------------------------
// features.sonicTaste composition
// ---------------------------------------------------------------------------

describe('features.sonicTaste getter composition', () => {
    it('is false by default (all flags absent — sonic-taste and sonic both default off)', () => {
        expect(sonicTaste(undefined, undefined, undefined)).toBe(false);
    });

    it('is false when only FEATURE_MUSIC_SONIC_TASTE=true, sonic embeddings off', () => {
        // sonicEmbeddings requires FEATURE_MUSIC_SONIC — absent means false
        expect(sonicTaste('true', undefined, undefined)).toBe(false);
    });

    it('is false when FEATURE_MUSIC_SONIC_TASTE=false even if sonic embeddings are on', () => {
        expect(sonicTaste('false', 'true', 'true')).toBe(false);
    });

    it('is false when FEATURE_MUSIC_SONIC_TASTE=true and FEATURE_MUSIC_SONIC=true but FEATURE_AI_RECOMMENDATIONS=false', () => {
        // AI recommendations infrastructure is required by sonicEmbeddings
        expect(sonicTaste('true', 'true', 'false')).toBe(false);
    });

    it('is false when FEATURE_MUSIC_SONIC_TASTE=true and FEATURE_MUSIC_SONIC=false even if aiRec=true', () => {
        expect(sonicTaste('true', 'false', 'true')).toBe(false);
    });

    it('is true only when all three flags are true', () => {
        expect(sonicTaste('true', 'true', 'true')).toBe(true);
    });

    it('is true when FEATURE_MUSIC_SONIC_TASTE=true, FEATURE_MUSIC_SONIC=true, aiRec absent (defaults true)', () => {
        expect(sonicTaste('true', 'true', undefined)).toBe(true);
    });

    it('accepts numeric "1" for true on all three flags', () => {
        expect(sonicTaste('1', '1', '1')).toBe(true);
    });

    it('is false when FEATURE_MUSIC_SONIC_TASTE="0"', () => {
        expect(sonicTaste('0', 'true', 'true')).toBe(false);
    });

    it('is false when FEATURE_MUSIC_SONIC="0"', () => {
        expect(sonicTaste('true', '0', 'true')).toBe(false);
    });

    it('is false when FEATURE_AI_RECOMMENDATIONS="0"', () => {
        expect(sonicTaste('true', 'true', '0')).toBe(false);
    });

    it('sonicTaste being off leaves sonicEmbeddings unaffected (independent sonic features still work)', () => {
        // sonicTaste off does NOT block sonicEmbeddings — they compose independently
        expect(sonicEmbeddings('true', 'true')).toBe(true);
        expect(sonicTaste('false', 'true', 'true')).toBe(false);
    });

    it('is false when FEATURE_MUSIC_SONIC_TASTE has an unexpected string value', () => {
        expect(sonicTaste('yes', 'true', 'true')).toBe(false);
    });
});
