// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    mkdtemp,
    mkdir,
    readFile,
    rename,
    rm,
    writeFile,
    chmod,
    access,
    stat,
    utimes,
    link,
} from 'node:fs/promises';

import { join } from 'node:path';
import { tmpdir } from 'node:os';

const settings = vi.hoisted(() => ({
    TRICKPLAY_STORAGE_PATH: '',
    TRICKPLAY_STORAGE_LOCATION: 'central',
    METADATA_STORAGE_LOCATION: 'central',
    TRICKPLAY_WIDTH: 320,
    TRICKPLAY_INTERVAL_MS: 10000,
    TRICKPLAY_TILE_WIDTH: 10,
    TRICKPLAY_TILE_HEIGHT: 10,
    TRICKPLAY_QUALITY: 80,
}));
vi.mock('$lib/server/config.js', () => ({ config: settings }));
vi.mock('node:fs/promises', async (original) => {
    const actual = await original<typeof import('node:fs/promises')>();
    return { ...actual, link: vi.fn(actual.link) };
});

import { fingerprintTrickplaySource, reuseTrickplayFiles } from './trickplay-reclaim.service.js';
import {
    getSpriteSheet,
    saveSpriteSheet,
    saveTrickplayManifest,
    type TrickplayManifest,
} from './trickplay-storage.service.js';

const oldId = '11111111-1111-1111-1111-111111111111';
const newId = '22222222-2222-2222-2222-222222222222';

describe('verified trickplay reclaim storage', () => {
    let root: string;
    let oldPath: string;
    let newPath: string;
    let manifest: TrickplayManifest;
    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'trick-reclaim-'));
        settings.TRICKPLAY_STORAGE_PATH = join(root, 'cache');
        settings.TRICKPLAY_STORAGE_LOCATION = 'central';
        settings.TRICKPLAY_QUALITY = 80;
        oldPath = join(root, 'old.mkv');
        newPath = join(root, 'new.mkv');
        await writeFile(oldPath, Buffer.alloc(70000, 1));
        const fingerprint = await fingerprintTrickplaySource(oldPath);
        manifest = {
            version: '1.0',
            width: 320,
            height: 180,
            tileWidth: 10,
            tileHeight: 10,
            interval: 10000,
            thumbnailCount: 1,
            format: 'webp',
            sheets: [{ index: 0, filename: '0.webp', startTime: 0, endTime: 0, thumbnailCount: 1 }],
            reuse: {
                sampledHash: fingerprint.sampledHash,
                mtimeMs: fingerprint.mtimeMs,
                providerId: 'local-trickplay',
                size: fingerprint.size,
                quality: 80,
                spriteQuality: 80,
            },
        };
    });
    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });
    async function publish(): Promise<void> {
        await saveSpriteSheet(oldId, 320, 0, Buffer.from('sprite'), oldPath);
        await saveTrickplayManifest(oldId, 320, manifest, oldPath);
    }
    async function reuse(): Promise<TrickplayManifest | null> {
        return reuseTrickplayFiles(
            { fileId: oldId, filePath: oldPath },
            { fileId: newId, filePath: newPath },
        );
    }
    it('copies a central cache keyed by the old file UUID without stealing it', async () => {
        await publish();
        await rename(oldPath, newPath);
        expect(await reuse()).not.toBeNull();
        expect((await getSpriteSheet(newId, 320, 0, newPath))?.toString()).toBe('sprite');
        expect((await getSpriteSheet(oldId, 320, 0, oldPath))?.toString()).toBe('sprite');
    });
    it('ignores a stale fixed-name manifest tmp left by an interrupted publication', async () => {
        await publish();
        await rename(oldPath, newPath);
        const dest = join(settings.TRICKPLAY_STORAGE_PATH, newId, '320');
        await mkdir(dest, { recursive: true });
        await writeFile(join(dest, 'manifest.json.tmp'), 'stale publication');
        expect(await reuse()).not.toBeNull();
        expect(await readFile(join(dest, 'manifest.json.tmp'), 'utf8')).toBe('stale publication');
        expect((await getSpriteSheet(newId, 320, 0, newPath))?.toString()).toBe('sprite');
    });
    it.each([false, true])(
        'leaves same-folder sidecars alone (tool moves sidecar: %s)',
        async (moved) => {
            settings.TRICKPLAY_STORAGE_LOCATION = 'alongside';
            await publish();
            await rename(oldPath, newPath);
            if (moved) {
                const { createHash } = await import('node:crypto');
                const key = (name: string): string =>
                    createHash('sha1').update(name).digest('hex').slice(0, 16);
                await rename(
                    join(root, '.trickplay', key('old.mkv')),
                    join(root, '.trickplay', key('new.mkv')),
                );
            }
            expect(await reuse()).toBeNull();
        },
    );
    it('leaves sidecars behind across folders/libraries and keeps user files', async () => {
        settings.TRICKPLAY_STORAGE_LOCATION = 'alongside';
        await publish();
        await writeFile(join(root, 'notes.txt'), 'user data');
        await mkdir(join(root, 'another-library'));
        newPath = join(root, 'another-library', 'new.mkv');
        await rename(oldPath, newPath);
        expect(await reuse()).toBeNull();
        expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('user data');
        expect((await getSpriteSheet(oldId, 320, 0, oldPath))?.toString()).toBe('sprite');
    });
    it('does not search a moved sidecar folder', async () => {
        settings.TRICKPLAY_STORAGE_LOCATION = 'alongside';
        await publish();
        await mkdir(join(root, 'new-folder'));
        await rename(join(root, '.trickplay'), join(root, 'new-folder', '.trickplay'));
        newPath = join(root, 'new-folder', 'new.mkv');
        await rename(oldPath, newPath);
        expect(await reuse()).toBeNull();
    });
    it('uses central output on a read-only media share', async () => {
        await publish();
        await rename(oldPath, newPath);
        await chmod(root, 0o555);
        try {
            expect(await reuse()).not.toBeNull();
        } finally {
            await chmod(root, 0o755);
        }
        await expect(access(join(root, '.trickplay'))).rejects.toThrow();
        expect(
            await readFile(join(settings.TRICKPLAY_STORAGE_PATH, newId, '320', '0.webp'), 'utf8'),
        ).toBe('sprite');
    });
    it('hardlinks central sheets first and preserves the source for duplicates', async () => {
        await publish();
        await rename(oldPath, newPath);
        expect(await reuse()).not.toBeNull();
        const source = await stat(join(settings.TRICKPLAY_STORAGE_PATH, oldId, '320', '0.webp'));
        const target = await stat(join(settings.TRICKPLAY_STORAGE_PATH, newId, '320', '0.webp'));
        expect(target.ino).toBe(source.ino);
    });
    it('copies when hardlinks are unavailable without changing the source', async () => {
        await publish();
        await rename(oldPath, newPath);
        vi.mocked(link).mockRejectedValueOnce(
            Object.assign(new Error('cross-device'), { code: 'EXDEV' }),
        );
        expect(await reuse()).not.toBeNull();
        const source = await stat(join(settings.TRICKPLAY_STORAGE_PATH, oldId, '320', '0.webp'));
        const target = await stat(join(settings.TRICKPLAY_STORAGE_PATH, newId, '320', '0.webp'));
        expect(target.ino).not.toBe(source.ino);
        expect((await getSpriteSheet(newId, 320, 0))?.toString()).toBe('sprite');
        expect((await getSpriteSheet(oldId, 320, 0))?.toString()).toBe('sprite');
    });
    it.each([0, 4 * 1024 * 1024, 8 * 1024 * 1024 - 1])(
        'sample detects changed bytes at %s with the same size and mtime',
        async (offset) => {
            const bytes = Buffer.alloc(8 * 1024 * 1024, 1);
            await writeFile(oldPath, bytes);
            await utimes(oldPath, 1000, 1000);
            manifest.reuse = { ...manifest.reuse!, ...(await fingerprintTrickplaySource(oldPath)) };
            await publish();
            await rename(oldPath, newPath);
            bytes[offset] = 2;
            await writeFile(newPath, bytes);
            await utimes(newPath, 1000, 1000);
            expect(await reuse()).toBeNull();
        },
    );
    it('rolls back only files created by a failed copy', async () => {
        manifest.thumbnailCount = 2;
        manifest.sheets.push({ ...manifest.sheets[0]!, index: 1, filename: '1.webp' });
        await publish();
        await saveSpriteSheet(oldId, 320, 1, Buffer.from('second'), oldPath);
        await rename(oldPath, newPath);
        const dest = join(settings.TRICKPLAY_STORAGE_PATH, newId, '320');
        await mkdir(dest, { recursive: true });
        await writeFile(join(dest, '1.webp'), 'someone else');
        expect(await reuse()).toBeNull();
        await expect(access(join(dest, '0.webp'))).rejects.toThrow();
        expect(await readFile(join(dest, '1.webp'), 'utf8')).toBe('someone else');
        await expect(access(join(dest, 'manifest.json'))).rejects.toThrow();
    });
    it('rejects a changed mtime even when bytes match', async () => {
        await publish();
        await rename(oldPath, newPath);
        await utimes(newPath, 1, 1);
        expect(await reuse()).toBeNull();
    });
    it.each(['quality', 'interval', 'width', 'tileWidth', 'tileHeight', 'spriteQuality'])(
        'rejects changed %s',
        async (field) => {
            if (field === 'quality' || field === 'spriteQuality') manifest.reuse![field] = 50;
            else if (field === 'interval') manifest.interval = 5000;
            else manifest[field as 'width' | 'tileWidth' | 'tileHeight'] += 1;
            await publish();
            await rename(oldPath, newPath);
            expect(await reuse()).toBeNull();
        },
    );
    it('rejects different content with the same 64 KB head', async () => {
        await publish();
        await rename(oldPath, newPath);
        const bytes = Buffer.alloc(70000, 1);
        bytes[69999] = 2;
        await writeFile(newPath, bytes);
        expect(await reuse()).toBeNull();
    });
    it('does not import, move or delete Jellyfin/user sidecars without a Lumastra proof', async () => {
        await mkdir(join(root, 'old.trickplay', '320'), { recursive: true });
        await writeFile(join(root, 'old.trickplay', '320', '0.jpg'), 'user sprite');
        await rename(oldPath, newPath);
        expect(await reuse()).toBeNull();
        expect(await readFile(join(root, 'old.trickplay', '320', '0.jpg'), 'utf8')).toBe(
            'user sprite',
        );
    });
    it.each(['legacy', 'missing-sheet', 'empty-sheet', 'partial'])(
        'rejects %s output',
        async (mode) => {
            if (mode === 'legacy') delete manifest.reuse;
            if (mode === 'partial') manifest.thumbnailCount = 2;
            await publish();
            await rename(oldPath, newPath);
            const sheet = join(settings.TRICKPLAY_STORAGE_PATH, oldId, '320', '0.webp');
            if (mode === 'missing-sheet') await rm(sheet);
            if (mode === 'empty-sheet') await writeFile(sheet, '');
            expect(await reuse()).toBeNull();
        },
    );
});
