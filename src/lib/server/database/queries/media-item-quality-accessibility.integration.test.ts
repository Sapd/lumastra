// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the accessibility/Atmos half of the media_item_quality
 * projection (migration 16.163.0).
 *
 * The majority rollup for series is the whole reason these exist: "any episode
 * has SDH" vs "most episodes have SDH" are both plausible-looking SQL and only
 * one matches getMediaStreamSummary. These tests pin the correct one.
 */

import { beforeAll, afterAll, afterEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import {
    refreshItemQuality,
    refreshSeriesQuality,
    rebuildAllQuality,
} from './media-item-quality.queries.js';
import { getTestDatabaseUrl } from '../../../../../tests/integration/setup/test-database.js';

const TEST_DATABASE_URL = getTestDatabaseUrl();

let sql: postgres.Sql;
const createdItems: string[] = [];
const createdFiles: string[] = [];

beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL, { max: 2 });
});

afterEach(async () => {
    if (createdItems.length > 0) {
        await sql`DELETE FROM media_item_quality WHERE media_item_id = ANY(${createdItems}::uuid[])`;
        await sql`DELETE FROM media_items WHERE id = ANY(${createdItems}::uuid[])`;
        createdItems.length = 0;
    }
    if (createdFiles.length > 0) {
        await sql`DELETE FROM media_files WHERE id = ANY(${createdFiles}::uuid[])`;
        createdFiles.length = 0;
    }
});

afterAll(async () => {
    await sql.end();
});

/** Create a media_items row + a linked media_files row, returning both ids. */
async function makeItem(
    mediaType: string,
    title: string,
    parentId?: string,
): Promise<{ itemId: string; fileId: string }> {
    const [item] = await sql<{ id: string }[]>`
        INSERT INTO media_items (title, media_type, status, parent_id)
        VALUES (${title}, ${mediaType}, 'active', ${parentId ?? null})
        RETURNING id
    `;
    const [file] = await sql<{ id: string }[]>`
        INSERT INTO media_files (file_path, file_size_bytes)
        VALUES (${`/tmp/${item.id}.mkv`}, 1)
        RETURNING id
    `;
    await sql`
        INSERT INTO media_file_items (file_id, media_item_id)
        VALUES (${file.id}, ${item.id})
    `;
    createdItems.push(item.id);
    createdFiles.push(file.id);
    return { itemId: item.id, fileId: file.id };
}

/** Every item needs a video stream: a projection row only exists with a resolution tier. */
async function addVideo(fileId: string, opts: { cc?: boolean; height?: number } = {}) {
    await sql`
        INSERT INTO media_streams (file_id, stream_type, stream_index, codec, height, has_closed_captions)
        VALUES (${fileId}, 'video', 0, 'hevc', ${opts.height ?? 2160}, ${opts.cc ?? false})
    `;
}

async function addAudio(
    fileId: string,
    opts: { profile?: string; codec?: string; channels?: number; ad?: boolean } = {},
) {
    await sql`
        INSERT INTO media_streams (file_id, stream_type, stream_index, codec, profile, channels, is_visual_impaired)
        VALUES (${fileId}, 'audio', 1, ${opts.codec ?? 'eac3'}, ${opts.profile ?? null},
                ${opts.channels ?? 6}, ${opts.ad ?? false})
    `;
}

async function addSubtitle(fileId: string, opts: { sdh?: boolean } = {}) {
    await sql`
        INSERT INTO media_streams (file_id, stream_type, stream_index, codec, is_hearing_impaired)
        VALUES (${fileId}, 'subtitle', 2, 'subrip', ${opts.sdh ?? false})
    `;
}

async function readQuality(itemId: string) {
    const [row] = await sql<
        {
            has_atmos: boolean;
            has_cc: boolean;
            has_sdh: boolean;
            has_ad: boolean;
            has_audio: boolean;
            has_subtitle: boolean;
        }[]
    >`SELECT has_atmos, has_cc, has_sdh, has_ad, has_audio, has_subtitle
      FROM media_item_quality WHERE media_item_id = ${itemId}`;
    return row;
}

describe('media_item_quality accessibility projection', () => {
    describe('movies (union across streams)', () => {
        it('projects CC, SDH, AD and Atmos from a fully-featured file', async () => {
            const { itemId, fileId } = await makeItem('movie', 'Full Featured');
            await addVideo(fileId, { cc: true });
            await addAudio(fileId, {
                codec: 'truehd',
                profile: 'TrueHD + Atmos',
                channels: 8,
                ad: true,
            });
            await addSubtitle(fileId, { sdh: true });

            await refreshItemQuality(sql, itemId);

            expect(await readQuality(itemId)).toMatchObject({
                has_atmos: true,
                has_cc: true,
                has_sdh: true,
                has_ad: true,
                has_audio: true,
                has_subtitle: true,
            });
        });

        it('leaves every flag false for a plain file', async () => {
            const { itemId, fileId } = await makeItem('movie', 'Plain');
            await addVideo(fileId);
            await addAudio(fileId);

            await refreshItemQuality(sql, itemId);

            expect(await readQuality(itemId)).toMatchObject({
                has_atmos: false,
                has_cc: false,
                has_sdh: false,
                has_ad: false,
                has_audio: true,
                has_subtitle: false,
            });
        });

        it('detects Atmos from a JOC profile on a 6-channel EAC3 core', async () => {
            // The channel-count fallback alone cannot see this — profile is the
            // only reliable signal, which is why quality_is_atmos checks it first.
            const { itemId, fileId } = await makeItem('movie', 'JOC');
            await addVideo(fileId);
            await addAudio(fileId, { codec: 'eac3', profile: 'Dolby Digital+ JOC', channels: 6 });

            await refreshItemQuality(sql, itemId);
            expect((await readQuality(itemId)).has_atmos).toBe(true);
        });

        it('does NOT claim Atmos for plain 7.1 EAC3', async () => {
            const { itemId, fileId } = await makeItem('movie', 'Plain 7.1');
            await addVideo(fileId);
            await addAudio(fileId, {
                codec: 'eac3',
                profile: null as unknown as string,
                channels: 8,
            });

            await refreshItemQuality(sql, itemId);
            expect((await readQuality(itemId)).has_atmos).toBe(false);
        });

        it('picks up SDH from a sidecar subtitle file with no embedded subtitle stream', async () => {
            const { itemId, fileId } = await makeItem('movie', 'Sidecar SDH');
            await addVideo(fileId);
            await sql`
                INSERT INTO external_subtitle_files (file_id, subtitle_path, format, is_sdh)
                VALUES (${fileId}, '/tmp/sub.srt', 'srt', true)
            `;

            await refreshItemQuality(sql, itemId);

            expect(await readQuality(itemId)).toMatchObject({
                has_sdh: true,
                has_subtitle: true,
            });
        });
    });

    describe('series (STRICT MAJORITY across episodes)', () => {
        async function makeSeriesWithSdhEpisodes(
            totalEpisodes: number,
            sdhEpisodes: number,
        ): Promise<string> {
            const [series] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, status)
                VALUES ('Majority Series', 'tv', 'active') RETURNING id
            `;
            createdItems.push(series.id);

            for (let i = 0; i < totalEpisodes; i += 1) {
                const { itemId, fileId } = await makeItem('episode', `Ep ${i}`, series.id);
                await addVideo(fileId);
                await addSubtitle(fileId, { sdh: i < sdhEpisodes });
                await refreshItemQuality(sql, itemId);
            }
            await refreshSeriesQuality(sql, series.id);
            return series.id;
        }

        it('does NOT badge SDH when only a minority of episodes have it', async () => {
            // The bug this guards: 1-of-5 would badge the whole series SDH
            // under "any episode" semantics.
            const seriesId = await makeSeriesWithSdhEpisodes(5, 1);
            expect((await readQuality(seriesId)).has_sdh).toBe(false);
        });

        it('badges SDH when a strict majority of episodes have it', async () => {
            const seriesId = await makeSeriesWithSdhEpisodes(5, 3);
            expect((await readQuality(seriesId)).has_sdh).toBe(true);
        });

        it('treats an exact half as NOT a majority', async () => {
            const seriesId = await makeSeriesWithSdhEpisodes(4, 2);
            expect((await readQuality(seriesId)).has_sdh).toBe(false);
        });

        it('rolls Atmos up as best-available, not majority', async () => {
            // Atmos is a "premium format is available" signal like 4K/DV, so a
            // single Atmos episode is enough — unlike the accessibility flags.
            const [series] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, status)
                VALUES ('Atmos Series', 'tv', 'active') RETURNING id
            `;
            createdItems.push(series.id);

            for (let i = 0; i < 4; i += 1) {
                const { itemId, fileId } = await makeItem('episode', `Ep ${i}`, series.id);
                await addVideo(fileId);
                await addAudio(
                    fileId,
                    i === 0
                        ? { codec: 'truehd', profile: 'TrueHD + Atmos', channels: 8 }
                        : { codec: 'eac3', channels: 6 },
                );
                await refreshItemQuality(sql, itemId);
            }
            await refreshSeriesQuality(sql, series.id);

            expect((await readQuality(series.id)).has_atmos).toBe(true);
        });

        it('does not let episodes lacking a kind dilute that kind’s vote', async () => {
            // 3 episodes: 2 have a subtitle track (both SDH), 1 has none.
            // Denominator for SDH is the 2 with subtitles → 2*2 > 2 → true.
            // A naive denominator of 3 would give 2*2 > 3 → also true, so make
            // it 1-of-2-with-subs out of 4 total to actually discriminate:
            // per-kind → 1*2 > 2 = false; naive → 1*2 > 4 = false. Use 2-of-3.
            const [series] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, status)
                VALUES ('Dilution Series', 'tv', 'active') RETURNING id
            `;
            createdItems.push(series.id);

            // 2 episodes WITH subtitles, both SDH.
            for (let i = 0; i < 2; i += 1) {
                const { itemId, fileId } = await makeItem('episode', `Sub Ep ${i}`, series.id);
                await addVideo(fileId);
                await addSubtitle(fileId, { sdh: true });
                await refreshItemQuality(sql, itemId);
            }
            // 3 episodes with NO subtitle track at all.
            for (let i = 0; i < 3; i += 1) {
                const { itemId, fileId } = await makeItem('episode', `Bare Ep ${i}`, series.id);
                await addVideo(fileId);
                await refreshItemQuality(sql, itemId);
            }
            await refreshSeriesQuality(sql, series.id);

            // Per-kind denominator (2 subtitle-bearing episodes): 2*2 > 2 → true.
            // A naive denominator over all 5 episodes would give 2*2 > 5 → false.
            expect((await readQuality(series.id)).has_sdh).toBe(true);
        });
    });

    describe('rebuildAllQuality', () => {
        it('produces the same flags as the incremental path', async () => {
            const { itemId, fileId } = await makeItem('movie', 'Rebuild Parity');
            await addVideo(fileId, { cc: true });
            await addAudio(fileId, { codec: 'truehd', profile: 'Atmos', channels: 8, ad: true });
            await addSubtitle(fileId, { sdh: true });

            await refreshItemQuality(sql, itemId);
            const incremental = await readQuality(itemId);

            await rebuildAllQuality(sql);
            const rebuilt = await readQuality(itemId);

            expect(rebuilt).toEqual(incremental);
            expect(rebuilt).toMatchObject({
                has_cc: true,
                has_sdh: true,
                has_ad: true,
                has_atmos: true,
            });
        });
    });
});
