// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Minimal media fixtures for the contract suite: items with real media_files,
 * media_streams and sidecar subtitles (the shared factories insert none of these).
 */
import type postgres from 'postgres';

export interface SeededItem {
    itemId: string;
    fileId: string;
}

async function item(
    sql: postgres.Sql,
    title: string,
    mediaType: string,
    parentId: string | null,
    extra: { season?: number; episode?: number } = {},
): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO media_items (title, media_type, status, parent_id, has_files, season_number, episode_number, runtime_seconds, year)
        VALUES (${title}, ${mediaType}, 'active', ${parentId}, ${['movie', 'episode', 'track'].includes(mediaType)},
                ${extra.season ?? null}, ${extra.episode ?? null}, 5400, 2020)
        RETURNING id`;
    return row.id;
}

async function file(sql: postgres.Sql, itemId: string, container = 'matroska'): Promise<string> {
    const ext = container === 'matroska' ? 'mkv' : container;
    const [f] = await sql<{ id: string }[]>`
        INSERT INTO media_files (file_path, file_size_bytes, container_format, duration_seconds, total_bitrate)
        VALUES (${`/media/contract/${itemId}.${ext}`}, 1000000, ${container}, 5400, 8000000) RETURNING id`;
    await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default) VALUES (${f.id}, ${itemId}, true)`;
    return f.id;
}

async function streams(
    sql: postgres.Sql,
    fileId: string,
    opts: { audio: number; embeddedSubs: number },
): Promise<void> {
    await sql`INSERT INTO media_streams (file_id, stream_type, stream_index, codec, width, height, bit_depth, profile, level, average_frame_rate, pixel_format)
              VALUES (${fileId}, 'video', 0, 'hevc', 1920, 1080, 10, 'Main 10', 120, 23.976, 'yuv420p10le')`;
    for (let i = 0; i < opts.audio; i++) {
        await sql`INSERT INTO media_streams (file_id, stream_type, stream_index, codec, channels, channel_layout, sample_rate, language, is_default)
                  VALUES (${fileId}, 'audio', ${1 + i}, ${i === 0 ? 'eac3' : 'aac'}, ${i === 0 ? 6 : 2}, ${i === 0 ? '5.1' : 'stereo'}, 48000, ${i === 0 ? 'eng' : 'deu'}, ${i === 0})`;
    }
    for (let i = 0; i < opts.embeddedSubs; i++) {
        await sql`INSERT INTO media_streams (file_id, stream_type, stream_index, codec, language, is_text_subtitle, is_hearing_impaired)
                  VALUES (${fileId}, 'subtitle', ${1 + opts.audio + i}, ${i === 0 ? 'subrip' : 'hdmv_pgs_subtitle'}, 'eng', ${i === 0}, ${i === 1})`;
    }
}

export async function seedMovieEmbeddedSubs(sql: postgres.Sql): Promise<SeededItem> {
    const itemId = await item(sql, 'Contract Movie', 'movie', null);
    const fileId = await file(sql, itemId);
    await streams(sql, fileId, { audio: 2, embeddedSubs: 2 });
    return { itemId, fileId };
}

/** leon's shape: an episode whose only subtitle is a sidecar .srt. */
export async function seedEpisodeExternalSrt(
    sql: postgres.Sql,
): Promise<SeededItem & { seriesId: string; seasonId: string }> {
    const seriesId = await item(sql, 'Contract Series', 'tv', null);
    const seasonId = await item(sql, 'Season 1', 'season', seriesId, { season: 1 });
    const itemId = await item(sql, 'Pilot', 'episode', seasonId, { season: 1, episode: 1 });
    const fileId = await file(sql, itemId);
    await streams(sql, fileId, { audio: 1, embeddedSubs: 0 });
    await sql`INSERT INTO external_subtitle_files (file_id, subtitle_path, language, format, is_forced, is_sdh)
              VALUES (${fileId}, ${`/media/contract/${itemId}.en.srt`}, 'en', 'srt', false, true)`;
    return { itemId, fileId, seriesId, seasonId };
}

/** An audio track — the stream-cap path answers it with the RateLimitExceeded refusal. */
export async function seedMusicTrack(sql: postgres.Sql): Promise<SeededItem> {
    const itemId = await item(sql, 'Contract Track', 'track', null);
    const fileId = await file(sql, itemId, 'flac');
    await sql`INSERT INTO media_streams (file_id, stream_type, stream_index, codec, channels, channel_layout, sample_rate)
              VALUES (${fileId}, 'audio', 0, 'flac', 2, 'stereo', 44100)`;
    return { itemId, fileId };
}

/**
 * A movie split across two files (scanner stacking: "Movie part1.mkv" +
 * "Movie part2.mkv"): one media_item, two media_files with part_number 1/2,
 * 2700 s and 2400 s long (different, so a part's own length is told apart).
 */
export async function seedMultiPartMovie(
    sql: postgres.Sql,
): Promise<{ itemId: string; fileIds: [string, string] }> {
    const itemId = await item(sql, 'Contract Two Part Movie', 'movie', null);
    const fileIds: string[] = [];
    for (const part of [1, 2]) {
        const [f] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path, file_size_bytes, container_format, duration_seconds, total_bitrate, part_number)
            VALUES (${`/media/contract/${itemId}/Movie part${part}.mkv`}, 1000000, 'matroska', ${part === 1 ? 2700 : 2400}, 8000000, ${part})
            RETURNING id`;
        await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order)
                  VALUES (${f.id}, ${itemId}, ${part === 1}, ${part - 1})`;
        await streams(sql, f.id, { audio: 1, embeddedSubs: 1 });
        fileIds.push(f.id);
    }
    return { itemId, fileIds: fileIds as [string, string] };
}

/**
 * artist → album → 2 tracks (shared music fixture); the first track's file gets
 * a real container, duration and audio stream so PlaybackInfo has a source.
 */
export async function seedMusicAlbum(
    sql: postgres.Sql,
): Promise<{ artistId: string; albumId: string; trackId: string; fileId: string }> {
    const { createAndInsertTestMusicHierarchy } =
        await import('../integration/fixtures/music.fixtures.js');
    const { artistId, albumId, trackIds } = await createAndInsertTestMusicHierarchy(sql, {
        artistTitle: 'Contract Artist',
        albumTitle: 'Contract Album',
        trackCount: 2,
    });
    const trackId = trackIds[0];
    const [{ file_id: fileId }] = await sql<{ file_id: string }[]>`
        SELECT file_id FROM media_file_items WHERE media_item_id = ${trackId} AND is_default`;
    await sql`UPDATE media_files
              SET container_format = 'mp3', file_size_bytes = 5000000, duration_seconds = 240, total_bitrate = 320000
              WHERE id = ${fileId}`;
    await sql`INSERT INTO media_streams (file_id, stream_type, stream_index, codec, channels, channel_layout, sample_rate, bitrate)
              VALUES (${fileId}, 'audio', 0, 'mp3', 2, 'stereo', 44100, 320000)`;
    await sql`UPDATE media_items SET status = 'active' WHERE id IN (${artistId}, ${albumId}, ${trackIds[0]}, ${trackIds[1]})`;
    // The scanner propagates has_files to the album and artist (propagateHasFilesBatch).
    await sql`UPDATE media_items SET has_files = true WHERE id IN (${artistId}, ${albumId})`;
    return { artistId, albumId, trackId, fileId };
}

/** Intro + outro segments for an item (the intro-analyzer's shape). */
export async function seedSegments(sql: postgres.Sql, itemId: string): Promise<void> {
    await sql`INSERT INTO media_segments (media_id, type, start_time, end_time, source)
              VALUES (${itemId}, 'Intro', 12.5, 80, 'lumastra-intro'),
                     (${itemId}, 'Outro', 5200, 5400, 'lumastra-intro')`;
}

/** Live TV tables the contract suite seeds; clear them per test (CASCADE). */
export const LIVETV_TABLES = [
    'livetv_channel_favorites',
    'livetv_programs',
    'livetv_channels',
    'livetv_categories',
    'livetv_sources',
] as const;

/**
 * One m3u source, one category, two channels (one favourite of `userId`) and a
 * guide: a programme airing now and the next one on each channel.
 */
export async function seedLiveTv(
    sql: postgres.Sql,
    userId: string,
): Promise<{ channelIds: [string, string]; programIds: string[] }> {
    const [src] = await sql<{ id: string }[]>`
        INSERT INTO livetv_sources (name, source_type, m3u_url, max_streams)
        VALUES ('Contract IPTV', 'm3u', 'http://iptv.test/list.m3u', 2) RETURNING id`;
    const [cat] = await sql<{ id: string }[]>`
        INSERT INTO livetv_categories (name, sort_order, is_visible)
        VALUES ('News', 0, true) RETURNING id`;
    const channelIds: string[] = [];
    const programIds: string[] = [];
    const now = Date.now();
    for (const [i, name] of ['Contract News', 'Contract Sports'].entries()) {
        const [ch] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status)
            VALUES (${name}, 'tvchannel', 'active') RETURNING id`;
        await sql`INSERT INTO livetv_channels (id, m3u_url, source_id, sort_order, is_visible, category_id, quality_tier, epg_channel_id)
                  VALUES (${ch.id}, ${`http://iptv.test/${i}.m3u8`}, ${src.id}, ${i}, true, ${cat.id}, 'hd', ${`contract.${i}`})`;
        channelIds.push(ch.id);
        for (const [slot, title] of [`${name} Live`, `${name} Later`].entries()) {
            const start = new Date(now - 30 * 60_000 + slot * 60 * 60_000);
            const end = new Date(start.getTime() + 60 * 60_000);
            const [p] = await sql<{ id: string }[]>`
                INSERT INTO livetv_programs (channel_id, title, description, start_time, end_time, epg_id, genres, official_rating)
                VALUES (${ch.id}, ${title}, 'Contract programme', ${start}, ${end}, ${`epg-${i}-${slot}`}, ${['News']}, 'TV-G')
                RETURNING id`;
            programIds.push(p.id);
        }
    }
    await sql`INSERT INTO livetv_channel_favorites (user_id, channel_id, sort_order) VALUES (${userId}, ${channelIds[0]}, 0)`;
    return { channelIds: channelIds as [string, string], programIds };
}

/** A local extra (scanner shape: media_type 'extra', parent_id = the movie) with one file. */
export async function seedExtra(
    sql: postgres.Sql,
    parentId: string,
    extraType: string,
    title: string,
): Promise<SeededItem> {
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO media_items (title, media_type, extra_type, parent_id, status, runtime_seconds)
        VALUES (${title}, 'extra', ${extraType}, ${parentId}, 'active', 120)
        RETURNING id`;
    const fileId = await file(sql, row.id);
    await streams(sql, fileId, { audio: 1, embeddedSubs: 0 });
    return { itemId: row.id, fileId };
}

/** TMDB provider metadata (the row the /j metadata lateral join reads). */
export async function seedProviderMetadata(
    sql: postgres.Sql,
    itemId: string,
    metadata: Record<string, unknown>,
): Promise<void> {
    await sql`INSERT INTO provider_metadata (media_id, provider, metadata)
              VALUES (${itemId}, 'tmdb', ${sql.json(metadata as never)})`;
}

/** A library embedding; `seed` picks a deterministic direction so neighbours are stable. */
export async function seedEmbedding(
    sql: postgres.Sql,
    itemId: string,
    seed: number,
): Promise<void> {
    const [{ dim }] = await sql<{ dim: number }[]>`
        SELECT atttypmod AS dim FROM pg_attribute
        WHERE attrelid = 'media_embeddings'::regclass AND attname = 'embedding'`;
    const v = Array.from({ length: dim }, (_, i) => Math.sin(i + 1) + seed * 0.01);
    await sql`INSERT INTO media_embeddings (media_id, embedding, source)
              VALUES (${itemId}, ${`[${v.join(',')}]`}::vector, 'library')`;
}

/** Mark an item watched (or favourite) for a user. */
export async function seedUserState(
    sql: postgres.Sql,
    userId: string,
    itemId: string,
    state: { watched?: boolean; favorite?: boolean },
): Promise<void> {
    await sql`INSERT INTO user_media_state (user_id, media_id, is_watched, is_favorite, last_watched_at, last_event_at)
              VALUES (${userId}, ${itemId}, ${state.watched ?? false}, ${state.favorite ?? null}, now(), now())`;
}

/**
 * A movie with a local trailer and a featurette, plus a second movie sharing its
 * lead actor and director; `userId` has watched the first. Both have embeddings.
 */
export async function seedRelatedMedia(
    sql: postgres.Sql,
    userId: string,
): Promise<{ movieId: string; otherId: string; trailerId: string; featuretteId: string }> {
    const movie = await seedMovieEmbeddedSubs(sql);
    const otherId = await item(sql, 'Contract Sequel', 'movie', null);
    const otherFile = await file(sql, otherId);
    await streams(sql, otherFile, { audio: 1, embeddedSubs: 0 });
    const people = { actors: ['Contract Actor'], directors: ['Contract Director'] };
    await seedProviderMetadata(sql, movie.itemId, {
        ...people,
        trailer_url: 'https://www.youtube.com/watch?v=contract',
    });
    await seedProviderMetadata(sql, otherId, people);
    await seedEmbedding(sql, movie.itemId, 0);
    await seedEmbedding(sql, otherId, 1);
    await seedUserState(sql, userId, movie.itemId, { watched: true });
    const trailer = await seedExtra(sql, movie.itemId, 'trailer', 'trailer');
    const featurette = await seedExtra(sql, movie.itemId, 'featurette', 'Making Of');
    return {
        movieId: movie.itemId,
        otherId,
        trailerId: trailer.itemId,
        featuretteId: featurette.itemId,
    };
}
