// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `OfflineSessionsRequestSchema` (mounted as `request.body`) validates only
 * the ENVELOPE — it must not be able to fail the whole request over a single
 * malformed record. `OfflinePlaybackRecordSchema` still owns per-record validation;
 * the endpoint handler applies it per item so one bad record becomes one
 * `rejected` result instead of a whole-batch 422.
 */

import { describe, it, expect } from 'vitest';
import {
    OfflinePlaybackRecordSchema,
    OfflineSessionsRequestSchema,
    OfflineSessionsBatch,
    isRetryableOfflineResult,
    OFFLINE_MAX_BATCH,
    OFFLINE_REJECTION_REASONS,
    PERMANENT_OFFLINE_REJECTION_REASONS,
} from './offline-playback.js';

function validRecord(overrides: Record<string, unknown> = {}) {
    const now = new Date();
    return {
        eventId: 'dddddddd-0000-4000-8000-000000000004',
        mediaId: 'bbbbbbbb-0000-4000-8000-000000000002',
        startedAt: new Date(now.getTime() - 60_000).toISOString(),
        endedAt: now.toISOString(),
        positionMs: 60_000,
        runtimeMs: 3_600_000,
        sessionElapsedMs: 60_000,
        endReason: 'stopped',
        ...overrides,
    };
}

describe('OfflineSessionsRequestSchema (runtime envelope)', () => {
    it('accepts a batch containing a structurally malformed record — envelope validation must not enforce per-record rules', () => {
        const malformed = { eventId: 'not-a-uuid' }; // missing every other field, bad UUID
        const result = OfflineSessionsRequestSchema.safeParse({
            sessions: [validRecord(), malformed],
        });
        expect(result.success).toBe(true);
    });

    it('accepts a record whose endedAt precedes startedAt — that rule is enforced per-record in the handler, not the envelope', () => {
        const backwards = validRecord({
            startedAt: new Date().toISOString(),
            endedAt: new Date(Date.now() - 60_000).toISOString(),
        });
        const result = OfflineSessionsRequestSchema.safeParse({ sessions: [backwards] });
        expect(result.success).toBe(true);
    });

    it('rejects a request with no `sessions` field — malformed envelope', () => {
        const result = OfflineSessionsRequestSchema.safeParse({});
        expect(result.success).toBe(false);
    });

    it('rejects a request whose `sessions` is not an array — malformed envelope', () => {
        const result = OfflineSessionsRequestSchema.safeParse({ sessions: 'nope' });
        expect(result.success).toBe(false);
    });

    it('rejects an empty `sessions` array — malformed envelope', () => {
        const result = OfflineSessionsRequestSchema.safeParse({ sessions: [] });
        expect(result.success).toBe(false);
    });

    it(`rejects a batch over ${OFFLINE_MAX_BATCH} records — malformed envelope`, () => {
        const sessions = Array.from({ length: OFFLINE_MAX_BATCH + 1 }, () => validRecord());
        const result = OfflineSessionsRequestSchema.safeParse({ sessions });
        expect(result.success).toBe(false);
    });

    it(`accepts exactly ${OFFLINE_MAX_BATCH} records`, () => {
        const sessions = Array.from({ length: OFFLINE_MAX_BATCH }, () => validRecord());
        const result = OfflineSessionsRequestSchema.safeParse({ sessions });
        expect(result.success).toBe(true);
    });
});

describe('OfflinePlaybackRecordSchema (per-record — enforced in the handler)', () => {
    it('accepts a well-formed record', () => {
        expect(OfflinePlaybackRecordSchema.safeParse(validRecord()).success).toBe(true);
    });

    it('rejects endedAt preceding startedAt', () => {
        const backwards = validRecord({
            startedAt: new Date().toISOString(),
            endedAt: new Date(Date.now() - 60_000).toISOString(),
        });
        expect(OfflinePlaybackRecordSchema.safeParse(backwards).success).toBe(false);
    });

    it('rejects sessionElapsedMs exceeding the wall-clock window beyond tolerance', () => {
        const now = new Date();
        const started = new Date(now.getTime() - 60_000);
        const overElapsed = validRecord({
            startedAt: started.toISOString(),
            endedAt: now.toISOString(),
            sessionElapsedMs: 60_000 + 5 * 60_000, // window is 60s, tolerance is 60s
        });
        expect(OfflinePlaybackRecordSchema.safeParse(overElapsed).success).toBe(false);
    });

    it('rejects a non-UUID eventId', () => {
        expect(
            OfflinePlaybackRecordSchema.safeParse(validRecord({ eventId: 'not-a-uuid' })).success,
        ).toBe(false);
    });
});

describe('isRetryableOfflineResult', () => {
    it('treats the four known-permanent reasons as terminal', () => {
        for (const reason of PERMANENT_OFFLINE_REJECTION_REASONS) {
            expect(isRetryableOfflineResult('rejected', reason)).toBe(false);
        }
        // The set a client would otherwise have to hardcode.
        expect([...PERMANENT_OFFLINE_REJECTION_REASONS]).toEqual([
            'invalid',
            'too_old',
            'unsupported_media_type',
            'not_found',
        ]);
    });

    it('treats every other published reason as retryable', () => {
        // These are the two that actually cost data when misfiled as terminal:
        // `write_failed` rolled its group back and wrote nothing, and
        // `too_far_future` becomes valid once server time catches up.
        expect(isRetryableOfflineResult('rejected', 'write_failed')).toBe(true);
        expect(isRetryableOfflineResult('rejected', 'too_far_future')).toBe(true);
        expect(isRetryableOfflineResult('rejected', 'not_processed')).toBe(true);
    });

    it('fails SAFE on a reason it does not recognise', () => {
        // The asymmetry this encodes: calling a permanent reason retryable
        // wastes a batch slot until the record ages out; calling a transient
        // one permanent destroys recoverable listening. So an unclassified
        // future reason must come back retryable, never terminal.
        expect(isRetryableOfflineResult('rejected', 'some_future_reason')).toBe(true);
        expect(isRetryableOfflineResult('rejected', undefined)).toBe(true);
    });

    it('never marks a success retryable', () => {
        expect(isRetryableOfflineResult('accepted', undefined)).toBe(false);
        // A duplicate means an earlier submission already landed — terminal
        // success, not a failure to retry.
        expect(isRetryableOfflineResult('duplicate', undefined)).toBe(false);
    });

    it('classifies every published reason exactly once', () => {
        // Guards the vocabulary against drifting apart from its classification.
        for (const reason of OFFLINE_REJECTION_REASONS) {
            expect(typeof isRetryableOfflineResult('rejected', reason)).toBe('boolean');
        }
        const permanent = new Set<string>(PERMANENT_OFFLINE_REJECTION_REASONS);
        expect(OFFLINE_REJECTION_REASONS.filter((r) => permanent.has(r)).length).toBe(
            PERMANENT_OFFLINE_REJECTION_REASONS.length,
        );
    });
});

describe('typed offline batch documentation', () => {
    it('publishes typed records while retaining lenient per-record runtime validation', () => {
        const malformed = { eventId: 'invalid' };
        expect(OfflineSessionsBatch.docs.safeParse({ sessions: [validRecord()] }).success).toBe(
            true,
        );
        expect(OfflineSessionsBatch.docs.safeParse({ sessions: [malformed] }).success).toBe(false);
        expect(OfflineSessionsBatch.runtime.safeParse({ sessions: [malformed] }).success).toBe(
            true,
        );
    });
});
