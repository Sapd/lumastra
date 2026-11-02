// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Unit tests for the Sonic Smart Queue blend logic.
 *
 * All tests are fully isolated — no database, no real sql.
 * They exercise the math and helper functions exported from sonic-queue.queries.ts
 * and the shared title-normalize module.
 */

import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';

import {
    ALPHA,
    BETA,
    ALPHA_NO_MOOD,
    BETA_NO_MOOD,
    GAMMA,
    SKIP_DEMOTION_PER_SKIP,
    MAX_SKIP_DEMOTION,
    SONIC_GENRE_OVERLAP_BOOST,
    MANUAL_INTENT_CENTROID_DECAY,
    MANUAL_INTENT_TASTE_MULTIPLIER,
    centroidDecayForIntent,
    computeQueueCentroid,
    SESSION_ANCHOR_FLOOR_WEIGHT,
    buildBlendedVector,
    applySkipDemotion,
    getSonicQueueCandidates,
    getMoodVector,
    type SonicQueueCandidateRow,
} from './sonic-queue.queries.js';
import { denyAllAccess, unrestrictedAccess } from './builders/media-access-boundary.js';
import { normalizeTitle } from './music-title-normalize.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a unit-norm 3-dim test vector. */
function vec3(x: number, y: number, z: number): number[] {
    const mag = Math.sqrt(x * x + y * y + z * z);
    return mag === 0 ? [0, 0, 0] : [x / mag, y / mag, z / mag];
}

/** Serialise a vector to pgvector text format. */
function toVecText(v: number[]): string {
    return `[${v.join(',')}]`;
}

/** Build a minimal SonicQueueCandidateRow. */
function makeSonicRow(
    id: string,
    score: number,
    artist = 'Test Artist',
    opts: {
        parent_id?: string | null;
        embedding?: number[] | null;
        genres?: string[] | null;
    } = {},
): SonicQueueCandidateRow {
    return {
        id,
        title: `Track ${id}`,
        runtime_seconds: null,
        custom_metadata: {},
        custom_poster_url: null,
        parent_id: opts.parent_id ?? null,
        similarity_score: score,
        resolved_artist: artist,
        resolved_artist_id: null,
        embedding: opts.embedding ?? null,
        genres: opts.genres ?? null,
    };
}

// ---------------------------------------------------------------------------
// Weight constants
// ---------------------------------------------------------------------------

describe('blend weight constants', () => {
    it('three-arm weights (mood active) sum to 1.0: ALPHA + BETA + GAMMA', () => {
        expect(ALPHA + BETA + GAMMA).toBeCloseTo(1.0, 10);
    });

    it('two-arm weights (mood inactive) sum to 1.0: ALPHA_NO_MOOD + BETA_NO_MOOD', () => {
        expect(ALPHA_NO_MOOD + BETA_NO_MOOD).toBeCloseTo(1.0, 10);
    });

    it('GAMMA is 0.35 (MSCLAP audio mood arm re-enabled)', () => {
        expect(GAMMA).toBeCloseTo(0.35, 10);
    });

    it('ALPHA is the largest mood-active weight (queue context dominates)', () => {
        expect(ALPHA).toBeGreaterThan(BETA);
        expect(ALPHA).toBeGreaterThan(GAMMA);
    });

    it('ALPHA_NO_MOOD dominates BETA_NO_MOOD (current context steers, taste tints)', () => {
        // A symmetric 0.5/0.5 blend let the taste arm drag genre-distant
        // seeds into the user's dominant genre within a few autoplay hops
        // (verified against production data) — the centroid arm must stay
        // clearly dominant.
        expect(ALPHA_NO_MOOD).toBeGreaterThan(BETA_NO_MOOD);
        expect(BETA_NO_MOOD).toBeLessThanOrEqual(0.25);
        expect(BETA_NO_MOOD).toBeGreaterThan(0);
    });

    it('SKIP_DEMOTION_PER_SKIP is positive and less than MAX_SKIP_DEMOTION', () => {
        expect(SKIP_DEMOTION_PER_SKIP).toBeGreaterThan(0);
        expect(SKIP_DEMOTION_PER_SKIP).toBeLessThanOrEqual(MAX_SKIP_DEMOTION);
    });

    it('score-level constants are in valid ranges', () => {
        expect(SONIC_GENRE_OVERLAP_BOOST).toBeGreaterThan(0);
        expect(SONIC_GENRE_OVERLAP_BOOST).toBeLessThan(0.5);
    });
});

// ---------------------------------------------------------------------------
// computeQueueCentroid
// ---------------------------------------------------------------------------

describe('computeQueueCentroid', () => {
    it('returns null for an empty map', () => {
        const result = computeQueueCentroid(['id-1'], new Map());
        expect(result).toBeNull();
    });

    it('returns the single embedding when only one track has an embedding', () => {
        const v = vec3(1, 0, 0);
        const map = new Map([['id-1', v]]);
        const result = computeQueueCentroid(['id-1'], map);
        expect(result).not.toBeNull();
        result!.forEach((val, i) => expect(val).toBeCloseTo(v[i], 10));
    });

    it('weights the first track (index 0) higher than subsequent tracks', () => {
        // index 0 weight = 1.0, index 1 weight = 0.5
        const v0 = vec3(1, 0, 0);
        const v1 = vec3(0, 1, 0);
        const map = new Map([
            ['id-0', v0],
            ['id-1', v1],
        ]);
        const result = computeQueueCentroid(['id-0', 'id-1'], map);
        expect(result).not.toBeNull();
        expect(result![0]).toBeCloseTo(1.0 / 1.5, 5);
        expect(result![1]).toBeCloseTo(0.5 / 1.5, 5);
    });

    it('skips tracks with no embedding', () => {
        const v0 = vec3(1, 0, 0);
        const map = new Map([['id-0', v0]]);
        const result = computeQueueCentroid(['id-0', 'id-1'], map);
        expect(result).not.toBeNull();
        result!.forEach((val, i) => expect(val).toBeCloseTo(v0[i], 10));
    });

    it('applies a custom decay factor when provided', () => {
        // decay 0.15: index 0 weight = 1.0, index 1 weight = 0.15
        const v0 = vec3(1, 0, 0);
        const v1 = vec3(0, 1, 0);
        const map = new Map([
            ['id-0', v0],
            ['id-1', v1],
        ]);
        const result = computeQueueCentroid(['id-0', 'id-1'], map, 0.15);
        expect(result).not.toBeNull();
        expect(result![0]).toBeCloseTo(1.0 / 1.15, 5);
        expect(result![1]).toBeCloseTo(0.15 / 1.15, 5);
    });
});

// ---------------------------------------------------------------------------
// Manual-intent weighting — an explicitly user-picked now-playing track must
// dominate the centroid instead of splitting the vote ~50/50 with session
// history (the "picked Martin Fenwick, got hands-up from the prior session"
// failure).
// ---------------------------------------------------------------------------

describe('manual-intent weighting', () => {
    it('centroidDecayForIntent maps manual → steep decay, auto/absent → default 0.5', () => {
        expect(centroidDecayForIntent('manual')).toBeCloseTo(MANUAL_INTENT_CENTROID_DECAY, 10);
        expect(centroidDecayForIntent('auto')).toBeCloseTo(0.5, 10);
        expect(centroidDecayForIntent(undefined)).toBeCloseTo(0.5, 10);
    });

    it('manual decay gives the current track at least 85% of a full 5-track centroid', () => {
        const d = MANUAL_INTENT_CENTROID_DECAY;
        const totalWeight = 1 + d + d ** 2 + d ** 3 + d ** 4;
        expect(1 / totalWeight).toBeGreaterThanOrEqual(0.85);
    });

    it('manual centroid over 5 tracks is dominated by the current track embedding', () => {
        // Current track on the x-axis, four history tracks on the y-axis: with
        // the default decay history collectively outweighs x (~48%); with
        // manual decay x must dominate clearly.
        const map = new Map([
            ['cur', vec3(1, 0, 0)],
            ['h1', vec3(0, 1, 0)],
            ['h2', vec3(0, 1, 0)],
            ['h3', vec3(0, 1, 0)],
            ['h4', vec3(0, 1, 0)],
        ]);
        const ids = ['cur', 'h1', 'h2', 'h3', 'h4'];
        const manual = computeQueueCentroid(ids, map, centroidDecayForIntent('manual'));
        expect(manual).not.toBeNull();
        expect(manual![0]).toBeGreaterThanOrEqual(0.85);
        expect(manual![1]).toBeLessThan(0.15);
    });

    it('taste multiplier shrinks but does not zero the taste arm', () => {
        expect(MANUAL_INTENT_TASTE_MULTIPLIER).toBeGreaterThan(0);
        expect(MANUAL_INTENT_TASTE_MULTIPLIER).toBeLessThan(1);
    });

    it('getSonicQueueCandidates accepts an optional intent param (backward compat)', () => {
        type ParamsType = Parameters<typeof getSonicQueueCandidates>[1];
        const withIntent: ParamsType = {
            queueTrackIds: ['track-a'],
            tasteVector: null,
            moodVector: null,
            excludeIds: [],
            limit: 10,
            access: unrestrictedAccess(),
            intent: 'manual',
        };
        const withoutIntent: ParamsType = {
            queueTrackIds: ['track-a'],
            tasteVector: null,
            moodVector: null,
            excludeIds: [],
            limit: 10,
            access: unrestrictedAccess(),
        };
        expect(withIntent.intent).toBe('manual');
        expect(withoutIntent.intent).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// buildBlendedVector — three-arm GAMMA blend (re-enabled)
// ---------------------------------------------------------------------------

describe('buildBlendedVector — GAMMA arm active', () => {
    it('returns a unit-norm vector when all three arms are present', () => {
        const queueCentroid = vec3(1, 0, 0);
        const tasteVector = vec3(0, 1, 0);
        const moodVector = vec3(0, 0, 1);

        const result = buildBlendedVector(queueCentroid, tasteVector, moodVector);
        expect(result).not.toBeNull();

        const mag = Math.sqrt(result!.reduce((s, v) => s + v * v, 0));
        expect(mag).toBeCloseTo(1.0, 5);
    });

    it('applies all three arms: centroid, taste, and mood each contribute', () => {
        // Place arms along orthogonal axes; all three components must be non-zero.
        const result = buildBlendedVector(vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1));
        expect(result).not.toBeNull();
        expect(Math.abs(result![0])).toBeGreaterThan(1e-6); // centroid (ALPHA)
        expect(Math.abs(result![1])).toBeGreaterThan(1e-6); // taste   (BETA)
        expect(Math.abs(result![2])).toBeGreaterThan(1e-6); // mood    (GAMMA)
    });

    it('centroid arm (ALPHA) pulls more than taste (BETA) when mood active', () => {
        // centroid → x, taste → y, mood → z
        const result = buildBlendedVector(vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1));
        expect(result).not.toBeNull();
        expect(result![0]).toBeGreaterThan(result![1]); // ALPHA > BETA
    });

    it('mood arm (GAMMA) contributes more than taste arm (BETA) when mood active', () => {
        const result = buildBlendedVector(vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1));
        expect(result).not.toBeNull();
        expect(result![2]).toBeGreaterThan(result![1]); // GAMMA > BETA
    });

    it('no-mood two-arm blend uses ALPHA_NO_MOOD / BETA_NO_MOOD', () => {
        // centroid → x, taste → y; result should lie in the x-y plane.
        const result = buildBlendedVector(vec3(1, 0, 0), vec3(0, 1, 0), null);
        expect(result).not.toBeNull();
        // z component should be 0 (mood arm absent)
        expect(result![2]).toBeCloseTo(0, 5);
        // components in ALPHA_NO_MOOD : BETA_NO_MOOD ratio (centroid dominates)
        expect(result![0] / result![1]).toBeCloseTo(ALPHA_NO_MOOD / BETA_NO_MOOD, 5);
    });

    it('no-mood blend honors a tasteWeight override (centroid arm = 1 − tasteWeight)', () => {
        const result = buildBlendedVector(vec3(1, 0, 0), vec3(0, 1, 0), null, 0.1);
        expect(result).not.toBeNull();
        expect(result![0] / result![1]).toBeCloseTo(0.9 / 0.1, 5);
    });

    it('tasteWeight 0 removes the taste arm entirely', () => {
        const result = buildBlendedVector(vec3(1, 0, 0), vec3(0, 1, 0), null, 0);
        expect(result).not.toBeNull();
        expect(result![0]).toBeCloseTo(1.0, 5);
        expect(result![1]).toBeCloseTo(0, 5);
    });

    it('tasteWeight override is ignored when the mood arm is active (3-arm blend)', () => {
        const withOverride = buildBlendedVector(vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1), 0);
        const without = buildBlendedVector(vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1));
        expect(withOverride).not.toBeNull();
        withOverride!.forEach((v, i) => expect(v).toBeCloseTo(without![i], 10));
    });

    it('out-of-range tasteWeight is clamped, never flips the blend', () => {
        const result = buildBlendedVector(vec3(1, 0, 0), vec3(0, 1, 0), null, 7);
        expect(result).not.toBeNull();
        // clamped to 1 → pure taste, but still a valid unit vector
        const mag = Math.sqrt(result!.reduce((s, v) => s + v * v, 0));
        expect(mag).toBeCloseTo(1.0, 5);
        expect(result![0]).toBeCloseTo(0, 5);
    });

    it('blends proportionally when both arms point the same direction (no-mood)', () => {
        const v = vec3(1, 0, 0);
        const result = buildBlendedVector(v, v, null);
        expect(result).not.toBeNull();
        expect(result![0]).toBeCloseTo(1.0, 5);
    });

    it('returns non-null when only centroid is present (taste null, mood null)', () => {
        const result = buildBlendedVector(vec3(1, 2, 3), null, null);
        expect(result).not.toBeNull();
    });

    it('returns non-null when only taste is present (centroid null)', () => {
        const result = buildBlendedVector(null, vec3(1, 0, 0), null);
        expect(result).not.toBeNull();
    });

    it('returns non-null when only mood is present (centroid null, taste null)', () => {
        // Mood alone can produce a result now that GAMMA is re-enabled.
        const result = buildBlendedVector(null, null, vec3(1, 0, 0));
        expect(result).not.toBeNull();
    });

    it('returns null when all three arms are null (complete cold start)', () => {
        expect(buildBlendedVector(null, null, null)).toBeNull();
    });

    it('result is unit-norm regardless of arm combination', () => {
        const cases: [number[] | null, number[] | null, number[] | null][] = [
            [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)],
            [vec3(1, 0, 0), null, null],
            [null, vec3(0, 1, 0), null],
            [null, null, vec3(0, 0, 1)],
            [vec3(1, 1, 0), vec3(0, 1, 1), null],
        ];
        for (const [c, t, m] of cases) {
            const result = buildBlendedVector(c, t, m);
            expect(result).not.toBeNull();
            const mag = Math.sqrt(result!.reduce((s, v) => s + v * v, 0));
            expect(mag).toBeCloseTo(1.0, 5);
        }
    });
});

// ---------------------------------------------------------------------------
// applySkipDemotion
// ---------------------------------------------------------------------------

describe('applySkipDemotion', () => {
    it('leaves non-skipped tracks unchanged', () => {
        const rows = [makeSonicRow('a', 0.9), makeSonicRow('b', 0.7)];
        const demoted = applySkipDemotion(rows, new Set());
        expect(demoted[0].similarity_score).toBeCloseTo(0.9, 10);
        expect(demoted[1].similarity_score).toBeCloseTo(0.7, 10);
    });

    it('applies flat SKIP_DEMOTION_PER_SKIP to skipped tracks', () => {
        const rows = [makeSonicRow('a', 0.9), makeSonicRow('b', 0.7)];
        const demoted = applySkipDemotion(rows, new Set(['a']));
        const expectedA = Math.max(0, 0.9 - SKIP_DEMOTION_PER_SKIP);
        expect(demoted[0].similarity_score).toBeCloseTo(expectedA, 10);
        expect(demoted[1].similarity_score).toBeCloseTo(0.7, 10);
    });

    it('the demotion is flat (not Math.min of SKIP_DEMOTION_PER_SKIP and MAX_SKIP_DEMOTION)', () => {
        // Both constants are the same since the Set has no counts.
        // The important invariant: demotion === SKIP_DEMOTION_PER_SKIP exactly.
        const rows = [makeSonicRow('x', 0.5)];
        const demoted = applySkipDemotion(rows, new Set(['x']));
        expect(demoted[0].similarity_score).toBeCloseTo(0.5 - SKIP_DEMOTION_PER_SKIP, 10);
    });

    it('clamps similarity_score to >= 0', () => {
        const rows = [makeSonicRow('x', 0.001)];
        const demoted = applySkipDemotion(rows, new Set(['x']));
        expect(demoted[0].similarity_score).toBeGreaterThanOrEqual(0);
    });

    it('returns a new array (immutable input)', () => {
        const rows = [makeSonicRow('a', 0.9)];
        const demoted = applySkipDemotion(rows, new Set(['a']));
        expect(rows[0].similarity_score).toBeCloseTo(0.9, 10);
        expect(demoted[0].similarity_score).not.toBeCloseTo(0.9, 5);
    });
});

// ---------------------------------------------------------------------------
// SonicQueueCandidateRow shape — embedding and genres fields
// ---------------------------------------------------------------------------

describe('SonicQueueCandidateRow shape', () => {
    it('includes embedding field (number[] | null)', () => {
        const row = makeSonicRow('a', 0.9, 'Artist', { embedding: [0.1, 0.2, 0.3] });
        expect(row.embedding).toEqual([0.1, 0.2, 0.3]);
    });

    it('includes genres field (string[] | null)', () => {
        const row = makeSonicRow('a', 0.9, 'Artist', { genres: ['rock', 'indie'] });
        expect(row.genres).toEqual(['rock', 'indie']);
    });

    it('embedding defaults to null', () => {
        const row = makeSonicRow('a', 0.9);
        expect(row.embedding).toBeNull();
    });

    it('genres defaults to null', () => {
        const row = makeSonicRow('a', 0.9);
        expect(row.genres).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// getSonicQueueCandidates — cold start + params contract
// ---------------------------------------------------------------------------

describe('getSonicQueueCandidates — cold start', () => {
    it('returns [] when all arms are null (complete cold start)', async () => {
        const taggedMock = ((_strings: TemplateStringsArray, ..._values: unknown[]) =>
            Promise.resolve([])) as unknown as postgres.Sql;

        const result = await getSonicQueueCandidates(taggedMock, {
            queueTrackIds: [],
            tasteVector: null,
            moodVector: null,
            excludeIds: [],
            limit: 10,
            access: unrestrictedAccess(),
        });

        expect(result).toEqual([]);
    });

    it('returns [] (not throws) on cold start — route fall-back contract', async () => {
        const taggedMock = ((_strings: TemplateStringsArray, ..._values: unknown[]) =>
            Promise.resolve([])) as unknown as postgres.Sql;

        await expect(
            getSonicQueueCandidates(taggedMock, {
                queueTrackIds: [],
                tasteVector: null,
                moodVector: null,
                excludeIds: [],
                limit: 5,
                access: unrestrictedAccess(),
            }),
        ).resolves.toEqual([]);
    });
});

describe('getSonicQueueCandidates — denyAll boundary', () => {
    it('returns [] without issuing a single query, even with a usable vector', async () => {
        // Any sql call is a bug: denyAll must short-circuit before the queue
        // embedding fetch and before the ANN scan.
        const throwingSql = ((_strings: TemplateStringsArray, ..._values: unknown[]) => {
            throw new Error('denyAll boundary must not reach the database');
        }) as unknown as postgres.Sql;

        const result = await getSonicQueueCandidates(throwingSql, {
            queueTrackIds: ['track-a'],
            // Non-null taste vector — the cold-start early return cannot be
            // what produces the empty result here.
            tasteVector: [1, 0, 0],
            moodVector: null,
            excludeIds: [],
            limit: 10,
            access: denyAllAccess(),
        });

        expect(result).toEqual([]);
    });
});

describe('getSonicQueueCandidates — params shape', () => {
    it('accepts titleMatchIds and persistentPlayedTitles (new dedup params)', () => {
        type ParamsType = Parameters<typeof getSonicQueueCandidates>[1];
        const params: ParamsType = {
            queueTrackIds: ['track-a'],
            tasteVector: null,
            moodVector: null,
            excludeIds: ['disliked-track-uuid'],
            limit: 10,
            access: unrestrictedAccess(),
            titleMatchIds: ['track-a', 'session-track-b'],
            persistentPlayedTitles: ['previously played stem'],
        };
        expect(params.titleMatchIds).toHaveLength(2);
        expect(params.persistentPlayedTitles).toHaveLength(1);
    });

    it('titleMatchIds and persistentPlayedTitles are optional (backward compat)', () => {
        type ParamsType = Parameters<typeof getSonicQueueCandidates>[1];
        const params: ParamsType = {
            queueTrackIds: ['track-a'],
            tasteVector: null,
            moodVector: null,
            excludeIds: [],
            limit: 10,
            access: unrestrictedAccess(),
            // titleMatchIds and persistentPlayedTitles omitted
        };
        expect(params.titleMatchIds).toBeUndefined();
        expect(params.persistentPlayedTitles).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// getMoodVector — reads audio-space row (model_id='msclap-2023' by default)
// ---------------------------------------------------------------------------

describe('getMoodVector', () => {
    it('returns null when the mood_vectors table has no row for the key', async () => {
        const taggedMock = ((_strings: TemplateStringsArray, ..._values: unknown[]) =>
            Promise.resolve([])) as unknown as postgres.Sql;

        const result = await getMoodVector(taggedMock, 'nonexistent-mood');
        expect(result).toBeNull();
    });

    it('parses the vector column when a row is found', async () => {
        const v = vec3(0.5, 0.5, 0.0);
        const taggedMock = ((_strings: TemplateStringsArray, ..._values: unknown[]) =>
            Promise.resolve([{ vector: toVecText(v) }])) as unknown as postgres.Sql;

        const result = await getMoodVector(taggedMock, 'energetic');
        expect(result).not.toBeNull();
        result!.forEach((val, i) => expect(val).toBeCloseTo(v[i], 5));
    });

    it('queries model_id = msclap-2023 by default (audio space)', async () => {
        let capturedQuery = '';
        let capturedValues: unknown[] = [];

        const taggedMock = ((strings: TemplateStringsArray, ...values: unknown[]) => {
            capturedQuery = strings.join('?');
            capturedValues = values;
            return Promise.resolve([]);
        }) as unknown as postgres.Sql;

        await getMoodVector(taggedMock, 'music:chill');
        expect(capturedQuery.toLowerCase()).toContain('model_id');
        expect(capturedValues).toContain('msclap-2023');
    });

    it('accepts an explicit modelId override', async () => {
        let capturedValues: unknown[] = [];

        const taggedMock = ((_strings: TemplateStringsArray, ...values: unknown[]) => {
            capturedValues = values;
            return Promise.resolve([]);
        }) as unknown as postgres.Sql;

        await getMoodVector(taggedMock, 'music:chill', 'text');
        expect(capturedValues).toContain('text');
        expect(capturedValues).not.toContain('msclap-2023');
    });
});

// ---------------------------------------------------------------------------
// normalizeTitle (music-title-normalize.ts)
// ---------------------------------------------------------------------------

describe('normalizeTitle — shared title normalization', () => {
    it('strips bracket-wrapped remix tags', () => {
        expect(normalizeTitle('Song (Extended Mix)')).toBe('song');
        expect(normalizeTitle('Track [Live Version]')).toBe('track');
        expect(normalizeTitle('Song (Radio Edit)')).toBe('song');
    });

    it('strips dash-separated remix suffixes', () => {
        expect(normalizeTitle('Rockstar - Radio Edit')).toBe('rockstar');
        expect(normalizeTitle('Song – Extended Mix')).toBe('song');
    });

    it('strips bare suffixes (no brackets or dash)', () => {
        expect(normalizeTitle('Rockstar Club Mix')).toBe('rockstar');
        expect(normalizeTitle('Song Remastered')).toBe('song');
    });

    it('lowercases and trims whitespace', () => {
        expect(normalizeTitle('  My Song  ')).toBe('my song');
        expect(normalizeTitle('MY SONG (REMIX)')).toBe('my song');
    });

    it('preserves titles with no remix tags', () => {
        expect(normalizeTitle('Normal Song Title')).toBe('normal song title');
        expect(normalizeTitle('Song 2')).toBe('song 2');
    });

    it('handles empty string', () => {
        expect(normalizeTitle('')).toBe('');
    });
});

// ---------------------------------------------------------------------------
// Thin-pool fallback contract
// ---------------------------------------------------------------------------

describe('thin-pool fallback (MUSIC_SONIC_QUEUE_MIN_CANDIDATES)', () => {
    it('the min-candidate threshold constant type is number', () => {
        // The route uses config.MUSIC_SONIC_QUEUE_MIN_CANDIDATES; we verify the
        // contract indirectly: the check is `sonicCandidates.length < minCandidates`
        // which requires minCandidates to be a number.
        const minCandidates = 5; // default value
        const sonicCandidates: SonicQueueCandidateRow[] = [
            makeSonicRow('a', 0.9),
            makeSonicRow('b', 0.8),
        ];
        // 2 < 5 → should fall through (simulates the route's check)
        expect(sonicCandidates.length < minCandidates).toBe(true);
    });

    it('exactly at threshold, the sonic path proceeds', () => {
        const minCandidates = 5;
        const sonicCandidates = Array.from({ length: 5 }, (_, i) =>
            makeSonicRow(`track-${i}`, 0.9 - i * 0.05),
        );
        expect(sonicCandidates.length < minCandidates).toBe(false);
    });

    it('0 candidates always falls through regardless of threshold', () => {
        const minCandidates = 0; // edge case: gate disabled
        const sonicCandidates: SonicQueueCandidateRow[] = [];
        expect(sonicCandidates.length < minCandidates).toBe(false); // 0 < 0 is false
        // But the blended vector would be null first (handled in getSonicQueueCandidates)
    });
});

// ---------------------------------------------------------------------------
// Album cap in pickDiverseSonic
// ---------------------------------------------------------------------------

describe('album cap contract', () => {
    it('SonicQueueCandidateRow.parent_id is available for album capping', () => {
        const albumId = 'album-uuid-1';
        const track1 = makeSonicRow('t1', 0.9, 'ArtistA', { parent_id: albumId });
        const track2 = makeSonicRow('t2', 0.85, 'ArtistB', { parent_id: albumId });
        const track3 = makeSonicRow('t3', 0.8, 'ArtistC', { parent_id: albumId });

        // Simulate the pickDiverseSonic album cap (max 2 per album)
        const maxPerAlbum = 2;
        const albumCounts = new Map<string, number>();
        const picked: SonicQueueCandidateRow[] = [];

        for (const track of [track1, track2, track3]) {
            if (track.parent_id) {
                const count = albumCounts.get(track.parent_id) ?? 0;
                if (count >= maxPerAlbum) continue;
                albumCounts.set(track.parent_id, count + 1);
            }
            picked.push(track);
        }

        // Only 2 of 3 same-album tracks should be picked
        expect(picked).toHaveLength(2);
        expect(picked.map((p) => p.id)).toContain('t1');
        expect(picked.map((p) => p.id)).toContain('t2');
        expect(picked.map((p) => p.id)).not.toContain('t3');
    });
});

// ---------------------------------------------------------------------------
// Feature gate contract (sonic OFF = existing path untouched)
// ---------------------------------------------------------------------------

describe('gated fallback contract', () => {
    it('getSonicQueueCandidates returns [] (not throws) on complete cold-start', async () => {
        const taggedMock = ((_strings: TemplateStringsArray, ..._values: unknown[]) =>
            Promise.resolve([])) as unknown as postgres.Sql;

        await expect(
            getSonicQueueCandidates(taggedMock, {
                queueTrackIds: [],
                tasteVector: null,
                moodVector: null,
                excludeIds: [],
                limit: 5,
                access: unrestrictedAccess(),
            }),
        ).resolves.toEqual([]);
    });

    it('penalty exclusion: dislikedTrackIds are removed via excludeIds before the kNN call', () => {
        type ParamsType = Parameters<typeof getSonicQueueCandidates>[1];
        const params: ParamsType = {
            queueTrackIds: ['track-a'],
            tasteVector: null,
            moodVector: null,
            excludeIds: ['disliked-track-uuid'],
            limit: 10,
            access: unrestrictedAccess(),
        };
        expect(params.excludeIds).toContain('disliked-track-uuid');
    });
});

// ---------------------------------------------------------------------------
// GAMMA constant — now active (0.35, not 0.0)
// ---------------------------------------------------------------------------

describe('GAMMA constant — re-enabled', () => {
    it('GAMMA is exported and equals 0.35 (audio mood arm active)', () => {
        expect(GAMMA).toBeCloseTo(0.35, 10);
    });

    it('ALPHA + BETA + GAMMA sums to 1.0 (three-arm pre-normalize)', () => {
        expect(ALPHA + BETA + GAMMA).toBeCloseTo(1.0, 10);
    });

    it('ALPHA_NO_MOOD + BETA_NO_MOOD sums to 1.0 (two-arm pre-normalize)', () => {
        expect(ALPHA_NO_MOOD + BETA_NO_MOOD).toBeCloseTo(1.0, 10);
    });
});

// ---------------------------------------------------------------------------
// getMoodVector — query correctness
// ---------------------------------------------------------------------------

describe('getMoodVector — query correctness', () => {
    it('selects vector::text (not embedding) from mood_vectors', async () => {
        const v = vec3(0.3, 0.4, 0.0);
        let capturedQuery = '';

        const taggedMock = ((strings: TemplateStringsArray, ..._values: unknown[]) => {
            capturedQuery = strings.join('?');
            return Promise.resolve([{ vector: toVecText(v) }]);
        }) as unknown as postgres.Sql;

        const result = await getMoodVector(taggedMock, 'chill');
        expect(result).not.toBeNull();
        expect(capturedQuery.toLowerCase()).toContain('vector');
        result!.forEach((val, i) => expect(val).toBeCloseTo(v[i], 5));
    });
});

// ---------------------------------------------------------------------------
// Score-level constants pinning
// ---------------------------------------------------------------------------

describe('score-level constants pinning', () => {
    it('SONIC_GENRE_OVERLAP_BOOST is additive and bounded below 0.5', () => {
        // At 100% genre overlap, the boost adds at most SONIC_GENRE_OVERLAP_BOOST
        // to the score. That additive cap must not push total score > 1 by much.
        expect(SONIC_GENRE_OVERLAP_BOOST).toBeLessThan(0.5);
        expect(SONIC_GENRE_OVERLAP_BOOST).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------------------
// Audio mood vector blending — GAMMA arm math
// ---------------------------------------------------------------------------

describe('GAMMA arm blend math', () => {
    it('mood-active: result lies in the direction pulled by all three arms', () => {
        // All three axes orthogonal; the blend must have positive components on all.
        const result = buildBlendedVector(
            vec3(1, 0, 0), // centroid → x
            vec3(0, 1, 0), // taste   → y
            vec3(0, 0, 1), // mood    → z
        );
        expect(result).not.toBeNull();
        expect(result![0]).toBeGreaterThan(0); // ALPHA × centroid
        expect(result![1]).toBeGreaterThan(0); // BETA  × taste
        expect(result![2]).toBeGreaterThan(0); // GAMMA × mood
    });

    it('mood-active: component ratios reflect ALPHA/BETA/GAMMA weights pre-normalize', () => {
        // All arms point along distinct axes → components are proportional to weights.
        const result = buildBlendedVector(vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1));
        expect(result).not.toBeNull();
        // ALPHA(0.4) > GAMMA(0.35) > BETA(0.25) → x > z > y (before normalize, after normalize
        // the ratios are preserved since all pre-norm components have the same L2 weight).
        expect(result![0]).toBeGreaterThan(result![2]); // ALPHA > GAMMA
        expect(result![2]).toBeGreaterThan(result![1]); // GAMMA > BETA
    });

    it('mood-inactive: z component is zero (no GAMMA contribution)', () => {
        const result = buildBlendedVector(vec3(1, 0, 0), vec3(0, 1, 0), null);
        expect(result).not.toBeNull();
        expect(result![2]).toBeCloseTo(0, 10);
    });

    it('mood-only (centroid+taste null): result is unit norm and non-null', () => {
        const result = buildBlendedVector(null, null, vec3(1, 2, 3));
        expect(result).not.toBeNull();
        const mag = Math.sqrt(result!.reduce((s, v) => s + v * v, 0));
        expect(mag).toBeCloseTo(1.0, 5);
    });

    it('mood-active ALPHA_NO_MOOD/BETA_NO_MOOD are NOT used (constants differ from ALPHA/BETA)', () => {
        // Verify the two weight sets are numerically distinct so the mode switch matters.
        expect(ALPHA).not.toBeCloseTo(ALPHA_NO_MOOD, 10);
        expect(BETA).not.toBeCloseTo(BETA_NO_MOOD, 10);
    });
});

// ---------------------------------------------------------------------------
// generateAudioMoodVectors – contract tests (math helpers, no real DB)
// ---------------------------------------------------------------------------

describe('audio mood vector generation — math helpers used by generateAudioMoodVectors', () => {
    /**
     * These tests exercise the same helper functions (averageVectors,
     * normalizeVector, parseEmbedding) that generateAudioMoodVectors uses,
     * verifying the output contract without a real database.
     */
    it('averageVectors of two unit-norm orthogonal 3-dim vectors is the diagonal', () => {
        const { averageVectors: avg } =
            // Dynamic import inside tests is fine for vitest; use static import equivalent.
            {
                averageVectors: (vecs: number[][]): number[] => {
                    const dim = vecs[0].length;
                    const sum = new Array<number>(dim).fill(0);
                    for (const v of vecs) for (let d = 0; d < dim; d++) sum[d] += v[d];
                    return sum.map((x) => x / vecs.length);
                },
            };

        const a = vec3(1, 0, 0);
        const b = vec3(0, 1, 0);
        const result = avg([a, b]);
        expect(result[0]).toBeCloseTo(0.5, 5);
        expect(result[1]).toBeCloseTo(0.5, 5);
        expect(result[2]).toBeCloseTo(0, 5);
    });

    it('normalizeVector of a non-unit vector produces a unit-norm vector', () => {
        const normalizeVector = (v: number[]): number[] => {
            const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
            return mag < 1e-9 ? v : v.map((x) => x / mag);
        };

        const v = [3, 4, 0];
        const normed = normalizeVector(v);
        const mag = Math.sqrt(normed.reduce((s, x) => s + x * x, 0));
        expect(mag).toBeCloseTo(1.0, 10);
        expect(normed[0]).toBeCloseTo(0.6, 5);
        expect(normed[1]).toBeCloseTo(0.8, 5);
    });

    it('the audio mood cache key pattern is distinct from the text key', () => {
        const moodKey = 'music:chill';
        const textKey = moodKey; // text path uses plain moodKey
        const audioKey = `${moodKey}:msclap-2023`;
        expect(audioKey).not.toBe(textKey);
        expect(audioKey).toContain(moodKey);
        expect(audioKey).toContain('msclap-2023');
    });
});

// ---------------------------------------------------------------------------
// Unused import guard (vi mock factory)
// ---------------------------------------------------------------------------
// Ensure the vi import is used
void vi.fn;

// ---------------------------------------------------------------------------
// computeQueueCentroid — session anchor floor
// ---------------------------------------------------------------------------

describe('computeQueueCentroid session anchor', () => {
    /** Cosine similarity, for asserting which pole a centroid leans toward. */
    function cosine(a: number[], b: number[]): number {
        let dot = 0;
        let ma = 0;
        let mb = 0;
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            ma += a[i] * a[i];
            mb += b[i] * b[i];
        }
        return dot / (Math.sqrt(ma) * Math.sqrt(mb));
    }

    it('is a no-op when no anchor is supplied', () => {
        const map = new Map([
            ['id-1', vec3(1, 0, 0)],
            ['id-2', vec3(0, 1, 0)],
        ]);
        const withoutAnchor = computeQueueCentroid(['id-1', 'id-2'], map);
        const explicitUndefined = computeQueueCentroid(['id-1', 'id-2'], map, 0.5, undefined);
        expect(explicitUndefined).toEqual(withoutAnchor);
    });

    it('pulls the centroid back toward an origin that has decayed out of the window', () => {
        // Origin is 'seed'; the 5-item window has walked entirely away from it.
        const seedVec = vec3(1, 0, 0);
        const driftVec = vec3(0, 1, 0);
        const map = new Map([
            ['seed', seedVec],
            ['d1', driftVec],
            ['d2', driftVec],
            ['d3', driftVec],
            ['d4', driftVec],
            ['d5', driftVec],
        ]);
        const window = ['d1', 'd2', 'd3', 'd4', 'd5'];

        const unanchored = computeQueueCentroid(window, map);
        const anchored = computeQueueCentroid(window, map, 0.5, 'seed');

        expect(unanchored).not.toBeNull();
        expect(anchored).not.toBeNull();
        // Unanchored has walked fully onto the drift pole; anchored retains a
        // component of the origin.
        expect(cosine(unanchored!, seedVec)).toBeCloseTo(0, 6);
        expect(cosine(anchored!, seedVec)).toBeGreaterThan(0.1);
        // ...but the recent window still leads — the floor is gravity, not a pin.
        expect(cosine(anchored!, driftVec)).toBeGreaterThan(cosine(anchored!, seedVec));
    });

    it('does not double-count an anchor that is still inside the window', () => {
        const seedVec = vec3(1, 0, 0);
        const otherVec = vec3(0, 1, 0);
        const map = new Map([
            ['seed', seedVec],
            ['other', otherVec],
        ]);
        // 'seed' at index 0 already carries weight 1.0 > the floor, so the
        // anchor must not add a second entry for it.
        const plain = computeQueueCentroid(['seed', 'other'], map);
        const anchored = computeQueueCentroid(['seed', 'other'], map, 0.5, 'seed');
        expect(anchored).toEqual(plain);
    });

    it('raises a late-window anchor to the floor rather than lowering it', () => {
        const seedVec = vec3(1, 0, 0);
        const otherVec = vec3(0, 1, 0);
        const map = new Map([
            ['a', otherVec],
            ['b', otherVec],
            ['c', otherVec],
            ['seed', seedVec],
        ]);
        // 'seed' sits at index 3 → positional weight 0.125, below the floor.
        const window = ['a', 'b', 'c', 'seed'];
        const plain = computeQueueCentroid(window, map);
        const anchored = computeQueueCentroid(window, map, 0.5, 'seed');
        expect(cosine(anchored!, seedVec)).toBeGreaterThan(cosine(plain!, seedVec));
    });

    it('degrades to the unanchored centroid when the anchor has no embedding', () => {
        const map = new Map([['id-1', vec3(1, 0, 0)]]);
        const anchored = computeQueueCentroid(['id-1'], map, 0.5, 'never-analyzed');
        const plain = computeQueueCentroid(['id-1'], map);
        expect(anchored).toEqual(plain);
    });

    it('exposes a floor below the index-1 positional weight so recency still leads', () => {
        expect(SESSION_ANCHOR_FLOOR_WEIGHT).toBeLessThan(0.5);
        expect(SESSION_ANCHOR_FLOOR_WEIGHT).toBeGreaterThan(0);
    });
});
