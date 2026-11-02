// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin Playback Service
 *
 * Lumastra serves all video itself; the only outbound playback-shaped call we
 * still need is enumerating active Jellyfin sessions for the admin/home
 * sessions display (users streaming via direct Jellyfin clients outside
 * Lumastra). All HLS stream-URL builders, playback reporting, session
 * registration, and PlaybackInfo helpers were removed when the hybrid mode
 * was retired.
 */

import { joinUpstreamUrl } from '$lib/shared/upstream-url.js';
import { buildJellyfinAuthHeaders } from '$lib/server/jellyfin/auth-headers.js';
import { JellyfinBaseClient } from './base-client.js';
import type { JellyfinSession } from './types/jellyfin.types.js';

export class JellyfinPlaybackService extends JellyfinBaseClient {
    constructor() {
        super('Jellyfin:Playback');
    }

    async getSessions(): Promise<JellyfinSession[]> {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured');
            return [];
        }
        try {
            const response = await this.api!.axiosInstance.get<JellyfinSession[]>(
                joinUpstreamUrl(this.api!.basePath, `/Sessions`),
                {
                    params: {
                        activeWithinSeconds: 3600,
                    },
                    headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                },
            );

            const sessions = response.data ?? [];
            // Filter out sessions without a valid username — these are stale/invalid sessions
            return sessions.filter((session) => session.UserName);
        } catch (error) {
            this.logger.error('Failed to get Jellyfin sessions', error as Error);
            return [];
        }
    }
}

export const jellyfinPlaybackService = new JellyfinPlaybackService();
