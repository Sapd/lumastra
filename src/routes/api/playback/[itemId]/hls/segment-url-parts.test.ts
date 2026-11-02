// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The sub-playlist/segment params must carry every cap the master request was
 * started with. The muxed media-playlist follow-up (`hlsPlaylist=media`) and
 * client retries re-enter the route with these params; a missing cap there
 * computes a different job config and respawns FFmpeg (hasPlaybackConfigChanged).
 */

import { describe, it, expect } from 'vitest';
import { buildHlsSegmentUrlParts } from './segment-url-parts.js';
import {
    parseQualityCapParams,
    parseMaxAudioChannelsParam,
} from '$lib/server/services/transcoding/quality-cap.js';

const SESSION = 'session-1';

describe('buildHlsSegmentUrlParts', () => {
    it('round-trips the quality cap and channel cap through the route parsers', () => {
        const { segmentParams } = buildHlsSegmentUrlParts(
            '',
            'item-1',
            SESSION,
            {},
            null,
            undefined,
            { maxBitrate: 4_000_000, maxHeight: 720 },
            2,
        );

        expect(parseQualityCapParams(segmentParams)).toEqual({
            maxBitrate: 4_000_000,
            maxHeight: 720,
        });
        expect(parseMaxAudioChannelsParam(segmentParams)).toBe(2);
    });

    it('adds no cap params when the master request had none (comparison)', () => {
        const { segmentParams } = buildHlsSegmentUrlParts('', 'item-1', SESSION, {}, null);

        expect(parseQualityCapParams(segmentParams)).toEqual({});
        expect(parseMaxAudioChannelsParam(segmentParams)).toBeUndefined();
    });

    it('routes token auth through /api/v1 under the base path', () => {
        const { segmentBase, segmentParams } = buildHlsSegmentUrlParts(
            '/app',
            'item-1',
            SESSION,
            { authMethod: 'stream_token', accessToken: 'tok' },
            null,
        );

        expect(segmentBase).toBe('/app/api/v1/playback/item-1/hls');
        expect(segmentParams.get('grant')).toBe('tok');
    });
});

describe('account token isolation', () => {
    it.each(['bearer', 'pat', 'service_token'])('does not copy %s account secrets into media URLs', (authMethod) => {
        const { segmentParams } = buildHlsSegmentUrlParts('', 'item', SESSION, { authMethod, accessToken: 'account-secret' });
        expect(segmentParams.has('api_key')).toBe(false);
        expect(segmentParams.has('grant')).toBe(false);
    });
});
