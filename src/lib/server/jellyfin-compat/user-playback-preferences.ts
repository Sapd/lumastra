// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { getPlaybackPreferences } from '$lib/server/database/queries/user-preferences.queries';
import type { UserId } from '$lib/shared/user-id';
import { Logger } from '$lib/server/utils/logger';
import type { UserPlaybackPreferences } from './user-configuration';

const logger = Logger.for('JellyfinCompat:UserConfiguration');

/**
 * The user's playback preferences, or null (none saved, no database, or the
 * read failed — a login or `/Users/Me` must never fail over a preference).
 */
export async function loadUserPlaybackPreferences(
    userId: UserId | string,
    sql?: postgres.Sql | null,
): Promise<UserPlaybackPreferences | null> {
    try {
        // Loaded lazily: the login routes that call this hold no database
        // handle, and the pool module's import graph is large.
        const db = sql ?? (await import('$lib/server/database')).getDb();
        if (!db) return null;
        return await getPlaybackPreferences.one(db, { userId: userId as UserId });
    } catch (err) {
        logger.warn('Playback preferences unavailable for the Jellyfin user configuration', {
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}
