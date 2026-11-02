// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests pinning the derived getter composition for the Music Alchemy
 * and Music-First feature flags, and the INSTANCE_PRIMARY_MODE resolver.
 *
 * These tests exercise the CONFIG-LEVEL logic (getBool / normalisation) by
 * reading raw env vars directly — they do NOT import `config` or `features`
 * from the module (which have module-level side effects) and instead replicate
 * the minimal composition logic inline so the suite stays fast and isolated.
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Inline replica of the normalisation logic in config.ts so we can test it
// without importing the full config module (which triggers ConfigService init,
// DB connections, etc.).
// ---------------------------------------------------------------------------

function parseBool(raw: string | undefined, defaultValue: boolean): boolean {
    if (raw === undefined || raw === '') return defaultValue;
    return raw.toLowerCase() === 'true' || raw === '1';
}

function parsePrimaryMode(raw: string | undefined): 'vod' | 'music' | 'mixed' {
    if (raw === undefined || raw === '') return 'vod';
    return raw === 'music' || raw === 'mixed' ? raw : 'vod';
}

/** Replica of features.musicAlchemy getter composition */
function musicAlchemy(
    featureAlchemy: string | undefined,
    featureClustering: string | undefined,
): boolean {
    return parseBool(featureAlchemy, false) && parseBool(featureClustering, true);
}

/** Replica of features.musicFirst getter */
function musicFirst(featureFirst: string | undefined): boolean {
    return parseBool(featureFirst, false);
}

// ---------------------------------------------------------------------------
// features.musicAlchemy composition
// ---------------------------------------------------------------------------

describe('features.musicAlchemy getter composition', () => {
    it('is false by default (both flags absent)', () => {
        expect(musicAlchemy(undefined, undefined)).toBe(false);
    });

    it('is false when FEATURE_MUSIC_ALCHEMY=false', () => {
        expect(musicAlchemy('false', 'true')).toBe(false);
    });

    it('is false when FEATURE_MUSIC_CLUSTERING=false even if FEATURE_MUSIC_ALCHEMY=true', () => {
        // musicAlchemy ANDs both flags — clustering is required infrastructure
        expect(musicAlchemy('true', 'false')).toBe(false);
    });

    it('is false when FEATURE_MUSIC_ALCHEMY is absent (default OFF)', () => {
        // clustering defaults to true; alchemy defaults to false → result false
        expect(musicAlchemy(undefined, 'true')).toBe(false);
    });

    it('is true only when both flags are explicitly enabled', () => {
        expect(musicAlchemy('true', 'true')).toBe(true);
    });

    it('accepts numeric "1" for true', () => {
        expect(musicAlchemy('1', '1')).toBe(true);
    });

    it('is false when FEATURE_MUSIC_ALCHEMY="0"', () => {
        expect(musicAlchemy('0', 'true')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// features.musicFirst getter
// ---------------------------------------------------------------------------

describe('features.musicFirst getter', () => {
    it('is false by default (flag absent)', () => {
        expect(musicFirst(undefined)).toBe(false);
    });

    it('is false when FEATURE_MUSIC_FIRST=false', () => {
        expect(musicFirst('false')).toBe(false);
    });

    it('is true when FEATURE_MUSIC_FIRST=true', () => {
        expect(musicFirst('true')).toBe(true);
    });

    it('is true when FEATURE_MUSIC_FIRST="1"', () => {
        expect(musicFirst('1')).toBe(true);
    });

    it('is independent of musicAlchemy (separate flag)', () => {
        // musicFirst ON, musicAlchemy OFF is a valid combination
        const first = musicFirst('true');
        const alchemy = musicAlchemy(undefined, 'true');
        expect(first).toBe(true);
        expect(alchemy).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// INSTANCE_PRIMARY_MODE normalisation
// ---------------------------------------------------------------------------

describe('INSTANCE_PRIMARY_MODE normalisation (parsePrimaryMode)', () => {
    it('defaults to "vod" when absent', () => {
        expect(parsePrimaryMode(undefined)).toBe('vod');
    });

    it('defaults to "vod" when empty string', () => {
        expect(parsePrimaryMode('')).toBe('vod');
    });

    it('accepts "vod"', () => {
        expect(parsePrimaryMode('vod')).toBe('vod');
    });

    it('accepts "music"', () => {
        expect(parsePrimaryMode('music')).toBe('music');
    });

    it('accepts "mixed"', () => {
        expect(parsePrimaryMode('mixed')).toBe('mixed');
    });

    it('falls back to "vod" for an unrecognised value', () => {
        expect(parsePrimaryMode('movies')).toBe('vod');
        expect(parsePrimaryMode('MUSIC')).toBe('vod'); // case-sensitive (env var is lowercase)
        expect(parsePrimaryMode('tv')).toBe('vod');
    });
});
