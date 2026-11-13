// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /Audio/{itemId}/main.m3u8 — audio HLS media playlist; starts the audio-only
// transcode. See jellyfin-compat/audio-hls.ts.

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { handleAudioMediaPlaylist } from '$lib/server/proprietary/jellyfin-compat/audio-hls';

export const GET: RequestHandler = withJellyfinAuth((event) => handleAudioMediaPlaylist(event), {
    pat: 'deny',
});
