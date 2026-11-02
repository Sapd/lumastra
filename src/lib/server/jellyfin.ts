// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin Client - Facade for Modular Services
 *
 * The monolithic jellyfin.ts (6,686 lines) has been refactored into focused service modules:
 *
 * Service Architecture:
 * - jellyfin/base-client.ts - Shared API instance and utilities
 * - jellyfin/media.service.ts - Items, genres, and legacy Live TV helpers
 * - jellyfin/watch-progress.service.ts - Continue watching, next up (13 methods)
 * - jellyfin/series.service.ts - Seasons, episodes, chapter info (7 methods)
 * - jellyfin/playback.service.ts - Playback info, reporting, sessions (14 methods)
 * - jellyfin/auth.service.ts - Quick Connect, token validation (6 methods)
 * - jellyfin/user.service.ts - User lookup, policies (2 methods)
 *
 * The old monolithic file has been preserved as jellyfin.ts.backup
 *
 * Usage Examples:
 *
 * // Import specific services
 * import { jellyfinMediaService, jellyfinPlaybackService } from '$lib/server/jellyfin';
 * const item = await jellyfinMediaService.getItemInfo('jellyfin-item-id');
 * const sessions = await jellyfinPlaybackService.getSessions();
 *
 * // Import types
 * import type { JellyfinItem, JellyfinSession } from '$lib/server/jellyfin';
 *
 * // Import utilities
 * import { buildJellyfinAuthHeaders } from '$lib/server/jellyfin';
 */

// Re-export everything from the modular services
export * from './jellyfin/index.js';
