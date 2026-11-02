// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Playlist-related type definitions
 *
 * Convention: All property names use camelCase.
 * Database columns (snake_case) are transformed at the server boundary.
 *
 * Types are re-exported from Zod schemas in '$lib/schemas/playlist-utils-types.ts'.
 */

export type {
    MemberProgress,
    ItemWatcher,
    PlaylistProgressResponse,
} from '$lib/schemas/playlist-utils-types';

export type { PlaylistAddItem, PlaylistAddOutcome } from './playlist-add';
