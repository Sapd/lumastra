// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PageServerLoad } from './$types';
import { aiDbService } from '$lib/server/services/database.service.js';
import { buildSearchAccessContext } from '$lib/server/utils/search-access-context.js';
import {
    loadMusicExploreData,
    loadGenreCovers,
    GENRE_COVER_LIMIT,
} from '$lib/server/utils/music-explore-loader.js';
import { MOOD_CHIPS } from '$lib/constants/music-moods.js';

export const load: PageServerLoad = async ({ locals }) => {
    const sql = await aiDbService.getSql();
    if (!sql || !locals.user) {
        return {
            moodChips: MOOD_CHIPS,
            libraryGenres: [] as { genre: string; trackCount: number; albumCount: number }[],
            pinnedGenreNames: [] as string[],
            genreCovers: {} as Record<string, string[]>,
        };
    }
    const accessCtx = await buildSearchAccessContext(sql, locals.user);
    // /music/explore renders only the genre list + pinned names (see
    // MusicGenreBrowser) — skip the genre-plan compute (computeGenrePlanCached)
    // that /music's home feed needs, so we don't pay for or ship a payload
    // this page never uses.
    const explore = await loadMusicExploreData(sql, locals.user.userId, accessCtx, {
        includeGenrePlan: false,
    });
    // Collage covers for the most populous genres only — the chip browser
    // below still lists every genre, so the tail loses nothing but a picture.
    const coveredGenres = explore.libraryGenres.slice(0, GENRE_COVER_LIMIT).map((g) => g.genre);
    const genreCovers = await loadGenreCovers(sql, accessCtx, coveredGenres);
    return { moodChips: MOOD_CHIPS, ...explore, genreCovers };
};
