// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import { getTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../tests/integration/helpers/cleanup.js';
import { upsertMediaFile, attachFileToItem } from '../database/queries/media-files.queries.js';
import { upsertCompletedRow } from '../database/queries/stage-state.queries.js';
import {
    getTrickplayParams,
    upsertTrickplayParams,
} from '../database/queries/trickplay-params.queries.js';
import {
    saveSpriteSheet,
    saveTrickplayManifest,
    type TrickplayManifest,
} from './trickplay-storage.service.js';
import { generateTrickplayForMediaItem } from './trickplay-generator.service.js';
import {
    repairLocalTrickplayParams,
    buildTrickplayManifest,
    persistLocalTrickplayParams,
} from './playback-trickplay.service.js';
import { resolveTrickplayAvailability } from '../api/defs/playback/timeline.js';

const settings = vi.hoisted(() => ({
    TRICKPLAY_SERVE_LOCAL: true,
    TRICKPLAY_ENABLED: true,
    TRICKPLAY_HWACCEL: 'off',
    TRICKPLAY_PROVIDER: 'local_only',
    TRICKPLAY_STORAGE_PATH: '',
    TRICKPLAY_STORAGE_LOCATION: 'central',
    METADATA_STORAGE_LOCATION: 'central',
}));
vi.mock('$lib/server/config.js', async (original) => {
    const actual = await original<typeof import('$lib/server/config.js')>();
    return {
        ...actual,
        config: new Proxy(actual.config, {
            get: (target, key) =>
                key in settings ? settings[key as keyof typeof settings] : Reflect.get(target, key),
        }),
    };
});

describe('timeline repairs existing generated artifacts without a backfill', () => {
    let sql: postgres.Sql;
    let root: string;
    let itemId: string;
    let fileId: string;
    let alternateId: string;
    let filePath: string;
    const manifest: TrickplayManifest = {
        version: '1.0',
        width: 480,
        height: 270,
        tileWidth: 2,
        tileHeight: 2,
        interval: 10000,
        thumbnailCount: 1,
        format: 'webp',
        sheets: [{ index: 0, filename: '0.webp', startTime: 0, endTime: 0, thumbnailCount: 1 }],
    };
    beforeEach(async () => {
        sql = getTestDb();
        await truncateTables(sql, [...TEST_TABLES.mediaFiles, ...TEST_TABLES.media]);
        root = await mkdtemp(join(tmpdir(), 'timeline-repair-'));
        settings.TRICKPLAY_STORAGE_PATH = join(root, 'sprites');
        settings.TRICKPLAY_SERVE_LOCAL = true;
        settings.TRICKPLAY_STORAGE_LOCATION = 'central';
        const [item] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type) VALUES ('Existing previews', 'movie') RETURNING id`;
        itemId = item.id;
        filePath = join(root, 'movie.mp4');
        await writeFile(filePath, 'fixture');
        fileId = (await upsertMediaFile(sql, { filePath })).id;
        await attachFileToItem(sql, fileId, itemId);
        alternateId = (await upsertMediaFile(sql, { filePath: join(root, 'alternate.mp4') })).id;
        await attachFileToItem(sql, alternateId, itemId);
        await upsertCompletedRow(sql, {
            mediaItemId: itemId,
            stageId: 'trickplay-generation',
            processingVersion: 1,
        });
    });
    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    async function publish(withSheet = true): Promise<void> {
        if (withSheet)
            await saveSpriteSheet(fileId, manifest.width, 0, Buffer.from('sprite'), filePath);
        // No provenance: this is an old install's pre-reuse artifact.
        await saveTrickplayManifest(fileId, manifest.width, manifest, filePath);
    }

    it.each(['central', 'alongside'])(
        'recovers custom widths from %s storage and persists selected-file params',
        async (location) => {
            settings.TRICKPLAY_STORAGE_LOCATION = location;
            await publish();
            expect(await getTrickplayParams(sql, itemId)).toEqual([]);
            expect(await resolveTrickplayAvailability(sql, itemId, 'movie', fileId)).toEqual({
                trickplayState: 'ready',
                trickplayWidths: [480],
            });
            expect(await getTrickplayParams(sql, itemId, fileId)).toMatchObject([
                { file_id: fileId, width: 480, height: 270, thumbnail_count: 1, source: 'local' },
            ]);
            expect(await buildTrickplayManifest(sql, itemId, fileId, 480, filePath)).not.toBeNull();
            expect(await resolveTrickplayAvailability(sql, itemId, 'movie', alternateId)).toEqual({
                trickplayState: 'pending',
                trickplayWidths: [],
            });
            expect(await getTrickplayParams(sql, itemId, alternateId)).toEqual([]);
            expect(await repairLocalTrickplayParams(sql, itemId, fileId)).toEqual([480]);
            expect(await getTrickplayParams(sql, itemId, fileId)).toHaveLength(1);
        },
    );

    it.each(['local_only', 'prefer_local'])(
        'persists params after real FFmpeg generation in %s mode',
        async (provider) => {
            settings.TRICKPLAY_PROVIDER = provider;
            await copyFile(join(process.cwd(), 'tests/fixtures/test-video.mp4'), filePath);
            // The alternate cut has no file in this fixture; generate only the
            // linked physical source, as a one-file install would.
            await sql`DELETE FROM media_file_items WHERE file_id = ${alternateId}`;
            const result = await generateTrickplayForMediaItem(sql, itemId, {
                width: 160,
                intervalMs: 10000,
                tileWidth: 2,
                tileHeight: 2,
            });
            expect(result.success, result.error).toBe(true);
            expect(result.generated).toBeGreaterThan(0);
            expect(await getTrickplayParams(sql, itemId, fileId)).toMatchObject([
                { width: 160, source: 'local' },
            ]);
            expect(await resolveTrickplayAvailability(sql, itemId, 'movie', fileId)).toEqual({
                trickplayState: 'ready',
                trickplayWidths: [160],
            });
        },
    );

    it('keeps a manifest with missing sheets pending', async () => {
        await publish(false);
        expect(await resolveTrickplayAvailability(sql, itemId, 'movie', fileId)).toEqual({
            trickplayState: 'pending',
            trickplayWidths: [],
        });
        expect(await getTrickplayParams(sql, itemId)).toEqual([]);
    });

    it('preserves stage invalidation even when artifacts still exist', async () => {
        await publish();
        await sql`UPDATE media_item_stage_state SET invalidated_at = NOW() WHERE media_item_id = ${itemId}`;
        expect(await resolveTrickplayAvailability(sql, itemId, 'movie', fileId)).toEqual({
            trickplayState: 'pending',
            trickplayWidths: [],
        });
        expect(await getTrickplayParams(sql, itemId)).toEqual([]);
    });

    it('does not resurrect local output when local serving is disabled', async () => {
        await publish();
        settings.TRICKPLAY_SERVE_LOCAL = false;
        expect(await resolveTrickplayAvailability(sql, itemId, 'movie', fileId)).toEqual({
            trickplayState: 'pending',
            trickplayWidths: [],
        });
        expect(await getTrickplayParams(sql, itemId)).toEqual([]);
    });
    it('removes other-provider widths for this file after publishing local params', async () => {
        const row = {
            width: 320,
            height: 180,
            intervalMs: 10000,
            tileWidth: 2,
            tileHeight: 2,
            thumbnailCount: 1,
            bandwidth: 50000,
            source: 'jellyfin-disk',
        };
        await upsertTrickplayParams(sql, itemId, fileId, [row]);
        await upsertTrickplayParams(sql, itemId, alternateId, [row]);
        await persistLocalTrickplayParams(sql, itemId, fileId, manifest);
        expect((await getTrickplayParams(sql, itemId, fileId)).map((r) => r.source)).toEqual([
            'local',
        ]);
        expect(await getTrickplayParams(sql, itemId, alternateId)).toHaveLength(1);
    });

    it.each(['matching', 'changed-bytes', 'changed-mtime'])(
        'checks manifest provenance: %s',
        async (mode) => {
            const { fingerprintTrickplaySource } = await import('./trickplay-reclaim.service.js');
            const { utimes, stat } = await import('node:fs/promises');
            const provenance = {
                ...(await fingerprintTrickplaySource(filePath)),
                quality: 80,
                spriteQuality: 80,
                providerId: 'local-trickplay',
            };
            await saveSpriteSheet(fileId, manifest.width, 0, Buffer.from('sprite'), filePath);
            await saveTrickplayManifest(
                fileId,
                manifest.width,
                { ...manifest, reuse: provenance },
                filePath,
            );
            if (mode === 'changed-bytes') {
                const before = await stat(filePath);
                await writeFile(filePath, 'changed'); // same byte count, different fingerprint
                await utimes(filePath, before.atime, before.mtime);
            }
            if (mode === 'changed-mtime')
                await utimes(filePath, new Date(), new Date(Date.now() + 60000));
            expect(await repairLocalTrickplayParams(sql, itemId, fileId)).toEqual(
                mode === 'matching' ? [480] : [],
            );
            expect(await getTrickplayParams(sql, itemId, fileId)).toHaveLength(
                mode === 'matching' ? 1 : 0,
            );
        },
    );
});
