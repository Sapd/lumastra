// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { Locale } from '$lib/paraglide/runtime.js';
import * as m from '$lib/paraglide/messages.js';
import type { ApiSurface } from '$lib/shared/api-urls.js';
import { audiobookPreviewsForAdmittedIds } from '$lib/server/database/queries/audiobook-catalog.queries.js';
import { getDb } from '$lib/server/database/connection.js';
import { features } from '$lib/server/config.js';
import { restrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import {
    getAudiobookActivityRail,
    getViewerAudiobookListeningMs,
} from '$lib/server/database/queries/social-audiobook-activity.queries.js';
import type { AudiobookActivitySection } from '$lib/schemas/api-feed-responses.js';
import { userImageSets } from '$lib/server/services/image-descriptor/avatars.js';
import { buildPublicAuthor } from '$lib/shared/public-author';
import { getUserDisplayInfoByIds } from '$lib/server/database/queries/users.queries';
import type { AccessContext } from './recommender.js';

/**
 * How much of their own listening a viewer needs before this rail earns a slot
 * on a general feed. Ten minutes over a month is a low bar on purpose: it
 * separates "listens to audiobooks" from "has never opened one", which is the
 * only distinction being drawn.
 */
export const ACTIVITY_RAIL_MIN_LISTENED_MS = 10 * 60_000;
export const ACTIVITY_RAIL_LISTENED_WINDOW_DAYS = 30;

export interface AudiobookActivitySectionOptions {
    /**
     * Require the VIEWER to have listened recently before returning a section.
     *
     * True on a general feed (For You), where the rail competes with everything
     * else and is noise for someone who does not listen to audiobooks. False on
     * the audiobooks destination, where the viewer's navigation has already
     * established the context — a newcomer browsing /audiobooks is exactly who
     * "what is your circle listening to" is useful for.
     */
    requireViewerListening?: boolean;
}

export async function buildAudiobookActivitySection(
    ctx: AccessContext,
    surface: ApiSurface,
    locale: Locale,
    limit: number,
    options: AudiobookActivitySectionOptions = {},
): Promise<AudiobookActivitySection | null> {
    if (!features.social) return null;
    const sql = getDb();
    if (!sql) return null;

    if (options.requireViewerListening) {
        const listenedMs = await getViewerAudiobookListeningMs(
            sql,
            ctx.userId,
            ACTIVITY_RAIL_LISTENED_WINDOW_DAYS,
        );
        if (listenedMs < ACTIVITY_RAIL_MIN_LISTENED_MS) return null;
    }

    const rows = await getAudiobookActivityRail(
        sql,
        ctx.userId,
        restrictedAccess({
            deniedGroupIds: ctx.deniedGroupIds ?? [],
            maxAgeRating: ctx.maxAgeRating,
            allowUnrated: ctx.allowUnrated,
        }),
        limit,
    );
    if (rows.length === 0) return null;

    const previews = await audiobookPreviewsForAdmittedIds(
        sql,
        [...new Set(rows.map((row) => row.media_id))],
        ctx.userId,
        surface,
    );
    const byId = new Map(previews.map((book) => [book.id, book]));
    const names = new Map(
        (
            await getUserDisplayInfoByIds(
                sql,
                rows.map((row) => row.user_id),
            )
        ).map((row) => [row.id, row.display_name]),
    );
    const avatars = await userImageSets(
        sql,
        surface,
        rows.map((row) => row.user_id),
        { external: false },
    );
    return {
        type: 'audiobook-activity',
        id: 'audiobook-activity',
        title: m.audiobook_activity_title({}, { locale }),
        items: rows
            .filter((row) => byId.has(row.media_id))
            .map((row) => ({
                author: buildPublicAuthor(
                    row.user_id,
                    names.get(row.user_id) ?? null,
                    surface,
                    avatars.get(row.user_id),
                ),
                media: byId.get(row.media_id)!,
                kind: row.kind,
                ...(row.listened_minutes != null ? { listenedMinutes: row.listened_minutes } : {}),
                occurredOn: row.occurred_on,
                approximate: row.approximate,
            })),
    };
}
