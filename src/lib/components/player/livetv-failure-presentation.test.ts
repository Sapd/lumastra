// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import * as m from '$lib/paraglide/messages.js';
import {
    liveTvBlockPresentation,
    liveTvBlockCauseForKill,
    liveTvBlockCauseForPolicy,
    liveTvFailurePresentation,
    liveTvFailureReasonLabel,
    type LiveTvFailureViewCode,
} from './livetv-failure-presentation.js';
import { LIVETV_FAILURE_REASONS } from '$lib/api/livetv-failure-problem.js';

/**
 * Regression: every terminal Live TV stop rendered the priority-eviction copy
 * ("stopped to allow a higher-priority user to watch"), including a plain
 * stream-limit refusal that no other viewer was involved in. A viewer zapping
 * channels while their own second slot was busy was told someone had taken
 * their stream.
 */
describe('Live TV block presentation', () => {
    it('claims a higher-priority viewer ONLY for an actual priority eviction', () => {
        expect(liveTvBlockPresentation({ kind: 'priority' }).message).toBe(
            m.livetv_stream_kicked_message(),
        );

        const others = [
            liveTvBlockPresentation({ kind: 'stream_limit_blocked' }),
            liveTvBlockPresentation({ kind: 'stream_limit_kill' }),
            liveTvBlockPresentation({ kind: 'policy', message: 'Stream not allowed: ip' }),
            liveTvBlockPresentation({ kind: 'session_ended' }),
        ];
        for (const presentation of others) {
            expect(presentation.message).not.toBe(m.livetv_stream_kicked_message());
            expect(presentation.message.length).toBeGreaterThan(0);
            expect(presentation.title.length).toBeGreaterThan(0);
        }
    });

    it('tells a refused viewer that their own concurrent streams are the cause', () => {
        const presentation = liveTvBlockPresentation({ kind: 'stream_limit_blocked' });
        expect(presentation.title).toBe(m.livetv_stream_blocked_title());
        expect(presentation.message).toBe(m.livetv_stream_limit_blocked_message());
    });

    it('names a one-slot provider in the singular, never "1 streams"', () => {
        expect(liveTvBlockPresentation({ kind: 'source_capacity', limit: 1 }).message).toBe(
            m.livetv_stream_limit_subtitle_one(),
        );
        expect(liveTvBlockPresentation({ kind: 'source_capacity', limit: 3 }).message).toBe(
            m.livetv_stream_limit_subtitle({ limit: '3' }),
        );
    });

    it('passes a non-limit policy block through with the server-derived reason', () => {
        expect(
            liveTvBlockPresentation({ kind: 'policy', message: 'Stream not allowed: ip' }).message,
        ).toBe('Stream not allowed: ip');
    });

    it('maps reporter kinds to causes', () => {
        expect(liveTvBlockCauseForPolicy('stream_limit', 'ignored')).toEqual({
            kind: 'stream_limit_blocked',
        });
        expect(liveTvBlockCauseForPolicy('ip_restriction', 'Blocked: ip')).toEqual({
            kind: 'policy',
            message: 'Blocked: ip',
        });
        expect(liveTvBlockCauseForKill('stream_limit')).toEqual({ kind: 'stream_limit_kill' });
        expect(liveTvBlockCauseForKill('admin')).toEqual({ kind: 'session_ended' });
    });
});

describe('Live TV typed failure presentation', () => {
    const codes: LiveTvFailureViewCode[] = [
        ...LIVETV_FAILURE_REASONS,
        'dependency_unavailable',
        'unknown',
    ];
    const anotherChannel = [
        'channel_offline',
        'no_video',
        'geo_blocked',
        'provider_auth_failed',
        'all_feeds_failed',
    ];

    it.each(codes)('%s has non-empty copy in both variants, distinct per variant', (code) => {
        for (const isAdmin of [false, true]) {
            const normal = liveTvFailurePresentation(code, { simple: false, isAdmin });
            const simple = liveTvFailurePresentation(code, { simple: true, isAdmin });
            expect(normal.title.length).toBeGreaterThan(0);
            expect(normal.message.length).toBeGreaterThan(0);
            expect(simple.message.length).toBeGreaterThan(0);
            expect(simple.title).toBe(m.livetv_failure_title_simple());
            expect(simple.message).not.toBe(normal.message);
        }
    });

    it.each(codes)('%s: simple copy avoids provider, stream and encoder talk', (code) => {
        const { title, message } = liveTvFailurePresentation(code, { simple: true, isAdmin: true });
        expect(`${title} ${message}`).not.toMatch(/provider|stream|encoder|feed|source/i);
    });

    it('uses the wording the design names for the main cases', () => {
        const normal = (code: LiveTvFailureViewCode) =>
            liveTvFailurePresentation(code, { simple: false, isAdmin: false }).message;
        expect(normal('channel_offline')).toBe("This channel isn't broadcasting right now.");
        expect(normal('provider_auth_failed')).toContain('administrator');
        expect(normal('provider_connection_limit')).toContain('no more streams');
    });

    it.each(anotherChannel)('%s offers another channel and back', (code) => {
        const presentation = liveTvFailurePresentation(code as LiveTvFailureViewCode, {
            simple: false,
            isAdmin: false,
            retryable: false,
        });
        expect(presentation.actions).toEqual(['another_channel', 'back']);
        expect(presentation.autoRetry).toBe(false);
    });

    it('a retryable all_feeds_failed offers retry, another channel and back', () => {
        const presentation = liveTvFailurePresentation('all_feeds_failed', {
            simple: false,
            isAdmin: false,
            retryable: true,
        });
        expect(presentation.actions).toEqual(['retry', 'another_channel', 'back']);
        expect(presentation.autoRetry).toBe(true);
    });

    it.each([
        'provider_connection_limit',
        'provider_unreachable',
        'encoder_failed',
        'upstream_stalled',
        'dependency_unavailable',
    ])('%s retries on its own and offers no other channel', (code) => {
        const presentation = liveTvFailurePresentation(code as LiveTvFailureViewCode, {
            simple: false,
            isAdmin: false,
            retryable: true,
        });
        expect(presentation.autoRetry).toBe(true);
        expect(presentation.actions).toEqual(['retry', 'back']);
    });

    it('unknown always offers a manual retry but never retries on its own', () => {
        const presentation = liveTvFailurePresentation('unknown', {
            simple: false,
            isAdmin: false,
        });
        expect(presentation.actions).toEqual(['retry', 'back']);
        expect(presentation.autoRetry).toBe(false);
    });

    it('lists the feeds tried for admins only, never in simple mode', () => {
        const feedsTried = [
            { feedId: 'a', feedName: 'Main', reason: 'provider_unreachable' as const },
            { feedId: 'b', reason: 'channel_offline' as const, upstreamStatus: 404 },
        ];
        const admin = liveTvFailurePresentation('all_feeds_failed', {
            simple: false,
            isAdmin: true,
            feedsTried,
        });
        expect(admin.feeds).toEqual([
            { name: 'Main', reason: liveTvFailureReasonLabel('provider_unreachable') },
            {
                name: m.livetv_failure_feed_unnamed({ number: '2' }),
                reason: liveTvFailureReasonLabel('channel_offline'),
            },
        ]);
        expect(
            liveTvFailurePresentation('all_feeds_failed', {
                simple: false,
                isAdmin: false,
                feedsTried,
            }).feeds,
        ).toEqual([]);
        expect(
            liveTvFailurePresentation('all_feeds_failed', {
                simple: true,
                isAdmin: true,
                feedsTried,
            }).feeds,
        ).toEqual([]);
    });

    it.each(LIVETV_FAILURE_REASONS)('%s has a feed label', (reason) => {
        expect(liveTvFailureReasonLabel(reason).length).toBeGreaterThan(0);
    });
});
