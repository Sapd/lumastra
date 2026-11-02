// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '@sapd/lumastra-plugin-sdk';

const { selection } = vi.hoisted(() => ({
    selection: { current: null as unknown },
}));
vi.mock('$lib/server/database/queries/media-file-resolution.queries.js', () => ({
    resolvePlaybackSelection: vi.fn(async () => selection.current),
}));

import { jellyfinDiskTrickplayProvider, readJellyfinDiskThumbnailHeight } from './jellyfin-disk.js';

let root: string;
let videoPath: string;

/** A Jellyfin sheet: full height even when only `filled` tiles are used. */
async function writeSheet(index: number, tileW: number, tileH: number, filled: number) {
    const dir = join(root, 'Show - S01E01.trickplay', `${tileW} - 10x10`);
    await mkdir(dir, { recursive: true });
    const tiles = Array.from({ length: filled }, (_, i) => ({
        input: {
            create: { width: tileW, height: tileH, channels: 3 as const, background: '#888' },
        },
        left: (i % 10) * tileW,
        top: Math.floor(i / 10) * tileH,
    }));
    await sharp({
        create: { width: tileW * 10, height: tileH * 10, channels: 3, background: '#000' },
    })
        .composite(tiles)
        .jpeg()
        .toFile(join(dir, `${index}.jpg`));
}

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'jf-trickplay-'));
    videoPath = join(root, 'Show - S01E01.mkv');
    await writeFile(videoPath, '');
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe('jellyfin-disk thumbnail height', () => {
    it('reports the 4:3 tile height of the sheets, not a 16:9 guess', async () => {
        await writeSheet(0, 320, 240, 100);
        await writeSheet(1, 320, 240, 30);
        selection.current = {
            fileId: 'f1',
            files: [{ id: 'f1', file_path: videoPath, duration_seconds: 1289 }],
        };
        const ctx = {
            sql: vi.fn(),
            logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        } as unknown as PluginContext;

        const found = await jellyfinDiskTrickplayProvider.discoverParams!(ctx, {
            mediaItemId: 'm1',
        });

        expect(found).toHaveLength(1);
        expect(found![0].params.thumbnailHeight).toBe(240);
    });

    it('reads the height from the first sheet header', async () => {
        await writeSheet(0, 320, 134, 100);
        await expect(readJellyfinDiskThumbnailHeight(videoPath, 320)).resolves.toBe(134);
    });

    it('returns null when the width or the sheet is missing', async () => {
        await writeSheet(0, 320, 240, 100);
        await expect(readJellyfinDiskThumbnailHeight(videoPath, 480)).resolves.toBeNull();
        await expect(
            readJellyfinDiskThumbnailHeight(join(root, 'Other.mkv'), 320),
        ).resolves.toBeNull();
    });
});
