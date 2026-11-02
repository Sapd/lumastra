// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    MusicDownloadCandidatesResponseSchema,
    MusicDownloadRescoreResponseSchema,
    MusicDownloadRescoreResultSchema,
} from './api-music-responses.js';

describe('MusicDownloadCandidatesResponseSchema', () => {
    it('accepts a candidate and preserves every field through parse', () => {
        const input = {
            lane: 'rotation',
            candidates: [
                {
                    id: '11111111-1111-1111-1111-111111111111',
                    rank: 0,
                    estBytes: 4210544,
                    estBytesExact: false,
                    reason: 'heavy_rotation',
                    reasonSubject: {
                        type: 'artist',
                        id: '22222222-2222-2222-2222-222222222222',
                        name: 'Boards of Canada',
                    },
                    // Required-and-nullable, never optional: absent and null
                    // collapse in Swift codegen, so the wire always carries them.
                    embeddingProjection: 'A'.repeat(88),
                    embeddingProjectionVersion: 1,
                },
            ],
            maxConcurrentDownloads: 2,
            scoreVersion: 1,
        };
        // Parity with mount()'s conformance gate: it emits the STRIPPED result,
        // so a field missing from the schema silently vanishes in prod.
        expect(MusicDownloadCandidatesResponseSchema.parse(input)).toEqual(input);
    });

    it('accepts an unknown reason string — reason must not be an enum', () => {
        const parsed = MusicDownloadCandidatesResponseSchema.parse({
            lane: 'rotation',
            candidates: [
                {
                    id: '11111111-1111-1111-1111-111111111111',
                    rank: 0,
                    estBytes: null,
                    estBytesExact: false,
                    reason: 'next_episode_of_followed_series',
                    reasonSubject: null,
                    // The ~15 prod tracks with no embedding: null, not absent.
                    embeddingProjection: null,
                    embeddingProjectionVersion: null,
                },
            ],
            maxConcurrentDownloads: 2,
            scoreVersion: 1,
        });
        expect(parsed.candidates[0]!.reason).toBe('next_episode_of_followed_series');
    });
});

describe('MusicDownloadRescoreResponseSchema', () => {
    it('accepts all three statuses, including an unknown toLane', () => {
        const input = {
            generation: 'g-1',
            results: [
                {
                    mediaId: '11111111-1111-1111-1111-111111111111',
                    status: 'ranked',
                    rank: 12,
                    toLane: null,
                },
                {
                    mediaId: '22222222-2222-2222-2222-222222222222',
                    status: 'gone',
                    rank: null,
                    toLane: null,
                },
                {
                    mediaId: '33333333-3333-3333-3333-333333333333',
                    status: 'graduated',
                    rank: null,
                    toLane: 'series_continue',
                },
            ],
            scoreVersion: 1,
            statusVocabulary: ['ranked', 'gone', 'graduated'],
        };
        expect(MusicDownloadRescoreResponseSchema.parse(input)).toEqual(input);
    });
});

/**
 * Change 1 (iOS-feedback round 3): `statusVocabulary` turns the client's
 * silent unknown-status retention into a leading indicator — a client diffs
 * this array against its own allow-list instead of discovering staleness
 * only after enough of its pool went unrecognized to stop shedding.
 */
describe('MusicDownloadRescoreResponseSchema.statusVocabulary field description reaches the wire', () => {
    it('documents statusVocabulary as the full emittable set, and the stale-allow-list rule', () => {
        const description = MusicDownloadRescoreResponseSchema.shape.statusVocabulary.description;
        expect(description).toBeTruthy();
        expect(description).toMatch(/full `status` vocabulary/i);
        expect(description).toMatch(/this server build can emit/i);
        expect(description).toMatch(/stale/i);
    });
});

/**
 * Change 1 (iOS-feedback round 2): the generated OpenAPI spec used to emit a
 * bare `status: type: string` with NO description — the eviction/graduation
 * semantics lived only in a JSDoc comment that never reaches the wire. These
 * assertions pin the `.describe()` calls that fix that, so a future edit
 * can't silently drop them back to undocumented strings without a test
 * failing. (The *content* of each description is asserted narrowly enough
 * that dropping a key term — e.g. the eviction rule, or the @frozen-Swift-
 * enum rationale for staying an open string — also fails.)
 */
describe('MusicDownloadRescoreResultSchema field descriptions reach the wire', () => {
    const shape = MusicDownloadRescoreResultSchema.shape;

    it('documents `status`: the three values, and the client eviction-safety rule', () => {
        const description = shape.status.description;
        expect(description).toBeTruthy();
        expect(description).toContain('ranked');
        expect(description).toContain('gone');
        expect(description).toContain('graduated');
        // The data-loss-prevention rule itself, not just the vocabulary.
        expect(description).toMatch(/unrecognized/i);
        expect(description).toMatch(/MUST be retained/);
        // Never an enum, and why.
        expect(description).toMatch(/never an enum/i);
        expect(description).toMatch(/@frozen/);
    });

    it('documents `rank`: ordinal WITHIN the cohort, non-null only when ranked', () => {
        const description = shape.rank.description;
        expect(description).toBeTruthy();
        expect(description).toMatch(/within the submitted cohort/i);
        expect(description).toContain('ranked');
    });

    it('documents `toLane`: destination lane on graduated, open string', () => {
        const description = shape.toLane.description;
        expect(description).toBeTruthy();
        expect(description).toMatch(/graduated/);
        expect(description).toMatch(/never an enum/i);
    });
});

describe('scoreVersion field descriptions reach the wire (Change 3)', () => {
    it('documents scoreVersion on the rescore response as the ranking-function version, not a comparability token', () => {
        const description = MusicDownloadRescoreResponseSchema.shape.scoreVersion.description;
        expect(description).toBeTruthy();
        expect(description).toMatch(/NOT a comparability token/);
        expect(description).toMatch(/generation/);
    });

    it('documents scoreVersion on the candidates response as a drift signal, not a ranking guarantee for this response', () => {
        const description = MusicDownloadCandidatesResponseSchema.shape.scoreVersion.description;
        expect(description).toBeTruthy();
        expect(description).toMatch(/rescore/);
        expect(description).toMatch(/NOT a comparability token/);
    });
});
