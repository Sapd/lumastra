// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin User Service
 * Handles user lookup and user policy retrieval
 */

import { joinUpstreamUrl } from '$lib/shared/upstream-url.js';
import { buildJellyfinAuthHeaders } from '$lib/server/jellyfin/auth-headers.js';
import { JellyfinBaseClient } from './base-client.js';
import type { UserDto } from '@jellyfin/sdk/lib/generated-client/models';
import { cacheManager, CACHE_NAMESPACES } from '../cache/index.js';
import { encodePathSegment } from '$lib/server/utils/upstream-path';
export class JellyfinUserService extends JellyfinBaseClient {
    constructor() {
        super('JellyfinUserService');
    }

    async getUsers(): Promise<UserDto[]> {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured');
            return [];
        }

        try {
            const response = await this.api!.axiosInstance.get<UserDto[]>(
                joinUpstreamUrl(this.api!.basePath, `/Users`),
                {
                    headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                },
            );
            return Array.isArray(response.data) ? response.data : [];
        } catch (error) {
            this.logger.error('Failed to get users', error as Error);
            return [];
        }
    }

    /**
     * Get user by username
     * Uses cache with 7-day TTL since user IDs rarely change
     *
     * @param username - Jellyfin username to lookup
     * @returns User object with Id and Name, or null if not found
     */
    async getUserByName(username: string): Promise<{ Id: string; Name: string } | null> {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured');
            return null;
        }

        const cacheKey = username.toLowerCase();

        // Type-safe cache - TTLs from centralized CACHE_NAMESPACES config
        // Long TTL (7 days L2) since user IDs rarely change
        const userCache = cacheManager.for(CACHE_NAMESPACES.jellyfinUsers);

        // Check cache first
        const cached = await userCache.get<{ Id: string; Name: string }>(cacheKey);
        if (cached) {
            return cached;
        }

        try {
            const response = await this.api!.axiosInstance.get<UserDto[]>(
                joinUpstreamUrl(this.api!.basePath, `/Users`),
                {
                    headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                },
            );
            const users = Array.isArray(response.data) ? response.data : [];
            const user = users.find(
                (u: UserDto) => u.Name?.toUpperCase() === username.toUpperCase(),
            );
            const result = user ? { Id: user.Id!, Name: user.Name! } : null;

            // Cache the result
            if (result) {
                await userCache.set(cacheKey, result);
            }

            return result;
        } catch (error) {
            this.logger.error('Failed to get user', error as Error);
            return null;
        }
    }

    /**
     * Get user details including their policy (permissions)
     * Used by OAuth to cache Jellyfin user permissions
     */
    async getUserWithPolicy(userId: string): Promise<{
        Id: string;
        Name: string;
        Policy?: {
            EnabledFolders?: string[] | null;
            MaxParentalRating?: number | null;
            EnableMediaPlayback?: boolean;
            EnableAudioPlaybackTranscoding?: boolean;
            EnableVideoPlaybackTranscoding?: boolean;
            EnablePlaybackRemuxing?: boolean;
            EnableContentDownloading?: boolean;
            EnableRemoteAccess?: boolean;
            RemoteClientBitrateLimit?: number | null;
        };
    } | null> {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured');
            return null;
        }

        try {
            const response = await this.api!.axiosInstance.get<UserDto>(
                joinUpstreamUrl(this.api!.basePath, `/Users/${encodePathSegment(userId)}`),
                {
                    headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                },
            );

            const user = response.data;
            if (!user || !user.Id) {
                return null;
            }

            return {
                Id: user.Id,
                Name: user.Name || '',
                Policy: user.Policy,
            };
        } catch (error) {
            this.logger.error('Failed to get user with policy', error as Error, {
                userId,
            });
            return null;
        }
    }
}

// Export singleton instance
export const jellyfinUserService = new JellyfinUserService();
