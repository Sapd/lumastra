// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * User Pinned Genres Query Module
 *
 * CRUD operations for per-user pinned genre carousels on /music.
 * Follows the user_excluded_series pattern.
 */

import { defineQuery, defineWriteQuery, defineExistsQuery } from '../typed-query.js';
import type { UserId } from '$lib/shared/user-id';

// =============================================================================
// Types
// =============================================================================

export interface PinnedGenreRow {
    id: number;
    user_id: string;
    genre: string;
    position: number;
    pinned_at: Date;
}

// =============================================================================
// Read Queries
// =============================================================================

/**
 * Get all pinned genres for a user, ordered by position.
 */
export const getPinnedGenres = defineQuery<{ userId: UserId }, PinnedGenreRow>(
    'getPinnedGenres',
    (sql, { userId }) => sql`
        SELECT id, user_id, genre, position, pinned_at
        FROM user_pinned_genres
        WHERE user_id = ${userId}
        ORDER BY position ASC, pinned_at ASC
    `,
);

/**
 * Get just the genre names for a user (lightweight).
 */
export const getPinnedGenreNames = defineQuery<{ userId: UserId }, { genre: string }>(
    'getPinnedGenreNames',
    (sql, { userId }) => sql`
        SELECT genre
        FROM user_pinned_genres
        WHERE user_id = ${userId}
        ORDER BY position ASC, pinned_at ASC
    `,
);

/**
 * Check if a genre is pinned for a user.
 */
export const isGenrePinned = defineExistsQuery<{
    userId: UserId;
    genre: string;
}>(
    'isGenrePinned',
    (sql, { userId, genre }) => sql`
        SELECT 1
        FROM user_pinned_genres
        WHERE user_id = ${userId}
          AND genre = ${genre}
        LIMIT 1
    `,
);

// =============================================================================
// Write Queries
// =============================================================================

/**
 * Pin a genre. Position defaults to max+1 (append to end).
 */
export const pinGenre = defineWriteQuery<{ userId: UserId; genre: string }, PinnedGenreRow>(
    'pinGenre',
    (sql, { userId, genre }) => sql`
        INSERT INTO user_pinned_genres (user_id, genre, position)
        VALUES (
            ${userId},
            ${genre},
            COALESCE(
                (SELECT MAX(position) + 1 FROM user_pinned_genres WHERE user_id = ${userId}),
                0
            )
        )
        ON CONFLICT (user_id, genre) DO UPDATE SET
            pinned_at = NOW()
        RETURNING id, user_id, genre, position, pinned_at
    `,
);

/**
 * Unpin a genre.
 */
export const unpinGenre = defineWriteQuery<{ userId: UserId; genre: string }, { id: number }>(
    'unpinGenre',
    (sql, { userId, genre }) => sql`
        DELETE FROM user_pinned_genres
        WHERE user_id = ${userId}
          AND genre = ${genre}
        RETURNING id
    `,
);
