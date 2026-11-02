// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Playlist Utils Types - Zod Schemas
 *
 * Re-exports from playlists.ts (single source of truth).
 * Provides backward-compatible PascalCase aliases.
 *
 * Convention:
 * - All property names use camelCase
 * - Database columns (snake_case) are transformed at the server boundary
 * - Use .optional() for optional fields (NOT .nullable())
 * - Add .meta({ description: '...' }) for OpenAPI docs
 * - Export both schema and inferred type
 */

// Re-export from playlists.ts (single source of truth)
// Backward-compatible PascalCase aliases
export {
    memberProgressSchema as MemberProgressSchema,
    itemWatcherSchema as ItemWatcherSchema,
    playlistProgressResponseSchema as PlaylistProgressResponseSchema,
} from './playlists';

// Re-export types for backward compatibility
export type { MemberProgress, ItemWatcher, PlaylistProgressResponse } from './playlists';
