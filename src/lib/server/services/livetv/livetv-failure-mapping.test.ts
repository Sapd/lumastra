// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    failureFacts,
    legacyCodeForReason,
    reasonForLegacyProxyError,
    translateFeedsTried,
} from './livetv-failure-mapping.js';

const feeds = [
    { id: 'feed-0', name: 'Primary' },
    { id: 'feed-1', name: 'Backup' },
];

describe('translateFeedsTried', () => {
    it('maps proxy indexes to feed ids and names', () => {
        expect(
            translateFeedsTried(
                [
                    { index: 0, reason: 'provider_auth_failed', upstreamStatus: 401 },
                    { index: 1, reason: 'channel_offline' },
                ],
                feeds,
            ),
        ).toEqual([
            {
                feedId: 'feed-0',
                feedName: 'Primary',
                reason: 'provider_auth_failed',
                upstreamStatus: 401,
            },
            { feedId: 'feed-1', feedName: 'Backup', reason: 'channel_offline' },
        ]);
    });

    it('never echoes a proxy-supplied feedId and drops entries that map to no feed', () => {
        expect(
            translateFeedsTried(
                [
                    { index: 7, feedId: 'feed-x', reason: 'geo_blocked' },
                    { index: -1, feedId: 'feed-y', reason: 'geo_blocked' },
                    { index: 1.5, reason: 'geo_blocked' },
                    // @ts-expect-error not a taxonomy reason
                    { index: 0, reason: 'something_else' },
                    { index: 1, feedId: 'feed-z', reason: 'no_video' },
                ],
                feeds,
            ),
        ).toEqual([{ feedId: 'feed-1', feedName: 'Backup', reason: 'no_video' }]);
    });

    it('drops everything when the app has no feed list', () => {
        expect(translateFeedsTried([{ index: 0, reason: 'geo_blocked' }], [])).toEqual([]);
    });

    it('handles a missing list', () => {
        expect(translateFeedsTried(undefined, feeds)).toEqual([]);
    });
});

describe('failureFacts', () => {
    it('uses the proxy values when present', () => {
        expect(
            failureFacts('all_feeds_failed', { retryable: true, retryAfterMs: 10_000 }, []),
        ).toMatchObject({ retryable: true, retryAfterMs: 10_000 });
    });
    it('falls back to the policy', () => {
        expect(failureFacts('provider_connection_limit', {}, [])).toMatchObject({
            retryable: true,
            retryAfterMs: 30_000,
        });
        const offline = failureFacts('channel_offline', {}, []);
        expect(offline.retryable).toBe(false);
        expect(offline.retryAfterMs).toBeUndefined();
    });
});

describe('legacy proxy errors', () => {
    it.each([
        ['spawn_failed', 'encoder_failed'],
        ['source_unreachable', 'provider_unreachable'],
    ] as const)('%s -> %s', (error, reason) => {
        expect(reasonForLegacyProxyError(error)).toBe(reason);
    });
    it.each(['channel_not_found', 'no_segments'])('does not read %s as offline', (error) => {
        expect(reasonForLegacyProxyError(error)).toBeUndefined();
    });
    it('leaves internal_error alone', () => {
        expect(reasonForLegacyProxyError('internal_error')).toBeUndefined();
    });
    it('keeps a flat code for the Jellyfin-compat routes', () => {
        expect(legacyCodeForReason('encoder_failed')).toBe('spawn_failed');
        expect(legacyCodeForReason('provider_unreachable')).toBe('source_unreachable');
        expect(legacyCodeForReason('geo_blocked')).toBe('no_segments');
    });
});
