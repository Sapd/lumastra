// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Public API route for music audio streaming - accessible via Bearer token
//
// Mirrors /api/music/tracks/[id]/stream with two differences:
//   1. SessionContext.source is 'public-api' instead of 'api'
//   2. Auth context comes from token-based locals.user (PAT / JWT / stream
//      token), not Authentik forward-auth — but locals.user is the same
//      shape, so no special handling is needed here.
import { createMusicStreamHandlers } from '$lib/server/services/music-transcode/route-handler.js';

export const { GET, HEAD } = createMusicStreamHandlers({
    source: 'public-api',
    deviceId: (username) => `public-api-${username}`,
    loggerName: 'PublicApiMusicStream',
});
