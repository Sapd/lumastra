// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Media Stream Summary Query Module
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../../tests/integration/fixtures/index.js';
import { upsertMediaFile, attachFileToItem } from './media-files.queries.js';
import { replaceStreamsForFile } from './media-streams.queries.js';
import { upsertExternalSubtitle } from './external-subtitles.queries.js';
import { getMediaStreamSummary } from './media-stream-summary.queries.js';

describe('getMediaStreamSummary', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql.unsafe(
            'TRUNCATE TABLE external_subtitle_files, media_streams, media_file_items, media_files, media_items RESTART IDENTITY CASCADE',
        );
    });

    async function createFileWithItem(
        filePath: string,
        overrides: Parameters<typeof createTestMediaItem>[0] = { media_type: 'movie' },
    ): Promise<{ fileId: string; itemId: string }> {
        const item = createTestMediaItem(overrides);
        await insertTestMediaItem(sql, item);
        const { id: fileId } = await upsertMediaFile(sql, { filePath });
        await attachFileToItem(sql, fileId, item.id);
        return { fileId, itemId: item.id };
    }

    it('movie: unions embedded audio languages and a sidecar subtitle language', async () => {
        const { fileId, itemId } = await createFileWithItem('/movies/test-movie/movie.mkv');

        await replaceStreamsForFile(sql, fileId, [
            {
                file_id: fileId,
                stream_type: 'video',
                stream_index: 0,
                codec: 'h264',
                is_default: true,
                is_forced: false,
            },
            {
                file_id: fileId,
                stream_type: 'audio',
                stream_index: 1,
                codec: 'aac',
                language: 'eng',
                is_default: true,
                is_forced: false,
            },
            {
                file_id: fileId,
                stream_type: 'audio',
                stream_index: 2,
                codec: 'aac',
                language: 'deu',
                is_default: false,
                is_forced: false,
            },
        ]);

        await upsertExternalSubtitle(sql, {
            fileId,
            subtitlePath: '/movies/test-movie/movie.fra.srt',
            language: 'fra',
            format: 'srt',
            isForced: false,
            isSDH: false,
        });

        const summary = await getMediaStreamSummary(sql, itemId, 'movie');

        expect(summary.audioLanguages.sort()).toEqual(['de', 'en']);
        expect(summary.subtitleLanguages).toContain('fr');
    });

    it('series: includes a language present in a strict majority of episodes', async () => {
        const series = createTestMediaItem({ media_type: 'tv' });
        await insertTestMediaItem(sql, series);

        const episodeIds: string[] = [];
        for (let i = 0; i < 3; i++) {
            const episode = createTestMediaItem({
                media_type: 'episode',
                parent_id: series.id,
            });
            await insertTestMediaItem(sql, episode);
            episodeIds.push(episode.id);

            const { id: fileId } = await upsertMediaFile(sql, {
                filePath: `/series/test-series/S01E0${i + 1}.mkv`,
            });
            await attachFileToItem(sql, fileId, episode.id);

            const audioStreams =
                i < 2
                    ? [
                          {
                              file_id: fileId,
                              stream_type: 'audio' as const,
                              stream_index: 0,
                              codec: 'aac',
                              language: 'deu',
                              is_default: true,
                              is_forced: false,
                          },
                      ]
                    : [
                          {
                              file_id: fileId,
                              stream_type: 'audio' as const,
                              stream_index: 0,
                              codec: 'aac',
                              language: 'eng',
                              is_default: true,
                              is_forced: false,
                          },
                      ];
            await replaceStreamsForFile(sql, fileId, audioStreams);
        }

        const summary = await getMediaStreamSummary(sql, series.id, 'tv');

        expect(summary.audioLanguages).toContain('de');
    });

    it('series: rolls up a language from episodes nested under a season', async () => {
        const series = createTestMediaItem({ media_type: 'tv' });
        await insertTestMediaItem(sql, series);

        const season = createTestMediaItem({ media_type: 'season', parent_id: series.id });
        await insertTestMediaItem(sql, season);

        for (let i = 0; i < 2; i++) {
            const episode = createTestMediaItem({
                media_type: 'episode',
                parent_id: season.id,
            });
            await insertTestMediaItem(sql, episode);

            const { id: fileId } = await upsertMediaFile(sql, {
                filePath: `/series/season-nested-series/S01E0${i + 1}.mkv`,
            });
            await attachFileToItem(sql, fileId, episode.id);

            await replaceStreamsForFile(sql, fileId, [
                {
                    file_id: fileId,
                    stream_type: 'audio',
                    stream_index: 0,
                    codec: 'aac',
                    language: 'jpn',
                    is_default: true,
                    is_forced: false,
                },
            ]);
        }

        const summary = await getMediaStreamSummary(sql, series.id, 'tv');

        expect(summary.audioLanguages).toContain('ja');
    });

    it('movie: a sidecar-only is_sdh flag surfaces as hasSDH', async () => {
        const { fileId, itemId } = await createFileWithItem('/movies/sdh-movie/movie.mkv');

        await upsertExternalSubtitle(sql, {
            fileId,
            subtitlePath: '/movies/sdh-movie/movie.eng.sdh.srt',
            language: 'eng',
            format: 'srt',
            isForced: false,
            isSDH: true,
        });

        const summary = await getMediaStreamSummary(sql, itemId, 'movie');

        expect(summary.hasSDH).toBe(true);
    });
});
