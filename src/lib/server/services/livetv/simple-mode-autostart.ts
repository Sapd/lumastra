// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Live TV simple mode, "open Live TV on start": the home page sends this
 * viewer to /livetv. Only when Live TV is on, the viewer may use it, simple
 * mode is on with autostart, and it has channels; never blocks the home page.
 */

import { features } from '$lib/server/config.js';
import { getDb } from '$lib/server/database/connection.js';
import { simpleModeAutostarts } from '$lib/server/database/queries/livetv-simple-mode.queries.js';

export async function opensLiveTvOnStart(
    user: { userId: string; hasLiveTvPermission?: boolean } | null | undefined,
): Promise<boolean> {
    if (!features.liveTV || !user?.hasLiveTvPermission) return false;
    const sql = getDb();
    if (!sql) return false;
    try {
        return await simpleModeAutostarts(sql, user.userId);
    } catch {
        return false;
    }
}
