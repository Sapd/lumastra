// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test for the Python sonic-embedder /analyze sidecar
 * (Integration Shape A — sidecar emits RAW features, TS owns all derivation).
 *
 * What it proves, end to end:
 *   analyzeTrack(<sample.flac>) with the engine pinned to 'sidecar'
 *     1. POSTs to the real {SONIC_ANALYZE_URL}/analyze sidecar,
 *     2. adapts the raw librosa features through the SAME deriveAnalysis() pipeline
 *        the binary uses (adaptSidecarAnalysis), and
 *     3. storeAnalysis() persists the result into media_items.custom_metadata->essentia
 *        with every HARD SCALE CONTRACT intact.
 *
 * ── SKIP / SAFETY GATE ──────────────────────────────────────────────────────
 * This test makes NO assertions and runs NOTHING unless BOTH of these hold:
 *
 *   • A real sidecar is reachable:  process.env.SONIC_ANALYZE_URL is set
 *     AND  process.env.MUSIC_ANALYSIS_ENGINE === 'sidecar'
 *   • A test database is reachable: process.env.TEST_DATABASE_URL is set
 *     (or DATABASE_URL → derived lumastra_tests, mirrored in by the vitest
 *      integration config so getTestDb() can connect).
 *
 * Both `MUSIC_ANALYSIS_ENGINE` and `SONIC_ANALYZE_URL` MUST be present in the
 * environment BEFORE the process starts — config.ts snapshots process.env at
 * module load (`const env = { ...process.env }`), so flipping them at runtime
 * inside the test would not change `config.MUSIC_ANALYSIS_ENGINE`. The skip gate
 * therefore reads process.env directly (the authoritative pre-load value) AND
 * cross-checks config.* so a mismatched/late env can never produce a binary run
 * masquerading as a sidecar run.
 *
 * When either condition is absent the whole suite is skipped via
 * `describe.skipIf(...)` — it can NEVER fail in CI or on a dev box without the
 * sidecar/DB, which is the explicit requirement.
 *
 * To run it (manual / Windows e2e box — see the migration PLAN's PRIMARY DEV +
 * E2E ENVIRONMENT section):
 *
 *   MUSIC_ANALYSIS_ENGINE=sidecar \
 *   SONIC_ANALYZE_URL=http://127.0.0.1:8000 \
 *   TEST_DATABASE_URL=postgres://lumastra:<pw>@localhost:5432/lumastra_tests \
 *     npm run test:integration -- \
 *       src/lib/server/services/music-analysis-sidecar.integration.test.ts
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';

import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import { config } from '../config.js';
import {
    analyzeTrack,
    isEssentiaAvailable,
    storeAnalysis,
    type EssentiaResult,
} from './essentia-analysis.service.js';

const __dirname_local = dirname(fileURLToPath(import.meta.url));
const FLAC_FIXTURE = resolve(__dirname_local, '../../../../tests/fixtures/music/sample.flac');

// ---------------------------------------------------------------------------
// Skip gate — read process.env (the value config.ts snapshotted at load) AND
// cross-check the resolved config so we never run a binary path here by mistake.
// ---------------------------------------------------------------------------

const SIDECAR_ENGINE_SELECTED =
    process.env.MUSIC_ANALYSIS_ENGINE === 'sidecar' && config.MUSIC_ANALYSIS_ENGINE === 'sidecar';
const SIDECAR_URL_PRESENT =
    Boolean(process.env.SONIC_ANALYZE_URL) && Boolean(config.SONIC_ANALYZE_URL);
const DB_PRESENT = Boolean(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL);

const SHOULD_RUN = SIDECAR_ENGINE_SELECTED && SIDECAR_URL_PRESENT && DB_PRESENT;

// Tables touched by this test; truncated between cases.
const CLEANUP_TABLES = ['media_items'] as const;

// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)('music-analysis sidecar /analyze (engine=sidecar)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, CLEANUP_TABLES);
    });

    it('exposes the sidecar as available when engine=sidecar + URL set', () => {
        // In sidecar mode, availability is purely "is a /analyze URL configured?"
        expect(isEssentiaAvailable()).toBe(true);
    });

    it('analyzes sample.flac through the sidecar and returns a derived EssentiaResult', async () => {
        const result = await analyzeTrack(FLAC_FIXTURE);

        expect(result, 'sidecar /analyze returned no usable analysis').not.toBeNull();
        const r = result as EssentiaResult;

        assertScaleContracts(r);
    });

    it('stores the sidecar analysis into media_items.custom_metadata->essentia with sane scales', async () => {
        const result = await analyzeTrack(FLAC_FIXTURE);
        expect(result).not.toBeNull();
        const r = result as EssentiaResult;

        const mediaId = crypto.randomUUID();
        await sql`
            INSERT INTO media_items (id, title, media_type, status)
            VALUES (${mediaId}::uuid, ${'Sidecar Analyze Fixture'}, 'track', 'active')
        `;

        await storeAnalysis(sql, mediaId, r);

        const [row] = await sql<{ essentia: Record<string, unknown> | null }[]>`
            SELECT custom_metadata->'essentia' AS essentia
            FROM media_items
            WHERE id = ${mediaId}::uuid
        `;

        expect(row, 'media_items row missing after storeAnalysis').toBeDefined();
        const stored = row?.essentia;
        expect(stored, 'custom_metadata->essentia not populated').toBeTruthy();
        if (!stored) return; // narrow for TS; the assertion above already failed otherwise

        // The stored payload mirrors EssentiaResult + an essentia_analyzed marker.
        expect(stored.essentia_analyzed).toBe(true);

        // Re-assert every hard scale contract against the PERSISTED JSON (not just
        // the in-memory object) — this is what downstream consumers read.
        assertScaleContracts({
            bpm: stored.bpm as number,
            key: stored.key as string,
            energy: stored.energy as number,
            danceability: stored.danceability as number,
            loudness_lufs: stored.loudness_lufs as number,
            beat_grid: (stored.beat_grid ?? []) as number[],
            downbeats: (stored.downbeats ?? []) as number[],
            intro_end_ms: stored.intro_end_ms as number,
            outro_start_ms: stored.outro_start_ms as number,
            energy_curve: (stored.energy_curve ?? []) as number[],
            mood_tags: (stored.mood_tags ?? []) as string[],
            vocal_instrumental: stored.vocal_instrumental as 'voice' | 'instrumental',
            vocal_confidence: stored.vocal_confidence as number,
            outro_source: stored.outro_source as 'downbeat' | 'percentage' | 'fade' | 'dj-outro',
            dj_intro_end_ms: (stored.dj_intro_end_ms ?? null) as number | null,
            first_vocal_start_ms: (stored.first_vocal_start_ms ?? null) as number | null,
            last_vocal_end_ms: (stored.last_vocal_end_ms ?? null) as number | null,
        });
    });
});

// ---------------------------------------------------------------------------
// Shared assertions — the HARD SCALE CONTRACTS downstream consumers depend on.
// Bounds are intentionally loose (sane ranges, not exact values) so the test is
// robust across librosa versions / CPU arch, while still catching a mis-scaled
// adapter (e.g. danceability *100, energy un-clamped, key un-joined).
// ---------------------------------------------------------------------------

function assertScaleContracts(r: EssentiaResult): void {
    // bpm — a real positive tempo.
    expect(typeof r.bpm).toBe('number');
    expect(Number.isFinite(r.bpm)).toBe(true);
    expect(r.bpm).toBeGreaterThan(0);

    // energy 0..1 (clamped at the adapter edge AND inside deriveAnalysis).
    expect(r.energy).toBeGreaterThanOrEqual(0);
    expect(r.energy).toBeLessThanOrEqual(1);

    // danceability ~0..3 (Essentia scale, NOT 0..1). Must not have been *100 or
    // min(1, ·)'d. Allow a touch of headroom above 3 in case a future engine
    // edge-clamps slightly differently, but it must be well below a /100 mistake.
    expect(r.danceability).toBeGreaterThanOrEqual(0);
    expect(r.danceability).toBeLessThanOrEqual(3.5);

    // loudness_lufs — negative dB (EBU R128 real measurement or the negative
    // approximation), rounded to 1 decimal by storeAnalysis/derive.
    expect(typeof r.loudness_lufs).toBe('number');
    expect(Number.isFinite(r.loudness_lufs)).toBe(true);
    expect(r.loudness_lufs).toBeLessThan(0);

    // key like "Am" / "C" / "F#" — root pitch class, optional accidental,
    // optional minor 'm' suffix. The "Am" join happens once in deriveAnalysis.
    expect(r.key).toMatch(/^[A-G]#?m?$/);

    // beat_grid capped at 500 and ascending.
    expect(Array.isArray(r.beat_grid)).toBe(true);
    expect(r.beat_grid.length).toBeLessThanOrEqual(500);
    expectAscending(r.beat_grid, 'beat_grid');

    // downbeats sorted ascending.
    expect(Array.isArray(r.downbeats)).toBe(true);
    expectAscending(r.downbeats, 'downbeats');

    // mood_tags lowercase strings (may be empty — prod binaries emit []).
    expect(Array.isArray(r.mood_tags)).toBe(true);
    for (const tag of r.mood_tags) {
        expect(typeof tag).toBe('string');
        expect(tag).toBe(tag.toLowerCase());
    }

    // vocal classification is one of the two allowed values, confidence 0..1.
    expect(['voice', 'instrumental']).toContain(r.vocal_instrumental);
    expect(r.vocal_confidence).toBeGreaterThanOrEqual(0);
    expect(r.vocal_confidence).toBeLessThanOrEqual(1);

    // outro_source is one of the four derivation sources.
    expect(['downbeat', 'percentage', 'fade', 'dj-outro']).toContain(r.outro_source);

    // intro/outro markers are non-negative ms within the track; outro after intro.
    expect(r.intro_end_ms).toBeGreaterThanOrEqual(0);
    expect(r.outro_start_ms).toBeGreaterThanOrEqual(0);
    expect(r.outro_start_ms).toBeGreaterThanOrEqual(r.intro_end_ms);
}

function expectAscending(arr: number[], label: string): void {
    for (let i = 1; i < arr.length; i++) {
        expect(arr[i], `${label} not ascending at index ${i}`).toBeGreaterThanOrEqual(arr[i - 1]);
    }
}
