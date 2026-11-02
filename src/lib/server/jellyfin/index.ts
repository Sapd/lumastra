// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin Services - Modular API Client
 *
 * This module provides focused, single-responsibility services for interacting with Jellyfin.
 * Each service handles a specific domain (media, playback, user management, etc.)
 *
 * Refactored from a monolithic 6,686-line client into 8 focused services.
 */

// Export types
export type {
    JellyfinItem,
    JellyfinSession,
    SeasonEpisode,
    UserSession,
} from './types/jellyfin.types.js';

export { buildJellyfinAuthHeaders } from './auth-headers.js';
export type { JellyfinAuthOptions } from './auth-headers.js';

// Export base client and utilities
export { JellyfinBaseClient, clientName } from './base-client.js';

// Export individual services
export { JellyfinMediaService, jellyfinMediaService } from './media.service.js';

export {
    JellyfinWatchProgressService,
    jellyfinWatchProgressService,
} from './watch-progress.service.js';

export { JellyfinSeriesService, jellyfinSeriesService } from './series.service.js';

export { JellyfinPlaybackService, jellyfinPlaybackService } from './playback.service.js';

export { JellyfinAuthService, jellyfinAuthService } from './auth.service.js';

export { JellyfinUserService, jellyfinUserService } from './user.service.js';

export { getJellyfinFileInventory } from './file-inventory.js';
