// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, mkdir, readdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const mockConfig = vi.hoisted(() => ({
    trickplayStoragePath: '',
    storageLocation: 'central' as 'central' | 'alongside' | 'alongside-prefer',
}));

describe('immutable seek-preview replacement', () => {
    let root: string;
    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'preview-publication-'));
        mockConfig.trickplayStoragePath = root;
        mockConfig.storageLocation = 'central';
        vi.resetModules();
    });
    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });
    it('keeps just the current and previous published generations and cleans abandoned nested output', async () => {
        const storage = await import('./trickplay-storage.service.js');
        const id = randomUUID();
        const generations: string[] = [randomUUID(), randomUUID(), randomUUID()];
        await storage.saveSpriteSheet(id, 320, 0, Buffer.from('legacy flat output'));
        for (const generation of generations) {
            await storage.saveSpriteSheet(
                id,
                320,
                0,
                Buffer.from(generation),
                undefined,
                generation,
            );
            await storage.saveTrickplayManifest(id, 320, {
                version: '1.0',
                width: 320,
                height: 180,
                tileWidth: 1,
                tileHeight: 1,
                interval: 10000,
                thumbnailCount: 1,
                format: 'webp',
                storageGeneration: generation,
                sheets: [
                    { index: 0, filename: '0.webp', startTime: 0, endTime: 0, thumbnailCount: 1 },
                ],
            });
        }
        const dirs = await readdir(join(root, id, '320'));
        expect(dirs.filter((d) => generations.includes(d)).sort()).toEqual(
            generations.slice(1).sort(),
        );
        await expect(access(join(root, id, '320', '0.webp'))).rejects.toThrow();
        const failed = randomUUID();
        await storage.saveSpriteSheet(id, 320, 0, Buffer.from('unfinished'), undefined, failed);
        await storage.deleteTrickplayGeneration(id, 320, failed);
        await expect(access(join(root, id, '320', failed))).rejects.toThrow();
        await storage.deleteTrickplayGeneration(id, 320, generations[2]);
        expect((await storage.getSpriteSheet(id, 320, 0))?.toString()).toBe(generations[2]);
        const orphan = join(root, randomUUID(), '320', randomUUID());
        await mkdir(orphan, { recursive: true });
        await writeFile(join(orphan, '0.webp'), 'abandoned');
        const { utimes } = await import('node:fs/promises');
        const old = new Date(Date.now() - 7200000);
        await utimes(join(orphan, '0.webp'), old, old);
        await utimes(orphan, old, old);
        expect(await storage.cleanupOrphanedTrickplay()).toBeGreaterThan(0);
        await expect(access(orphan)).rejects.toThrow();
    });
    it('retains generation bytes when the publication pointer cannot be verified', async () => {
        const storage = await import('./trickplay-storage.service.js');
        const id = randomUUID();
        const generation = randomUUID();
        const file = await storage.saveSpriteSheet(
            id,
            320,
            0,
            Buffer.from('recoverable'),
            undefined,
            generation,
        );
        await writeFile(join(root, id, '320', 'manifest.json'), '{broken');
        await storage.deleteTrickplayGeneration(id, 320, generation);
        expect(await readFile(file, 'utf8')).toBe('recoverable');
    });
    it('serves the previous sheets until the complete new set is published, and retains old bytes', async () => {
        const storage = await import('./trickplay-storage.service.js');
        const id = randomUUID();
        const generation = randomUUID();
        const manifest = {
            version: '1.0',
            width: 320,
            height: 180,
            tileWidth: 10,
            tileHeight: 10,
            interval: 10000,
            thumbnailCount: 100,
            format: 'webp',
            sheets: [
                { index: 0, filename: '0.webp', startTime: 0, endTime: 990, thumbnailCount: 100 },
            ],
        };
        await storage.saveSpriteSheet(id, 320, 0, Buffer.from('old bytes'));
        await storage.saveTrickplayManifest(id, 320, manifest);
        await storage.saveSpriteSheet(id, 320, 0, Buffer.from('new bytes'), undefined, generation);
        expect((await storage.getSpriteSheet(id, 320, 0))?.toString()).toBe('old bytes');
        const incomplete = {
            ...manifest,
            storageGeneration: generation,
            sheets: [
                ...manifest.sheets,
                {
                    index: 1,
                    filename: '1.webp',
                    startTime: 1000,
                    endTime: 1990,
                    thumbnailCount: 100,
                },
            ],
        };
        await expect(storage.saveTrickplayManifest(id, 320, incomplete)).rejects.toThrow(
            'incomplete',
        );
        expect((await storage.getSpriteSheet(id, 320, 0))?.toString()).toBe('old bytes');
        await storage.saveTrickplayManifest(id, 320, {
            ...manifest,
            storageGeneration: generation,
        });
        expect((await storage.getSpriteSheet(id, 320, 0))?.toString()).toBe('new bytes');
        expect(await readFile(join(root, id, '320', '0.webp'), 'utf8')).toBe('old bytes');
        await expect(
            storage.saveSpriteSheet(id, 320, 0, Buffer.from('bad'), undefined, '../escape'),
        ).rejects.toThrow('Invalid');
    });
});

vi.mock('$lib/server/config.js', () => ({
    config: {
        get TRICKPLAY_STORAGE_PATH() {
            return mockConfig.trickplayStoragePath;
        },
        // Trickplay follows its own location; tests flip this per-case.
        get TRICKPLAY_STORAGE_LOCATION() {
            return mockConfig.storageLocation;
        },
        // The metadata-storage resolver reads this when the trickplay override
        // is 'inherit'; keep it consistent with the trickplay location.
        get METADATA_STORAGE_LOCATION() {
            return mockConfig.storageLocation;
        },
    },
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        }),
    },
}));

describe('trickplay storage stats', () => {
    let tempDir = '';

    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'trickplay-storage-'));
        mockConfig.trickplayStoragePath = tempDir;
        mockConfig.storageLocation = 'central';
        vi.resetModules();
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    it('counts file-scoped trickplay directories', async () => {
        await mkdir(join(tempDir, 'file-a', '320'), {
            recursive: true,
        });
        await mkdir(join(tempDir, 'file-b', '480'), {
            recursive: true,
        });

        const fileAManifest = Buffer.from('manifest-a');
        const fileATile = Buffer.from('tile-a');
        const fileBManifest = Buffer.from('manifest-b');

        await writeFile(join(tempDir, 'file-a', '320', 'manifest.json'), fileAManifest);
        await writeFile(join(tempDir, 'file-a', '320', '0.webp'), fileATile);
        await writeFile(join(tempDir, 'file-b', '480', 'manifest.json'), fileBManifest);

        const { getTrickplayStats } = await import('./trickplay-storage.service.js');
        const stats = await getTrickplayStats();

        expect(stats).toEqual({
            totalFiles: 3,
            totalSizeBytes: fileAManifest.length + fileATile.length + fileBManifest.length,
            fileCount: 2,
        });
    });
});

describe('alongside trickplay is keyed by media basename, not fileId', () => {
    let centralDir = '';
    let mediaDir = '';

    beforeEach(async () => {
        centralDir = await mkdtemp(join(tmpdir(), 'trickplay-central-'));
        mediaDir = await mkdtemp(join(tmpdir(), 'trickplay-media-'));
        mockConfig.trickplayStoragePath = centralDir;
        mockConfig.storageLocation = 'alongside';
        vi.resetModules();
    });

    afterEach(async () => {
        await rm(centralDir, { recursive: true, force: true });
        await rm(mediaDir, { recursive: true, force: true });
    });

    it('writes the sidecar under a basename-derived key (never the fileId UUID)', async () => {
        const mediaFilePath = join(mediaDir, 'Show - S05E03 - Halloween.mkv');
        const fileId = 'a8c97f0f-6490-4023-b2e5-15e4c2409853';

        const { saveSpriteSheet } = await import('./trickplay-storage.service.js');
        const written = await saveSpriteSheet(fileId, 320, 0, Buffer.from('tile'), mediaFilePath);

        // Keyed by sha1(basename)[:16], colocated in the media file's directory —
        // NOT `.trickplay/<uuid>/`, which would never match on another instance.
        const expectedKey = createHash('sha1')
            .update('Show - S05E03 - Halloween.mkv')
            .digest('hex')
            .slice(0, 16);
        expect(written).toBe(join(mediaDir, '.trickplay', expectedKey, '320', '0.webp'));
        expect(written).not.toContain(fileId);
    });

    it('lets a different instance (different fileId, same file) read the same sidecar', async () => {
        const mediaFilePath = join(mediaDir, 'Movie (2024).mkv');
        const producerFileId = '11111111-1111-1111-1111-111111111111';
        const consumerFileId = '22222222-2222-2222-2222-222222222222';

        const { saveSpriteSheet, saveTrickplayManifest, getSpriteSheet, hasTrickplay } =
            await import('./trickplay-storage.service.js');

        // Producer writes with ITS fileId.
        await saveSpriteSheet(producerFileId, 320, 0, Buffer.from('sheet-0'), mediaFilePath);
        await saveTrickplayManifest(
            producerFileId,
            320,
            {
                version: '1',
                width: 320,
                height: 180,
                tileWidth: 10,
                tileHeight: 10,
                interval: 10000,
                thumbnailCount: 1,
                format: 'webp',
                sheets: [
                    { index: 0, filename: '0.webp', startTime: 0, endTime: 10, thumbnailCount: 1 },
                ],
            },
            mediaFilePath,
        );

        // Consumer, with a DIFFERENT fileId for the same physical file, finds it.
        const tile = await getSpriteSheet(consumerFileId, 320, 0, mediaFilePath);
        expect(tile?.toString()).toBe('sheet-0');
        expect(await hasTrickplay(consumerFileId, 320, mediaFilePath)).toBe(true);
    });
});

describe('trickplay fileId validation (defense in depth)', () => {
    let tempDir = '';

    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'trickplay-guard-'));
        mockConfig.trickplayStoragePath = tempDir;
        mockConfig.storageLocation = 'central';
        vi.resetModules();
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    // A valid caller-supplied fileId is always a media_files.id UUID by this
    // point (the HLS handlers validate/resolve it against the item before
    // ever reaching this service — see iframe-handler.ts). This guard is
    // defense in depth for any future/other caller that skips that step.
    it('getSpriteSheet rejects a non-UUID-shaped fileId without touching the filesystem', async () => {
        const { getSpriteSheet } = await import('./trickplay-storage.service.js');

        await expect(getSpriteSheet('../../etc/passwd', 320, 0)).rejects.toThrow();

        // "Nothing escaped the storage root" has to be asserted ON the storage
        // root, not on an absolute path built by walking OUT of it. The old
        // check was `access(join(tempDir, '..', '..', 'etc', 'passwd'))`, which
        // on Linux resolves to the REAL /etc/passwd — tmpdir() is /tmp, so two
        // levels up is / — so access() SUCCEEDED and the assertion failed. It
        // only ever passed on macOS, whose tmpdir() is deep enough that the
        // walk lands on nothing. That made it a permanent CI failure and a
        // check that proved nothing about this service either way.
        // A rejected read must simply have created nothing.
        expect(await readdir(tempDir)).toEqual([]);
    });

    it('saveSpriteSheet rejects a non-UUID-shaped fileId, creating nothing outside the storage root', async () => {
        const { saveSpriteSheet } = await import('./trickplay-storage.service.js');

        await expect(
            saveSpriteSheet('../../etc/passwd', 320, 0, Buffer.from('x')),
        ).rejects.toThrow();

        const escaped = join(tempDir, '..', '..', 'etc', 'passwd', '320', '0.webp');
        await expect(access(escaped)).rejects.toThrow();
    });

    it('a well-formed UUID fileId still works normally', async () => {
        const { saveSpriteSheet, getSpriteSheet } = await import('./trickplay-storage.service.js');
        const fileId = 'a8c97f0f-6490-4023-b2e5-15e4c2409853';

        await saveSpriteSheet(fileId, 320, 0, Buffer.from('tile'));
        const tile = await getSpriteSheet(fileId, 320, 0);
        expect(tile?.toString()).toBe('tile');
    });
});
