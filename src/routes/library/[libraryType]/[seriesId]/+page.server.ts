// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/database/connection.js';
import { getAccessibleSeriesWithEpisodes } from '$lib/server/utils/non-entertainment-series-access.js';
import { getLibraryTypeTemplate } from '$lib/shared/library-type-templates.js';
import { watchManager } from '$lib/server/services/watch-manager.service.js';

export const load: PageServerLoad = async ({ params, locals, depends }) => {
    depends('app:watch-state');

    const { libraryType, seriesId } = params;

    // Validate this is a known non-entertainment library type
    const template = getLibraryTypeTemplate(libraryType);
    if (!template) error(404, 'Unknown library type');

    const sql = getDb();
    if (!sql) error(503, 'Database unavailable');

    // Access-checked: a series the viewer may not see is a 404, like a missing one.
    const { series, episodes } = await getAccessibleSeriesWithEpisodes(sql, seriesId, locals.user, {
        mediaType: libraryType,
    });
    if (!series) error(404, 'Series not found');
    if (series.media_type !== libraryType) error(404, 'Not found');

    // Batch fetch watch states for all episodes
    const userId = locals.user?.userId;
    const watchStates =
        userId && episodes.length > 0
            ? await watchManager.batchGetWatchStates(
                  userId,
                  episodes.map((e) => e.id),
              )
            : new Map<string, { is_watched: boolean; resume_position_ms: number }>();

    const episodesWithStatus = episodes.map((ep) => {
        const ws = watchStates.get(ep.id);
        return {
            ...ep,
            is_watched: ws?.is_watched ?? false,
            resume_position_ms: Number(ws?.resume_position_ms ?? 0),
        };
    });

    const completedCount = episodesWithStatus.filter((e) => e.is_watched).length;
    const firstUnwatched = episodesWithStatus.find((e) => !e.is_watched);

    return {
        series,
        episodes: episodesWithStatus,
        libraryType,
        template,
        completedCount,
        continueEpisodeId: firstUnwatched?.id ?? episodesWithStatus[0]?.id ?? null,
    };
};
