// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { liveTvFailureProblem, problem } from './problem.js';
import {
    LIVETV_FAILURE_POLICY,
    LIVETV_FAILURE_REASONS,
} from '../../../shared/livetv-failure-reason.js';

const feedsTried = [
    { feedId: 'feed-a', feedName: 'Das Erste HD', reason: 'provider_auth_failed' as const },
    {
        feedId: 'feed-b',
        feedName: 'Das Erste SD',
        reason: 'channel_offline' as const,
        upstreamStatus: 404,
    },
];

describe('liveTvFailureProblem', () => {
    it.each(LIVETV_FAILURE_REASONS)(
        '%s answers the policy status with its code',
        async (reason) => {
            const policy = LIVETV_FAILURE_POLICY[reason];
            const response = liveTvFailureProblem({
                reason,
                retryable: policy.retryable,
                retryAfterMs: policy.retryAfterMs,
                isAdmin: false,
            });
            expect(response.status).toBe(policy.status);
            expect(response.headers.get('Content-Type')).toContain('application/problem+json');
            const body = await response.json();
            expect(body).toMatchObject({
                code: reason,
                status: policy.status,
                failure: { retryable: policy.retryable },
                ...(policy.retryAfterMs !== undefined
                    ? { retryAfter: Math.ceil(policy.retryAfterMs / 1000) }
                    : {}),
            });
            expect(body).not.toHaveProperty('retryAfterMs');
            expect(body).not.toHaveProperty('retryable');
        },
    );

    it('sets retryAfter and Retry-After in whole seconds, rounded up, only with retryAfterMs', async () => {
        const withWait = liveTvFailureProblem({
            reason: 'provider_unreachable',
            retryable: true,
            retryAfterMs: 10_000,
            isAdmin: false,
        });
        expect(withWait.headers.get('Retry-After')).toBe('10');
        expect((await withWait.json()).retryAfter).toBe(10);
        const fractional = liveTvFailureProblem({
            reason: 'upstream_stalled',
            retryable: true,
            retryAfterMs: 2_500,
            isAdmin: false,
        });
        expect(fractional.headers.get('Retry-After')).toBe('3');
        expect((await fractional.json()).retryAfter).toBe(3);
        const without = liveTvFailureProblem({
            reason: 'channel_offline',
            retryable: false,
            isAdmin: false,
        });
        expect(without.headers.get('Retry-After')).toBeNull();
        expect(await without.json()).not.toHaveProperty('retryAfter');
    });

    it('shows feedsTried to administrators and strips it for everyone else', async () => {
        const admin = await liveTvFailureProblem({
            reason: 'all_feeds_failed',
            retryable: false,
            feedsTried,
            isAdmin: true,
        }).json();
        expect(admin.failure.feedsTried).toEqual(feedsTried);
        expect(admin).not.toHaveProperty('feedsTried');
        const viewer = await liveTvFailureProblem({
            reason: 'all_feeds_failed',
            retryable: false,
            feedsTried,
            isAdmin: false,
        }).json();
        expect('feedsTried' in viewer.failure).toBe(false);
    });

    it('omits an empty feedsTried even for administrators', async () => {
        const body = await liveTvFailureProblem({
            reason: 'channel_offline',
            retryable: false,
            feedsTried: [],
            isAdmin: true,
        }).json();
        expect('feedsTried' in body.failure).toBe(false);
    });

    it('can end a session: 410 with error and a detail reason', async () => {
        const response = liveTvFailureProblem({
            reason: 'upstream_stalled',
            retryable: true,
            retryAfterMs: 3_000,
            isAdmin: false,
            status: 410,
            error: 'playback_session_ended',
            detailReason: 'failed',
        });
        expect(response.status).toBe(410);
        expect(await response.json()).toMatchObject({
            code: 'upstream_stalled',
            error: 'playback_session_ended',
            reason: 'failed',
            status: 410,
        });
    });
});

describe('problem() Live TV fields', () => {
    it('stream_limit style problems carry the failure extension next to retryAfter', async () => {
        const response = problem('stream_limit', {
            retryAfter: 30,
            failure: { retryable: true },
        });
        expect(response.status).toBe(503);
        expect(response.headers.get('Retry-After')).toBe('30');
        expect(await response.json()).toMatchObject({
            code: 'stream_limit',
            failure: { retryable: true },
            retryAfter: 30,
        });
    });
});
