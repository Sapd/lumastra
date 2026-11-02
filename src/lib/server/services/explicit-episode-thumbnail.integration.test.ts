// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import postgres from 'postgres';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, afterEach, expect, it } from 'vitest';
import {
    getTestDb,
    getTestDatabaseUrl,
} from '../../../../tests/integration/setup/test-database.js';
import {
    upsertLocalArtwork,
    listSharedEpisodeThumbReview,
    addArtworkSuppression,
} from '$lib/server/database/queries/media-artwork.queries.js';
import {
    captureExplicitEpisodeThumbnailInput,
    publishExplicitEpisodeThumbnail,
} from './explicit-episode-thumbnail.service.js';
import { extractFrame } from './video-frame-extractor.service.js';
import { explicitEpisodeThumbnailReviewToken } from './explicit-episode-thumbnail.service.js';
import type postgresType from 'postgres';

const execFileAsync = promisify(execFile);

const sql = getTestDb();
let directory: string;
let series: string;
let season: string;
let episode: string;
let sibling: string;
let file: string;
let sourcePath: string;
let sharedPath: string;
let selectedId: string;
let extraItems: string[];

beforeEach(async () => {
    extraItems = [];
    directory = await mkdtemp(join(tmpdir(), 'explicit-thumb-'));
    series = randomUUID();
    season = randomUUID();
    episode = randomUUID();
    sibling = randomUUID();
    file = randomUUID();
    sourcePath = join(directory, 'Fictional - S01E01E02.mkv');
    sharedPath = join(directory, 'shared-thumb.jpg');
    await writeFile(sourcePath, 'original source bytes');
    await writeFile(sharedPath, 'curated image bytes');
    await sql`INSERT INTO media_items(id,title,media_type) VALUES (${series},'Fictional series','tv')`;
    await sql`INSERT INTO media_items(id,title,media_type,parent_id,season_number)
        VALUES (${season},'Season one','season',${series},1)`;
    await sql`INSERT INTO media_items(id,title,media_type,parent_id,season_number,episode_number)
        VALUES (${episode},'First','episode',${season},1,1),(${sibling},'Second','episode',${season},1,2)`;
    await sql`INSERT INTO media_files(id,file_path,duration_seconds,file_hash_head)
        VALUES (${file},${sourcePath},1200,'original-head')`;
    await sql`INSERT INTO media_file_items(file_id,media_item_id,is_default,start_offset_ms,end_offset_ms)
        VALUES (${file},${episode},true,0,600000),(${file},${sibling},true,600000,1200000)`;
    await upsertLocalArtwork(sql, {
        mediaItemId: episode,
        artworkType: 'thumb',
        filePath: sharedPath,
    });
    await upsertLocalArtwork(sql, {
        mediaItemId: sibling,
        artworkType: 'thumb',
        filePath: sharedPath,
    });
    const [selected] = await sql<{ id: string }[]>`
        SELECT id FROM image_candidates WHERE media_item_id=${episode} AND artwork_type='thumb' AND selected`;
    selectedId = selected.id;
});

afterEach(async () => {
    if (extraItems.length) await sql`DELETE FROM media_items WHERE id=ANY(${extraItems}::uuid[])`;
    await sql`DELETE FROM media_items WHERE id=ANY(${[episode, sibling, season, series]}::uuid[])`;
    await sql`DELETE FROM media_files WHERE id=${file}`;
    await rm(directory, { recursive: true, force: true });
});

it('counts selected path owners globally while returning only requested season or series rows', async () => {
    const privatePath = join(directory, 'private-thumb.jpg');
    const siblingPath = join(directory, 'sibling-thumb.jpg');
    await sql`UPDATE image_candidates SET file_path=${siblingPath}
        WHERE media_item_id=${sibling} AND artwork_type='thumb' AND selected`;
    const otherSeason = randomUUID();
    const otherEpisode = randomUUID();
    const privateEpisode = randomUUID();
    extraItems.push(otherEpisode, privateEpisode, otherSeason);
    await sql`INSERT INTO media_items(id,title,media_type,parent_id,season_number)
        VALUES (${otherSeason},'Season two','season',${series},2)`;
    await sql`INSERT INTO media_items(id,title,media_type,parent_id,season_number,episode_number)
        VALUES (${otherEpisode},'Other season','episode',${otherSeason},2,1),
               (${privateEpisode},'Private','episode',${otherSeason},2,2)`;
    await upsertLocalArtwork(sql, {
        mediaItemId: otherEpisode,
        artworkType: 'thumb',
        filePath: sharedPath,
    });
    await upsertLocalArtwork(sql, {
        mediaItemId: privateEpisode,
        artworkType: 'thumb',
        filePath: privatePath,
    });

    const seasonPage = await listSharedEpisodeThumbReview(sql, season, 1, 0);
    expect(seasonPage).toMatchObject({ total: 1, rows: [{ episodeId: episode, sharedCount: 2 }] });
    expect(seasonPage.rows).toHaveLength(1);
    expect(seasonPage.rows.every((row) => row.artworkPath !== privatePath)).toBe(true);

    const otherSeries = randomUUID();
    const otherSeriesSeason = randomUUID();
    const otherSeriesEpisode = randomUUID();
    extraItems.push(otherSeriesEpisode, otherSeriesSeason, otherSeries);
    await sql`INSERT INTO media_items(id,title,media_type) VALUES (${otherSeries},'Other series','tv')`;
    await sql`INSERT INTO media_items(id,title,media_type,parent_id,season_number)
        VALUES (${otherSeriesSeason},'Season one','season',${otherSeries},1)`;
    await sql`INSERT INTO media_items(id,title,media_type,parent_id,season_number,episode_number)
        VALUES (${otherSeriesEpisode},'Other series episode','episode',${otherSeriesSeason},1,1)`;
    await upsertLocalArtwork(sql, {
        mediaItemId: otherSeriesEpisode,
        artworkType: 'thumb',
        filePath: sharedPath,
    });
    const otherPrivatePath = join(directory, 'other-private-thumb.jpg');
    await sql`UPDATE image_candidates SET file_path=${otherPrivatePath}
        WHERE media_item_id=${otherEpisode} AND artwork_type='thumb' AND selected`;

    const seriesPage = await listSharedEpisodeThumbReview(sql, series, 1, 0);
    expect(seriesPage).toMatchObject({ total: 1, rows: [{ episodeId: episode, sharedCount: 2 }] });
    expect(seriesPage.rows).toHaveLength(1);
    expect(seriesPage.rows.every((row) => row.artworkPath !== privatePath)).toBe(true);
});

async function output(): Promise<string> {
    const path = join(directory, `${randomUUID()}-thumb.jpg`);
    await writeFile(path, 'new immutable frame bytes');
    return path;
}

it('pages ownerless shared selections with source and protection context without mutating them', async () => {
    await sql`UPDATE image_candidates SET chosen_by='admin',locked=true WHERE id=${selectedId}`;
    const first = await listSharedEpisodeThumbReview(sql, series, 1, 0);
    const second = await listSharedEpisodeThumbReview(sql, series, 1, 1);
    expect(first.total).toBe(2);
    expect(second.total).toBe(2);
    expect(first.rows).toHaveLength(1);
    expect(second.rows).toHaveLength(1);
    expect(new Set([first.rows[0].episodeId, second.rows[0].episodeId])).toEqual(
        new Set([episode, sibling]),
    );
    expect(first.rows[0].sourceSharedCount).toBe(2);
    expect(first.rows[0].sharedCount).toBe(2);
    expect(
        (await sql`SELECT id FROM image_candidates WHERE media_item_id=${episode} AND selected`)[0]
            .id,
    ).toBe(selectedId);
});

it.each(['lock', 'suppression'] as const)(
    'keeps projection and review token on one snapshot across a concurrent %s change',
    async (change) => {
        const editor = postgres(getTestDatabaseUrl(), { max: 1 });
        try {
            const observed = await sql.begin(
                'isolation level repeatable read read only',
                async (rawTx) => {
                    const tx = rawTx as unknown as postgresType.Sql;
                    const projection = await listSharedEpisodeThumbReview(tx, season, 1, 0);
                    expect(projection.rows[0]).toMatchObject({
                        episodeId: episode,
                        locked: false,
                        suppressed: false,
                    });
                    if (change === 'lock')
                        await editor`UPDATE image_candidates SET locked=true,chosen_by='admin' WHERE id=${selectedId}`;
                    else await addArtworkSuppression(editor, episode, 'thumb', sharedPath);
                    const input = await captureExplicitEpisodeThumbnailInput(tx, episode);
                    expect(input).not.toBeNull();
                    return {
                        row: projection.rows[0],
                        token: explicitEpisodeThumbnailReviewToken(input!),
                    };
                },
            );
            const current = await captureExplicitEpisodeThumbnailInput(sql, episode);
            expect(current).not.toBeNull();
            expect(observed.token).not.toBe(explicitEpisodeThumbnailReviewToken(current!));
            if (change === 'lock') expect(observed.row.locked).toBe(false);
            else expect(observed.row.suppressed).toBe(false);
        } finally {
            await editor.end();
        }
    },
);

it('deliberately replaces a locked manual selection while retaining every old candidate and byte', async () => {
    await sql`UPDATE image_candidates SET chosen_by='admin',locked=true WHERE id=${selectedId}`;
    const input = await captureExplicitEpisodeThumbnailInput(sql, episode);
    expect(input).not.toBeNull();
    const frame = await output();
    expect(await publishExplicitEpisodeThumbnail(sql, input!, frame)).toBe(true);
    const [winner] = await sql<{ id: string; file_path: string; chosen_by: string }[]>`
        SELECT id,file_path,chosen_by FROM image_candidates WHERE media_item_id=${episode} AND artwork_type='thumb' AND selected`;
    expect(winner.file_path).toBe(frame);
    expect(winner.chosen_by).toBe('admin');
    expect(await sql`SELECT id FROM image_candidates WHERE id=${selectedId}`).toHaveLength(1);
    expect(
        await sql`SELECT id FROM image_candidates WHERE media_item_id=${sibling} AND file_path=${sharedPath} AND selected`,
    ).toHaveLength(1);
    expect(await readFile(sharedPath, 'utf8')).toBe('curated image bytes');
    expect(await readFile(frame, 'utf8')).toBe('new immutable frame bytes');
});

it.each([
    'file-generation',
    'physical-bytes',
    'source-link',
    'window',
    'sibling-order',
    'selection',
    'lock',
    'removal',
    'provider-suppression',
    'cancellation',
] as const)(
    'rejects %s observed after frame extraction without publishing or overriding a choice',
    async (change) => {
        const controller = new AbortController();
        const input = await captureExplicitEpisodeThumbnailInput(sql, episode, controller.signal);
        expect(input).not.toBeNull();
        const frame = await output(); // FFmpeg has finished; mutation races the publication fence.
        if (change === 'file-generation')
            await sql`UPDATE media_files SET file_hash_head='replacement' WHERE id=${file}`;
        if (change === 'physical-bytes') await writeFile(sourcePath, 'replacement source bytes');
        if (change === 'source-link')
            await sql`DELETE FROM media_file_items WHERE media_item_id=${episode}`;
        if (change === 'window')
            await sql`UPDATE media_file_items SET end_offset_ms=590000 WHERE media_item_id=${episode}`;
        if (change === 'sibling-order')
            await sql`UPDATE media_items SET episode_number=3 WHERE id=${sibling}`;
        if (change === 'selection') {
            const [other] = await sql<{ id: string }[]>`INSERT INTO image_candidates
                (media_item_id,artwork_type,source,provider,provider_ref,file_path)
                VALUES (${episode},'thumb','local','local-folder','other',${join(directory, 'other.jpg')}) RETURNING id`;
            await sql`UPDATE image_candidates SET selected=false WHERE id=${selectedId}`;
            await sql`UPDATE image_candidates SET selected=true,chosen_by='admin' WHERE id=${other.id}`;
        }
        if (change === 'lock')
            await sql`UPDATE image_candidates SET locked=true,chosen_by='admin' WHERE id=${selectedId}`;
        if (change === 'removal') await addArtworkSuppression(sql, episode, 'thumb', sharedPath);
        if (change === 'provider-suppression')
            await sql`INSERT INTO image_provider_suppressions(owner,provider,role)
                VALUES (${episode},'frame-extract','thumb')`;
        if (change === 'cancellation') controller.abort();
        expect(await publishExplicitEpisodeThumbnail(sql, input!, frame, controller.signal)).toBe(
            false,
        );
        expect(
            await sql`SELECT id FROM image_candidates WHERE media_item_id=${episode} AND file_path=${frame}`,
        ).toHaveLength(0);
        expect(await sql`SELECT id FROM image_candidates WHERE id=${selectedId}`).toHaveLength(1);
        expect(await readFile(sharedPath, 'utf8')).toBe('curated image bytes');
    },
);

it('yields to a concurrent source editor instead of selecting an unverified frame', async () => {
    const input = await captureExplicitEpisodeThumbnailInput(sql, episode);
    expect(input).not.toBeNull();
    const frame = await output();
    const editor = postgres(getTestDatabaseUrl(), { max: 1 });
    let release: () => void = () => {};
    let ready: () => void = () => {};
    const released = new Promise<void>((resolve) => {
        release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
        ready = resolve;
    });
    const holding = editor.begin(async (tx) => {
        await tx`SELECT id FROM media_files WHERE id=${file} FOR UPDATE`;
        ready();
        await released;
    });
    await locked;
    try {
        expect(await publishExplicitEpisodeThumbnail(sql, input!, frame)).toBe(false);
        expect(
            await sql`SELECT id FROM image_candidates WHERE media_item_id=${episode} AND file_path=${frame}`,
        ).toHaveLength(0);
    } finally {
        release();
        await holding;
        await editor.end();
    }
});

it('rejects a changed selection after real FFmpeg extraction of a temporary episode video', async () => {
    await execFileAsync('ffmpeg', [
        '-nostdin',
        '-y',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=320x180:rate=2',
        '-t',
        '2',
        '-c:v',
        'mpeg4',
        sourcePath,
    ]);
    await sql`UPDATE media_files SET duration_seconds=2,file_hash_head='real-video' WHERE id=${file}`;
    await sql`UPDATE media_file_items SET end_offset_ms=1000 WHERE media_item_id=${episode}`;
    await sql`UPDATE media_file_items SET start_offset_ms=1000,end_offset_ms=2000 WHERE media_item_id=${sibling}`;
    const input = await captureExplicitEpisodeThumbnailInput(sql, episode);
    expect(input).not.toBeNull();
    const frame = join(directory, 'actual-extracted-frame.jpg');
    const extraction = await extractFrame({
        videoPath: sourcePath,
        outputPath: frame,
        timestampPercent: 50,
        baseOffsetSeconds: input!.span.base,
        durationSeconds: input!.span.duration,
    });
    expect(extraction.success).toBe(true);
    expect((await readFile(frame)).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    const [replacement] = await sql<{ id: string }[]>`INSERT INTO image_candidates
        (media_item_id,artwork_type,source,provider,provider_ref,file_path)
        VALUES (${episode},'thumb','local','local-folder','replacement',${join(directory, 'replacement.jpg')}) RETURNING id`;
    await sql`UPDATE image_candidates SET selected=false WHERE id=${selectedId}`;
    await sql`UPDATE image_candidates SET selected=true,chosen_by='admin' WHERE id=${replacement.id}`;
    expect(await publishExplicitEpisodeThumbnail(sql, input!, frame)).toBe(false);
    expect(
        (
            await sql<{ id: string }[]>`SELECT id FROM image_candidates
        WHERE media_item_id=${episode} AND artwork_type='thumb' AND selected`
        )[0].id,
    ).toBe(replacement.id);
    expect(await sql`SELECT id FROM image_candidates WHERE file_path=${frame}`).toHaveLength(0);
    expect(await readFile(sharedPath, 'utf8')).toBe('curated image bytes');
});
