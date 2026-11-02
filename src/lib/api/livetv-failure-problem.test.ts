// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    LIVETV_FAILURE_REASONS,
    isLiveTvFailureCode,
    parseLiveTvFailureProblem,
    parseLiveTvSessionFailure,
} from './livetv-failure-problem.js';
import { LIVETV_FAILURE_POLICY } from '../../shared/livetv-failure-reason.js';

describe('parseLiveTvFailureProblem', () => {
    it.each(LIVETV_FAILURE_REASONS)('accepts %s and falls back to the shared policy', (code) => {
        const parsed = parseLiveTvFailureProblem({ code, error: 'x', status: 502 });
        const policy = LIVETV_FAILURE_POLICY[code];
        expect(parsed).toEqual({
            kind: 'failure',
            code,
            retryable: policy.retryable,
            ...(policy.retryable && policy.retryAfterMs !== undefined
                ? { retryAfterMs: policy.retryAfterMs }
                : {}),
        });
    });

    it('accepts dependency_unavailable as retryable after 5 s', () => {
        expect(parseLiveTvFailureProblem({ code: 'dependency_unavailable' })).toEqual({
            kind: 'failure',
            code: 'dependency_unavailable',
            retryable: true,
            retryAfterMs: 5000,
        });
    });

    it('the body wins over the policy', () => {
        expect(
            parseLiveTvFailureProblem({
                code: 'channel_offline',
                failure: { retryable: true },
                retryAfter: 1.234,
            }),
        ).toEqual({
            kind: 'failure',
            code: 'channel_offline',
            retryable: true,
            retryAfterMs: 1234,
        });
    });

    it('drops retryAfterMs from a body that is not retryable', () => {
        expect(
            parseLiveTvFailureProblem({ code: 'geo_blocked', failure: { retryable: false } }),
        ).toEqual({
            kind: 'failure',
            code: 'geo_blocked',
            retryable: false,
        });
    });

    it('keeps well-formed feedsTried and skips malformed entries', () => {
        const parsed = parseLiveTvFailureProblem({
            code: 'all_feeds_failed',
            failure: {
                retryable: false,
                feedsTried: [
                    {
                        feedId: 'a',
                        feedName: 'Main',
                        reason: 'provider_unreachable',
                        upstreamStatus: 504,
                    },
                    { reason: 'channel_offline' },
                    { reason: 'not_a_reason' },
                    { reason: 'all_feeds_failed' },
                    'nope',
                    null,
                    { feedId: 5, reason: 'no_video' },
                ],
            },
        });
        expect(parsed?.feedsTried).toEqual([
            { feedId: 'a', feedName: 'Main', reason: 'provider_unreachable', upstreamStatus: 504 },
            { reason: 'channel_offline' },
        ]);
    });

    it('omits feedsTried when nothing usable is in it', () => {
        const parsed = parseLiveTvFailureProblem({
            code: 'all_feeds_failed',
            failure: { feedsTried: [{}] },
        });
        expect(parsed).not.toBeNull();
        expect(parsed).not.toHaveProperty('feedsTried');
    });

    it('ignores wrongly typed optional fields instead of failing', () => {
        expect(
            parseLiveTvFailureProblem({
                code: 'upstream_stalled',
                retryAfter: 'soon',
                failure: { retryable: 'yes', feedsTried: 'many' },
            }),
        ).toEqual({
            kind: 'failure',
            code: 'upstream_stalled',
            retryable: true,
            retryAfterMs: 3000,
        });
    });

    it.each([
        ['null', null],
        ['undefined', undefined],
        ['a string', 'channel_offline'],
        ['a number', 502],
        ['an array', [{ code: 'channel_offline' }]],
        ['an empty object', {}],
        ['an unknown code', { code: 'teapot' }],
        ['a non-string code', { code: 42 }],
        ['stream_limit (handled elsewhere)', { code: 'stream_limit' }],
        ['station_not_found', { code: 'station_not_found' }],
        ['cap_unavailable', { code: 'cap_unavailable' }],
        ['the legacy flat shape', { error: 'spawn_failed' }],
    ])('returns null for %s', (_name, body) => {
        expect(parseLiveTvFailureProblem(body)).toBeNull();
    });
});

describe('parseLiveTvSessionFailure', () => {
    it('reads the failure block', () => {
        expect(
            parseLiveTvSessionFailure({
                state: 'ended',
                endReason: 'failed',
                failure: {
                    code: 'provider_connection_limit',
                    retryable: true,
                    retryAfterMs: 30000,
                    at: '2026-10-20T10:00:00Z',
                },
            }),
        ).toEqual({
            kind: 'failure',
            code: 'provider_connection_limit',
            retryable: true,
            retryAfterMs: 30000,
        });
    });

    it.each([
        ['no failure', { state: 'active' }],
        ['a null failure', { failure: null }],
        ['an array failure', { failure: [] }],
        ['an unknown code', { failure: { code: 'teapot' } }],
        ['a non-object body', 'x'],
        ['null', null],
    ])('returns null for %s', (_name, body) => {
        expect(parseLiveTvSessionFailure(body)).toBeNull();
    });
});

describe('isLiveTvFailureCode', () => {
    it('knows the nine reasons and dependency_unavailable only', () => {
        for (const code of LIVETV_FAILURE_REASONS) expect(isLiveTvFailureCode(code)).toBe(true);
        expect(isLiveTvFailureCode('dependency_unavailable')).toBe(true);
        expect(isLiveTvFailureCode('stream_limit')).toBe(false);
        expect(isLiveTvFailureCode(undefined)).toBe(false);
    });
});
