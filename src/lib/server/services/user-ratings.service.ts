// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * UserRatingsService
 *
 * Handles user rating operations.
 * Callers are responsible for resolving external IDs to UUIDs before calling
 * addUserRating(). Use resolveOrCreateMediaId() from media-resolution.ts.
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import type { UserRating, UserRatingWithUuid } from '../database/connection.js';
import {
    upsertUserRating,
    getUserRatings as getUserRatingsQuery,
} from '../database/queries/user-ratings.queries.js';
import { getPrimaryExternalIdProvider } from '../utils/provider-config.js';

/** Service class for user rating operations. */
export class UserRatingsService {
    private sql: postgres.Sql;

    constructor(sql: postgres.Sql) {
        this.sql = sql;
    }

    /**
     * Add or update a user rating.
     * The caller must resolve external IDs to a UUID first using resolveOrCreateMediaId().
     *
     * `wasNewRating` distinguishes a genuinely new rating (fresh INSERT) from a
     * conflict-update of an existing one (re-rating) — milestone logic must only
     * count the former.
     */
    async addUserRating(rating: {
        user_id: UserId;
        media_id: string;
        media_type: 'movie' | 'tv';
        rating: number;
        suggestion_context?: string;
        skipped?: boolean;
        /** How the rating was entered — 'quick' | 'stars'. Stored as-is (null when absent). */
        rating_style?: 'quick' | 'stars';
    }): Promise<UserRating & { wasNewRating: boolean }> {
        const skipped = rating.skipped ?? false;

        const row = await upsertUserRating.one(this.sql, {
            userId: rating.user_id,
            mediaId: rating.media_id,
            rating: rating.rating,
            suggestionContext: rating.suggestion_context || null,
            skipped,
            ratingStyle: rating.rating_style ?? null,
        });

        if (!row) {
            throw new Error('Failed to upsert user rating');
        }

        return {
            id: row.id,
            user_id: row.user_id,
            media_id: rating.media_id,
            media_type: rating.media_type,
            rating: row.rating,
            suggestion_context: row.suggestion_context || undefined,
            skipped: row.skipped || undefined,
            created_at: row.created_at,
            wasNewRating: row.inserted,
        };
    }

    /** Get user ratings (most recent first). */
    async getUserRatings(
        userId: UserId,
        limit = 100,
        includeSkipped = false,
    ): Promise<UserRating[]> {
        const results = await getUserRatingsQuery.all(this.sql, {
            userId,
            limit,
            includeSkipped,
        });

        return results.map((r) => ({
            id: r.id,
            user_id: r.user_id,
            media_id: r.media_id,
            primary_ext_id: r.primary_ext_id ?? undefined,
            primary_provider: getPrimaryExternalIdProvider(),
            media_type: r.media_type,
            rating: r.rating,
            suggestion_context: r.suggestion_context || undefined,
            skipped: r.skipped,
            created_at: r.created_at,
        }));
    }

    /**
     * @deprecated UserRating now includes media_id — use getUserRatings() directly.
     */
    async getUserRatingsWithUuid(
        userId: UserId,
        limit = 100,
        includeSkipped = false,
    ): Promise<UserRatingWithUuid[]> {
        return this.getUserRatings(userId, limit, includeSkipped);
    }
}
