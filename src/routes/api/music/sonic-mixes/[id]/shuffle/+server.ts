// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET/HEAD /api/music/sonic-mixes/{id}/shuffle — one track of a seeded
// cluster shuffle as a fixed-format MP3 (see cluster-shuffle-route.ts).
import { createMusicStreamHandlers } from '$lib/server/services/music-transcode/route-handler.js';
import { createClusterShuffleHandlers } from '$lib/server/services/music/cluster-shuffle-route.js';

export const { GET, HEAD } = createClusterShuffleHandlers(
    createMusicStreamHandlers({
        source: 'api',
        deviceId: (username) => `web-api-${username}`,
        loggerName: 'ApiClusterShuffle',
    }),
);
