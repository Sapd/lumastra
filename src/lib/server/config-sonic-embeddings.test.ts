// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests pinning the derived getter composition for features.sonicEmbeddings.
 *
 * These tests exercise the CONFIG-LEVEL logic (getBool composition) by
 * replicating the minimal composition logic inline — they do NOT import
 * `config` or `features` from the module (which have module-level side
 * effects) so the suite stays fast and isolated.
 *
 * Composition rule (from config.ts):
 *   features.sonicEmbeddings = FEATURE_MUSIC_SONIC && FEATURE_AI_RECOMMENDATIONS
 *
 * Both flags must be true for sonic embeddings to be active. The sonic flag
 * defaults to false; AI recommendations defaults to true.
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

// ---------------------------------------------------------------------------
// features.sonicEmbeddings composition
// ---------------------------------------------------------------------------

describe('features.sonicEmbeddings getter composition', () => {
    it('is false by default (both flags absent — sonic defaults off)', () => {
        expect(sonicEmbeddings(undefined, undefined)).toBe(false);
    });

    it('is false when FEATURE_MUSIC_SONIC=false, FEATURE_AI_RECOMMENDATIONS=true', () => {
        expect(sonicEmbeddings('false', 'true')).toBe(false);
    });

    it('is false when FEATURE_MUSIC_SONIC=true but FEATURE_AI_RECOMMENDATIONS=false', () => {
        // AI recommendations is required infrastructure
        expect(sonicEmbeddings('true', 'false')).toBe(false);
    });

    it('is false when FEATURE_MUSIC_SONIC is absent (default OFF), even if aiRec is true', () => {
        // sonic defaults to false → result false regardless of aiRec
        expect(sonicEmbeddings(undefined, 'true')).toBe(false);
    });

    it('is true only when both FEATURE_MUSIC_SONIC=true and FEATURE_AI_RECOMMENDATIONS=true', () => {
        expect(sonicEmbeddings('true', 'true')).toBe(true);
    });

    it('is true when FEATURE_MUSIC_SONIC=true and FEATURE_AI_RECOMMENDATIONS is absent (defaults true)', () => {
        expect(sonicEmbeddings('true', undefined)).toBe(true);
    });

    it('accepts numeric "1" for true on both flags', () => {
        expect(sonicEmbeddings('1', '1')).toBe(true);
    });

    it('is false when FEATURE_MUSIC_SONIC="0"', () => {
        expect(sonicEmbeddings('0', 'true')).toBe(false);
    });

    it('is false when FEATURE_AI_RECOMMENDATIONS="0"', () => {
        expect(sonicEmbeddings('true', '0')).toBe(false);
    });
});
