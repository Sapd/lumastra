// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Jellyfin Permissions Service
// Queries Jellyfin for user permissions and caches them in our database
// We enforce permissions ourselves for defense in depth

import { Database } from '../database/connection.js';
import type postgres from 'postgres';
import { jellyfinUserService } from '../jellyfin';
import { Logger } from '../utils/logger';
import {
    getCachedPermissions as getCachedPermissionsQuery,
    upsertPermissions,
    deletePermissions,
    getStalePermissionUsers,
} from '../database/queries/library-permissions.queries.js';
import { getUserIdByUsername } from '../database/queries/users.queries.js';

const logger = Logger.for('OAuth:JellyfinPermissions');

export interface JellyfinUserPermissions {
    username: string;
    jellyfinUserId: string;
    enabledLibraries: string[]; // Library IDs user can access (empty = all)
    maxParentalRating: number | null; // Max content rating (null = no limit)
    enableMediaPlayback: boolean;
    enableAudioTranscoding: boolean;
    enableVideoTranscoding: boolean;
    enableRemuxing: boolean;
    enableContentDownloading: boolean;
    enableRemoteAccess: boolean;
    remoteClientBitrateLimit: number | null;
    updatedAt: Date;
}

export interface PermissionCheckResult {
    allowed: boolean;
    reason?: string;
}

export class JellyfinPermissionsService {
    private readonly db: Database;
    private readonly sql: postgres.Sql;

    constructor() {
        this.db = new Database();
        this.sql = this.db.getSql();
    }

    /**
     * Fetch permissions from Jellyfin and cache them
     */
    async fetchAndCachePermissions(username: string): Promise<JellyfinUserPermissions | null> {
        try {
            // Get user from Jellyfin using getUserByName
            const jellyfinUser = await jellyfinUserService.getUserByName(username);

            if (!jellyfinUser?.Id) {
                logger.warn('User not found in Jellyfin', { username });
                return null;
            }

            // Get full user details with policy using direct API call
            const userDetails = await jellyfinUserService.getUserWithPolicy(jellyfinUser.Id);

            if (!userDetails?.Policy) {
                logger.warn('No policy found for Jellyfin user', {
                    username,
                    jellyfinUserId: jellyfinUser.Id,
                });
                // Return basic permissions without policy details
                const basicPermissions: JellyfinUserPermissions = {
                    username,
                    jellyfinUserId: jellyfinUser.Id,
                    enabledLibraries: [],
                    maxParentalRating: null,
                    enableMediaPlayback: true,
                    enableAudioTranscoding: true,
                    enableVideoTranscoding: true,
                    enableRemuxing: true,
                    enableContentDownloading: false,
                    enableRemoteAccess: true,
                    remoteClientBitrateLimit: null,
                    updatedAt: new Date(),
                };
                await this.cachePermissions(basicPermissions);
                return basicPermissions;
            }

            const policy = userDetails.Policy;

            // Extract permissions from policy
            const permissions: JellyfinUserPermissions = {
                username,
                jellyfinUserId: jellyfinUser.Id,
                enabledLibraries: policy.EnabledFolders || [],
                maxParentalRating: policy.MaxParentalRating ?? null,
                enableMediaPlayback: policy.EnableMediaPlayback ?? true,
                enableAudioTranscoding: policy.EnableAudioPlaybackTranscoding ?? true,
                enableVideoTranscoding: policy.EnableVideoPlaybackTranscoding ?? true,
                enableRemuxing: policy.EnablePlaybackRemuxing ?? true,
                enableContentDownloading: policy.EnableContentDownloading ?? false,
                enableRemoteAccess: policy.EnableRemoteAccess ?? true,
                remoteClientBitrateLimit: policy.RemoteClientBitrateLimit ?? null,
                updatedAt: new Date(),
            };

            // Cache in database
            await this.cachePermissions(permissions);

            logger.debug('Cached Jellyfin permissions', {
                username,
                jellyfinUserId: jellyfinUser.Id,
            });

            return permissions;
        } catch (error) {
            logger.error(
                'Failed to fetch Jellyfin permissions',
                error instanceof Error ? error : undefined,
            );
            return null;
        }
    }

    /**
     * Cache permissions in the database
     */
    private async cachePermissions(permissions: JellyfinUserPermissions): Promise<void> {
        // user_library_permissions.user_id is the stable users.id UUID (mig 16.46.0);
        // resolve the Lumastra username before writing. No user row ⇒ nothing to cache.
        const userId = await getUserIdByUsername(this.sql, permissions.username);
        if (!userId) {
            logger.warn('Cannot cache permissions: no local user for username', {
                username: permissions.username,
            });
            return;
        }
        await upsertPermissions(this.sql, {
            userId,
            jellyfinUserId: permissions.jellyfinUserId,
            enabledLibraries: permissions.enabledLibraries,
            maxParentalRating: permissions.maxParentalRating,
            enableMediaPlayback: permissions.enableMediaPlayback,
            enableAudioTranscoding: permissions.enableAudioTranscoding,
            enableVideoTranscoding: permissions.enableVideoTranscoding,
            enableRemuxing: permissions.enableRemuxing,
            enableContentDownloading: permissions.enableContentDownloading,
            enableRemoteAccess: permissions.enableRemoteAccess,
            remoteClientBitrateLimit: permissions.remoteClientBitrateLimit,
        });
    }

    /**
     * Get cached permissions from database
     */
    async getCachedPermissions(username: string): Promise<JellyfinUserPermissions | null> {
        const userId = await getUserIdByUsername(this.sql, username);
        if (!userId) return null;
        return (await getCachedPermissionsQuery(
            this.sql,
            userId,
        )) as JellyfinUserPermissions | null;
    }

    /**
     * Get permissions (cached or fetch fresh)
     * @param maxAgeSeconds - Max age of cached permissions in seconds (default: 1 hour)
     */
    async getPermissions(
        username: string,
        maxAgeSeconds: number = 3600,
    ): Promise<JellyfinUserPermissions | null> {
        const cached = await this.getCachedPermissions(username);

        if (cached) {
            const age = (Date.now() - cached.updatedAt.getTime()) / 1000;
            if (age < maxAgeSeconds) {
                return cached;
            }
        }

        // Fetch fresh permissions
        return this.fetchAndCachePermissions(username);
    }

    /**
     * Check if user has permission for a specific action
     */
    async checkPermission(
        username: string,
        action: 'view' | 'play' | 'download' | 'transcode_audio' | 'transcode_video' | 'remux',
        context?: { libraryId?: string; itemId?: string },
    ): Promise<PermissionCheckResult> {
        const perms = await this.getPermissions(username);

        if (!perms) {
            return { allowed: false, reason: 'Permissions not available' };
        }

        // Check remote access
        if (!perms.enableRemoteAccess) {
            return { allowed: false, reason: 'Remote access disabled' };
        }

        // Check library access
        if (context?.libraryId && perms.enabledLibraries.length > 0) {
            if (!perms.enabledLibraries.includes(context.libraryId)) {
                return { allowed: false, reason: 'Library access denied' };
            }
        }

        // Check action-specific permissions
        switch (action) {
            case 'play':
                if (!perms.enableMediaPlayback) {
                    return { allowed: false, reason: 'Playback disabled' };
                }
                break;

            case 'download':
                if (!perms.enableContentDownloading) {
                    return { allowed: false, reason: 'Downloads disabled' };
                }
                break;

            case 'transcode_audio':
                if (!perms.enableAudioTranscoding) {
                    return {
                        allowed: false,
                        reason: 'Audio transcoding disabled',
                    };
                }
                break;

            case 'transcode_video':
                if (!perms.enableVideoTranscoding) {
                    return {
                        allowed: false,
                        reason: 'Video transcoding disabled',
                    };
                }
                break;

            case 'remux':
                if (!perms.enableRemuxing) {
                    return { allowed: false, reason: 'Remuxing disabled' };
                }
                break;
        }

        return { allowed: true };
    }

    /**
     * Get the user's bitrate limit (if any)
     */
    async getBitrateLimit(username: string): Promise<number | null> {
        const perms = await this.getPermissions(username);
        return perms?.remoteClientBitrateLimit ?? null;
    }

    /**
     * Invalidate cached permissions for a user
     */
    async invalidateCache(username: string): Promise<void> {
        const userId = await getUserIdByUsername(this.sql, username);
        if (!userId) return;
        await deletePermissions(this.sql, userId);
        logger.debug('Invalidated cached permissions', { username });
    }

    /**
     * Refresh permissions for all users (useful for periodic sync)
     */
    async refreshAllPermissions(maxAgeHours: number = 24): Promise<number> {
        // Get all users with stale permissions
        const staleUsernames = await getStalePermissionUsers(this.sql, maxAgeHours);

        let refreshed = 0;
        for (const username of staleUsernames) {
            const result = await this.fetchAndCachePermissions(username);
            if (result) {
                refreshed++;
            }
        }

        if (refreshed > 0) {
            logger.info('Refreshed stale permissions', {
                refreshed,
                total: staleUsernames.length,
            });
        }

        return refreshed;
    }
}

// Singleton instance
let instance: JellyfinPermissionsService | null = null;

export function getJellyfinPermissionsService(): JellyfinPermissionsService {
    if (!instance) {
        instance = new JellyfinPermissionsService();
    }
    return instance;
}
