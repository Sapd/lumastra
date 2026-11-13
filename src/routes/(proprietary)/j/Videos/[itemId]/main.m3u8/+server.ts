// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /Videos/{itemId}/main.m3u8 — Jellyfin's `GetVariantHlsVideoPlaylist`:
 * the media (variant) playlist, without a master around it.
 *
 * The /j master.m3u8 already answers a MUXED transcode with its media playlist
 * (one rendition, segments under /j/Videos/{itemId}/hls/), so this is that
 * route with the muxed mode pinned: a client asking for main.m3u8 must get
 * segments, never a master, whatever `hlsAudioMode` it sends. Same pipeline,
 * same access check, kick cooldown, stream limit and silent-start disarm.
 *
 * Differences from Jellyfin, on purpose: segment URIs are our
 * `hls/segment_NNNNN.ts` paths rather than `hls1/{playlistId}/{N}.ts` (the
 * hls1 form is served too, as an alias — see hls1/[playlistId]/[segment]).
 */

import type { RequestHandler } from './$types';
import { GET as masterGet } from '../master.m3u8/+server';

export const GET: RequestHandler = async (event) => {
    for (const key of [...event.url.searchParams.keys()]) {
        if (key.toLowerCase() === 'hlsaudiomode') event.url.searchParams.delete(key);
    }
    event.url.searchParams.set('hlsAudioMode', 'muxed');
    return masterGet(event as unknown as Parameters<typeof masterGet>[0]);
};
