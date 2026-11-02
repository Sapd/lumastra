// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { addAuthToSearchParams } from '$lib/server/utils/hls-request-utils.js';

/**
 * Segment base URL + shared query params for the HLS route's sub-playlist and
 * segment requests. Lives outside `+server.ts` (SvelteKit allows only handler
 * exports there) so the params that pin job identity are unit-testable.
 */

/**
 * Check if the authentication method uses token-based auth (for public API routing)
 */
function isTokenBasedAuth(authMethod: string | undefined): boolean {
    return (
        authMethod === 'bearer' ||
        authMethod === 'pat' ||
        authMethod === 'service_token' ||
        authMethod === 'stream_token'
    );
}

/**
 * Build the segment base URL and shared query params for HLS sub-playlist
 * and segment requests.  Both the lumastra and non-lumastra paths produce the
 * same URL structure — this avoids duplicating the token-auth routing and
 * auth-param injection.
 */
export function buildHlsSegmentUrlParts(
    basePath: string,
    itemId: string,
    sessionId: string,
    locals: { authMethod?: string; accessToken?: string },
    seekParam?: string | null,
    deviceProfileId?: string,
    qualityCap?: { maxBitrate?: number; maxHeight?: number },
    maxAudioChannels?: number,
): { segmentBase: string; segmentParams: URLSearchParams } {
    const isTokenAuth = isTokenBasedAuth(locals.authMethod);
    const segmentBase = isTokenAuth
        ? `${basePath}/api/v1/playback/${itemId}/hls`
        : `${basePath}/api/playback/${itemId}/hls`;

    const segmentParams = new URLSearchParams();
    segmentParams.set('PlaySessionId', sessionId);

    if (locals.authMethod === 'stream_token' && locals.accessToken) {
        addAuthToSearchParams(segmentParams, { grant: locals.accessToken });
    }

    if (seekParam) {
        segmentParams.set('seek', seekParam);
    }

    if (deviceProfileId) {
        segmentParams.set('deviceProfile', deviceProfileId);
    }

    // Carry the quality cap on sub-playlist/segment URLs so a re-fetch of the
    // master (e.g. the muxed media-playlist round-trip via hlsPlaylist=media,
    // or a client retry) resolves to the SAME job identity — see
    // hasPlaybackConfigChanged's qualityCap comparison.
    if (qualityCap?.maxBitrate) {
        segmentParams.set('maxBitrate', String(qualityCap.maxBitrate));
    }
    if (qualityCap?.maxHeight) {
        segmentParams.set('maxHeight', String(qualityCap.maxHeight));
    }
    if (maxAudioChannels) {
        segmentParams.set('maxAudioChannels', String(maxAudioChannels));
    }

    return { segmentBase, segmentParams };
}
