// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// GET /Audio/{itemId}/master.m3u8 — audio HLS master playlist (one AAC variant
// pointing at main.m3u8). See jellyfin-compat/audio-hls.ts.

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { handleAudioMasterPlaylist } from '$lib/server/proprietary/jellyfin-compat/audio-hls';

export const GET: RequestHandler = withJellyfinAuth((event) => handleAudioMasterPlaylist(event), {
    pat: 'deny',
});
