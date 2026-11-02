// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createMusicStreamHandlers } from '$lib/server/services/music-transcode/route-handler.js';

export const { GET, HEAD } = createMusicStreamHandlers({
    source: 'api',
    deviceId: (username) => `web-api-${username}`,
    loggerName: 'ApiMusicStream',
});
