// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    DownloadCandidateSchema,
    DownloadCandidatesResponseSchema,
    DownloadRescoreResultSchema,
    DownloadRescoreResponseSchema,
} from './api-downloads.js';

const CANDIDATE = {
    mediaId: '11111111-1111-1111-1111-111111111111',
    fileId: 'ffffffff-1111-1111-1111-111111111111',
    coversMediaIds: ['11111111-1111-1111-1111-111111111111'],
    rank: 0,
    distance: 0,
    seriesId: '22222222-2222-2222-2222-222222222222',
    seriesTitle: 'Starhaven',
    seasonNumber: 2,
    episodeNumber: 4,
    rungId: '720p',
    estBytes: 1_180_000_000,
    estBytesExact: false,
    reason: 'next_episode',
    reasonSubject: {
        type: 'series',
        id: '22222222-2222-2222-2222-222222222222',
        name: 'Starhaven',
    },
};

const RESPONSE = {
    lane: 'series-next-up',
    graduationPolicy: 'delete',
    candidates: [CANDIDATE],
    maxConcurrentDownloads: 2,
    maxConcurrentPreparations: 1,
    prepareRePostSeconds: 185,
    prepareQueueDepth: 0,
    unbudgetableCount: 0,
    scoreVersion: 1,
    rungVocabulary: ['1080p', '720p', '540p', '360p'],
};

describe('DownloadCandidatesResponseSchema', () => {
    it('preserves every field through parse', () => {
        // Parity with mount()'s conformance gate: it emits the STRIPPED result,
        // so a field missing from the schema silently vanishes in prod.
        expect(DownloadCandidatesResponseSchema.parse(RESPONSE)).toEqual(RESPONSE);
    });

    it('accepts an unknown lane, reason and graduationPolicy — none may be an enum', () => {
        const parsed = DownloadCandidatesResponseSchema.parse({
            ...RESPONSE,
            lane: 'movies-watchlist',
            graduationPolicy: 'archive',
            candidates: [{ ...CANDIDATE, reason: 'because_you_rated_it' }],
        });
        expect(parsed.lane).toBe('movies-watchlist');
        expect(parsed.graduationPolicy).toBe('archive');
        expect(parsed.candidates[0]!.reason).toBe('because_you_rated_it');
    });

    it('carries coversMediaIds so one artifact can satisfy several episodes', () => {
        const parsed = DownloadCandidatesResponseSchema.parse({
            ...RESPONSE,
            candidates: [
                {
                    ...CANDIDATE,
                    coversMediaIds: [
                        '11111111-1111-1111-1111-111111111111',
                        '33333333-3333-3333-3333-333333333333',
                    ],
                },
            ],
        });
        expect(parsed.candidates[0]!.coversMediaIds).toHaveLength(2);
    });

    it('rejects an absent estBytes but accepts an explicit null', () => {
        // Nullable, NEVER optional: absent and null collapse into one Swift
        // Optional, so allowing both makes them indistinguishable on the wire.
        const { estBytes: _drop, ...withoutEstBytes } = CANDIDATE;
        expect(() => DownloadCandidateSchema.parse(withoutEstBytes)).toThrow();
        expect(DownloadCandidateSchema.parse({ ...CANDIDATE, estBytes: null }).estBytes).toBeNull();
    });

    it('rejects an absent coversMediaIds — a missing array is not an empty one', () => {
        const { coversMediaIds: _drop, ...withoutCovers } = CANDIDATE;
        expect(() => DownloadCandidateSchema.parse(withoutCovers)).toThrow();
    });

    it('requires rungVocabulary — a client cannot learn the ladder if the field is optional', () => {
        const { rungVocabulary: _drop, ...withoutVocabulary } = RESPONSE;
        expect(() => DownloadCandidatesResponseSchema.parse(withoutVocabulary)).toThrow();
    });

    it('carries rungVocabulary even with an empty candidates array — an empty pool is exactly when it matters most', () => {
        const parsed = DownloadCandidatesResponseSchema.parse({ ...RESPONSE, candidates: [] });
        expect(parsed.rungVocabulary).toEqual(['1080p', '720p', '540p', '360p']);
    });

    it('publishes stable component ids', () => {
        // Renaming any of these rewrites generated Swift types on a shipped surface.
        expect(DownloadCandidateSchema.meta()?.id).toBe('DownloadCandidate');
        expect(DownloadCandidatesResponseSchema.meta()?.id).toBe('DownloadCandidatesResponse');
        expect(DownloadRescoreResultSchema.meta()?.id).toBe('DownloadRescoreResult');
        expect(DownloadRescoreResponseSchema.meta()?.id).toBe('DownloadRescoreResponse');
    });
});

describe('DownloadRescoreResponseSchema', () => {
    it('accepts all three statuses, including an unknown toLane', () => {
        const input = {
            generation: 'series-next-up:2b1f',
            scoreVersion: 1,
            statusVocabulary: ['ranked', 'graduated', 'gone'],
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
                    toLane: 'some-future-lane',
                },
            ],
        };
        expect(DownloadRescoreResponseSchema.parse(input)).toEqual(input);
    });

    it('rejects an absent rank or toLane on a result', () => {
        const base = {
            mediaId: '11111111-1111-1111-1111-111111111111',
            status: 'ranked',
            rank: 0,
            toLane: null,
        };
        const { rank: _r, ...noRank } = base;
        const { toLane: _t, ...noToLane } = base;
        expect(() => DownloadRescoreResultSchema.parse(noRank)).toThrow();
        expect(() => DownloadRescoreResultSchema.parse(noToLane)).toThrow();
    });
});

describe('the unknown-status safety rule (regression guard)', () => {
    /**
     * This rule governs DELETION of a user's offline content, and an earlier
     * wording of it was self-defeating: it said an unrecognized status must be
     * retained "and sorted worst in the eviction order so it is first out only
     * when the budget genuinely requires evicting something". A full pool sitting
     * at its budget is the steady state, not an edge case, so "first out when
     * budget requires it" resolves to "deleted on the next cycle" — exactly what
     * the rule exists to prevent. The iOS team caught it; these assertions stop it
     * coming back.
     *
     * Presence of a description is not enough. Earlier verification confirmed the
     * text reached the wire and still missed this, because it checked that the
     * field was documented rather than what it said.
     */
    function statusDescription(): string {
        const shape = DownloadRescoreResultSchema as unknown as {
            shape: Record<string, { description?: string }>;
        };
        return shape.shape.status?.description ?? '';
    }

    it('never tells a client to sort unknown statuses worst', () => {
        expect(statusDescription()).not.toMatch(/sorted worst/i);
    });

    it('states that an unknown status must not sort below a known ranked item', () => {
        expect(statusDescription()).toMatch(/MUST NOT sort below/i);
    });

    it('prefers overshooting the budget to evicting an unknown', () => {
        expect(statusDescription()).toMatch(/overshoot/i);
    });

    it('still requires an explicit recognized status before evicting', () => {
        expect(statusDescription()).toMatch(/RECOGNIZED/);
    });
});
