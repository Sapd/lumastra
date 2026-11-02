// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import type { JellyfinMediaSourceInfo } from '$lib/server/proprietary/jellyfin-compat/types';

/** Metadata is safe to return before opening a provider or minting a play token. */
export function liveTvMetadataSource(channelId: string): JellyfinMediaSourceInfo {
    return {
        Id: channelId,
        Container: 'mpegts',
        Protocol: 'Http',
        Type: 'Default',
        IsLiveTv: true,
        IsRemote: false,
        ReadAtNativeFramerate: false,
        IgnoreDts: false,
        IgnoreIndex: false,
        GenPtsInput: false,
        IsInfiniteStream: true,
        RequiresOpening: false,
        RequiresClosing: false,
        RequiresLooping: false,
        SupportsProbing: false,
        HasSegments: false,
        SupportsDirectPlay: false,
        SupportsDirectStream: false,
        SupportsTranscoding: true,
        TranscodingContainer: 'ts',
        TranscodingSubProtocol: 'hls',
        MediaStreams: [],
    };
}

/**
 * The MediaSourceInfo of a Live TV channel: an infinite stream played through
 * the live HLS route (`/Videos/{channelId}/live.m3u8`), authenticated by the
 * play token in its URL. Same shape PlaybackInfo hands out for a channel, so a
 * client that tunes via POST /LiveStreams/Open plays exactly what PlaybackInfo
 * would have given it.
 *
 * `liveStreamId` becomes LiveStreamId: the handle the client passes back to
 * POST /LiveStreams/Close.
 */
export function liveTvMediaSource(
    channelId: string,
    streamToken: string,
    liveStreamId?: string,
): JellyfinMediaSourceInfo {
    return {
        ...liveTvMetadataSource(channelId),
        TranscodingUrl: `/Videos/${channelId}/live.m3u8?api_key=${streamToken}`,
        ...(liveStreamId ? { LiveStreamId: liveStreamId } : {}),
    };
}
