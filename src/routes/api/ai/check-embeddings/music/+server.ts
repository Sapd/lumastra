// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { mount } from '$lib/server/api/mount.js';
import { aiDbService } from '$lib/server/services/database.service';
import { MusicEmbeddingStatsSchema, type MusicEmbeddingSample } from '$lib/schemas/admin-types';
import {
    getMusicEmbeddingStats,
    type MusicItemRow,
} from '$lib/server/database/queries/embedding-stats.queries.js';

function mapMusicRow(r: MusicItemRow): MusicEmbeddingSample {
    return {
        id: r.id,
        title: r.title,
        artist: r.artist,
        ...(r.album ? { album: r.album } : {}),
        ...(r.genres ? { genres: r.genres } : {}),
        hasEmbedding: r.has_embedding,
    };
}

const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async () => {
            const sql = await aiDbService.getSql();

            if (!sql) {
                return ApiProblem.dependencyUnavailable(
                    'AI admin database is currently unavailable',
                );
            }

            const { quality, recentTracks, sample } = await getMusicEmbeddingStats(sql);

            const q = quality[0];

            return json(
                MusicEmbeddingStatsSchema.parse({
                    totalTracks: parseInt(q.total_tracks, 10),
                    withEmbedding: parseInt(q.with_embedding, 10),
                    dataQuality: {
                        missingArtist: parseInt(q.missing_artist, 10),
                        missingAlbum: parseInt(q.missing_album, 10),
                        missingGenre: parseInt(q.missing_genre, 10),
                        missingBpm: parseInt(q.missing_bpm, 10),
                        missingMoodTags: parseInt(q.missing_mood_tags, 10),
                        avgGenreCount: Number(q.avg_genre_count),
                    },
                    recentTracks: recentTracks.map(mapMusicRow),
                    sample: sample.map(mapMusicRow),
                }),
            );
        },
    },
});

const { GET } = mount(def, { surface: 'internal' });
export { GET };
