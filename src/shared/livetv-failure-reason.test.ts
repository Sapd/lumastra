// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    LIVETV_FAILURE_POLICY,
    LIVETV_FAILURE_REASONS,
    LIVETV_IMMEDIATE_FAILOVER_REASONS,
    classifyFfmpegStderr,
    classifyGuardFailure,
    classifyUpstreamResponse,
    combineFeedFailures,
    isLiveTvFailureReason,
    liveTvFailurePolicyFor,
    type LiveTvFailureReason,
    type LiveTvFeedFailure,
    type LiveTvStderrSource,
} from './livetv-failure-reason.js';
import type { LiveTvFailureEventReason } from './livetv-failure-event.js';

interface FixtureCase {
    fn: 'upstream' | 'guard' | 'stderr' | 'combine';
    input: Record<string, unknown>;
    expected: Record<string, unknown> | null;
    note?: string;
}

const fixture = JSON.parse(
    readFileSync(new URL('./livetv-failure-reasons.fixture.json', import.meta.url), 'utf8'),
) as { version: number; cases: FixtureCase[] };

function run(c: FixtureCase): Record<string, unknown> | null {
    const input = c.input;
    let reason: string | null;
    switch (c.fn) {
        case 'upstream':
            reason = classifyUpstreamResponse(
                input.status as number,
                input.bodySnippet as string | undefined,
            );
            break;
        case 'guard':
            reason = classifyGuardFailure(input.status as number, input.diagnostic as string);
            break;
        case 'stderr':
            reason = classifyFfmpegStderr(input.tail as string, {
                source: input.source as LiveTvStderrSource,
                producedSegments: input.producedSegments as boolean,
                ...(input.transcoding !== undefined
                    ? { transcoding: input.transcoding as boolean }
                    : {}),
            });
            break;
        case 'combine':
            return { ...combineFeedFailures(input.feeds as LiveTvFeedFailure[]) };
    }
    return reason === null ? null : { reason };
}

describe('livetv failure reason fixture', () => {
    test('is version 1 and covers every classifier', () => {
        expect(fixture.version).toBe(1);
        expect(fixture.cases.length).toBeGreaterThanOrEqual(40);
        for (const fn of ['upstream', 'guard', 'stderr', 'combine']) {
            expect(fixture.cases.some((c) => c.fn === fn)).toBe(true);
        }
    });

    test('every expected reason is a known reason', () => {
        for (const c of fixture.cases) {
            if (c.expected) expect(isLiveTvFailureReason(c.expected.reason)).toBe(true);
        }
    });

    test.each(fixture.cases.map((c, i) => [i, c.fn, c.note ?? '', c] as const))(
        'case %i (%s) %s',
        (_i, _fn, _note, c) => {
            expect(run(c)).toEqual(c.expected);
        },
    );
});

describe('failure policy table', () => {
    test('every reason has a policy, and retryAfterMs only where retryable', () => {
        for (const reason of LIVETV_FAILURE_REASONS) {
            const policy = liveTvFailurePolicyFor(reason);
            expect(policy).toBe(LIVETV_FAILURE_POLICY[reason]);
            if (policy.retryAfterMs !== undefined) expect(policy.retryable).toBe(true);
        }
    });

    test('statuses and retry hints match the design table', () => {
        expect(LIVETV_FAILURE_POLICY.channel_offline).toEqual({ status: 502, retryable: false });
        expect(LIVETV_FAILURE_POLICY.provider_auth_failed).toEqual({
            status: 502,
            retryable: false,
        });
        expect(LIVETV_FAILURE_POLICY.provider_connection_limit).toEqual({
            status: 503,
            retryable: true,
            retryAfterMs: 30_000,
        });
        expect(LIVETV_FAILURE_POLICY.provider_unreachable).toEqual({
            status: 504,
            retryable: true,
            retryAfterMs: 10_000,
        });
        expect(LIVETV_FAILURE_POLICY.geo_blocked).toEqual({ status: 502, retryable: false });
        expect(LIVETV_FAILURE_POLICY.no_video).toEqual({ status: 502, retryable: false });
        expect(LIVETV_FAILURE_POLICY.encoder_failed).toEqual({
            status: 500,
            retryable: true,
            retryAfterMs: 5_000,
        });
        expect(LIVETV_FAILURE_POLICY.all_feeds_failed.status).toBe(502);
        expect(LIVETV_FAILURE_POLICY.upstream_stalled).toEqual({
            status: 502,
            retryable: true,
            retryAfterMs: 3_000,
        });
    });

    test('immediate failover never covers a timeout-class reason', () => {
        expect(LIVETV_IMMEDIATE_FAILOVER_REASONS).not.toContain('provider_unreachable');
        expect(LIVETV_IMMEDIATE_FAILOVER_REASONS).not.toContain('upstream_stalled');
        expect(LIVETV_IMMEDIATE_FAILOVER_REASONS).not.toContain('encoder_failed');
    });
});

describe('failure event reason type', () => {
    test('mirrors the reason list exactly', () => {
        type Same = [LiveTvFailureEventReason] extends [LiveTvFailureReason]
            ? [LiveTvFailureReason] extends [LiveTvFailureEventReason]
                ? true
                : false
            : false;
        const same: Same = true;
        expect(same).toBe(true);
    });
});
