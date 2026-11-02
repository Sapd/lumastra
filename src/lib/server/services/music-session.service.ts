// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import {
    getCurrentMusicSession,
    type MusicSessionRow,
} from '$lib/server/database/queries/play-sessions.queries.js';

/** Current music projection for the unified GET /play-sessions list. */
export async function getCurrentMusicPlaybackSession(
    sql: postgres.Sql,
    userId: UserId,
): Promise<MusicSessionRow | null> {
    return getCurrentMusicSession(sql, userId);
}
