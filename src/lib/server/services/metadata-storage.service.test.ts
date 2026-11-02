// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, access } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { constants } from 'fs';

const mockConfig = vi.hoisted(() => ({
    strategy: 'central' as 'central' | 'alongside' | 'alongside-prefer',
    basePath: '/config',
}));

vi.mock('$lib/server/config.js', () => ({
    config: {
        get METADATA_STORAGE_LOCATION() {
            return mockConfig.strategy;
        },
        get BASE_PATH() {
            return mockConfig.basePath;
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

describe('metadata-storage.service', () => {
    let tempDir = '';
    let centralDir = '';
    let mediaDir = '';
    let mediaFilePath = '';

    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'metadata-storage-'));
        centralDir = join(tempDir, 'central');
        mediaDir = join(tempDir, 'media');
        await mkdir(mediaDir, { recursive: true });
        mediaFilePath = join(mediaDir, 'video.mkv');
        await writeFile(mediaFilePath, '');
        vi.resetModules();
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    async function loadModule() {
        return import('./metadata-storage.service.js');
    }

    // -----------------------------------------------------------------------
    // resolveWritePath
    // -----------------------------------------------------------------------

    describe('resolveWritePath', () => {
        it('writes to central directory when strategy is "central"', async () => {
            mockConfig.strategy = 'central';
            const { resolveWritePath } = await loadModule();

            const result = await resolveWritePath({
                mediaFilePath,
                centralDir,
                fileName: 'manifest.json',
            });

            expect(result.location).toBe('central');
            expect(result.filePath).toBe(join(centralDir, 'manifest.json'));
        });

        it('writes alongside media when strategy is "alongside"', async () => {
            mockConfig.strategy = 'alongside';
            const { resolveWritePath } = await loadModule();

            const result = await resolveWritePath({
                mediaFilePath,
                centralDir,
                fileName: 'manifest.json',
            });

            expect(result.location).toBe('alongside');
            expect(result.filePath).toBe(join(mediaDir, 'manifest.json'));
        });

        it('writes to alongside subdirectory when specified', async () => {
            mockConfig.strategy = 'alongside';
            const { resolveWritePath } = await loadModule();

            const result = await resolveWritePath({
                mediaFilePath,
                centralDir,
                fileName: '0.webp',
                alongsideSubDir: '.trickplay/abc/320',
            });

            expect(result.location).toBe('alongside');
            expect(result.filePath).toBe(join(mediaDir, '.trickplay', 'abc', '320', '0.webp'));
        });

        it('falls back to central when alongside is not writable in "alongside-prefer"', async () => {
            mockConfig.strategy = 'alongside-prefer';
            const { resolveWritePath } = await loadModule();

            // Use a non-existent root path that can't be created
            const result = await resolveWritePath({
                mediaFilePath: '/nonexistent/readonly/video.mkv',
                centralDir,
                fileName: 'manifest.json',
            });

            expect(result.location).toBe('central');
            expect(result.filePath).toBe(join(centralDir, 'manifest.json'));
        });

        it('falls back to central when no mediaFilePath in "alongside-prefer"', async () => {
            mockConfig.strategy = 'alongside-prefer';
            const { resolveWritePath } = await loadModule();

            const result = await resolveWritePath({
                mediaFilePath: null,
                centralDir,
                fileName: 'manifest.json',
            });

            expect(result.location).toBe('central');
            expect(result.filePath).toBe(join(centralDir, 'manifest.json'));
        });

        it('throws when no mediaFilePath in strict "alongside" mode', async () => {
            mockConfig.strategy = 'alongside';
            const { resolveWritePath } = await loadModule();

            await expect(
                resolveWritePath({
                    mediaFilePath: null,
                    centralDir,
                    fileName: 'manifest.json',
                }),
            ).rejects.toThrow('no media file path');
        });

        it('creates the central directory if it does not exist', async () => {
            mockConfig.strategy = 'central';
            const { resolveWritePath } = await loadModule();
            const deepCentral = join(tempDir, 'deep', 'nested', 'dir');

            await resolveWritePath({
                mediaFilePath,
                centralDir: deepCentral,
                fileName: 'test.json',
            });

            await expect(access(deepCentral, constants.R_OK)).resolves.toBeUndefined();
        });
    });

    // -----------------------------------------------------------------------
    // resolveReadPath
    // -----------------------------------------------------------------------

    describe('resolveReadPath', () => {
        it('finds file in central location', async () => {
            mockConfig.strategy = 'central';
            const { resolveReadPath } = await loadModule();

            await mkdir(centralDir, { recursive: true });
            const filePath = join(centralDir, 'manifest.json');
            await writeFile(filePath, '{}');

            const result = await resolveReadPath({
                mediaFilePath,
                centralDir,
                fileName: 'manifest.json',
            });

            expect(result).toBe(filePath);
        });

        it('finds file in alongside location', async () => {
            mockConfig.strategy = 'alongside';
            const { resolveReadPath } = await loadModule();

            const filePath = join(mediaDir, 'manifest.json');
            await writeFile(filePath, '{}');

            const result = await resolveReadPath({
                mediaFilePath,
                centralDir,
                fileName: 'manifest.json',
            });

            expect(result).toBe(filePath);
        });

        it('probes alongside first when strategy is "alongside-prefer"', async () => {
            mockConfig.strategy = 'alongside-prefer';
            const { resolveReadPath } = await loadModule();

            // Write to both locations
            await mkdir(centralDir, { recursive: true });
            await writeFile(join(centralDir, 'manifest.json'), 'central');
            await writeFile(join(mediaDir, 'manifest.json'), 'alongside');

            const result = await resolveReadPath({
                mediaFilePath,
                centralDir,
                fileName: 'manifest.json',
            });

            // Should prefer alongside
            expect(result).toBe(join(mediaDir, 'manifest.json'));
        });

        it('probes central first when strategy is "central"', async () => {
            mockConfig.strategy = 'central';
            const { resolveReadPath } = await loadModule();

            await mkdir(centralDir, { recursive: true });
            await writeFile(join(centralDir, 'manifest.json'), 'central');
            await writeFile(join(mediaDir, 'manifest.json'), 'alongside');

            const result = await resolveReadPath({
                mediaFilePath,
                centralDir,
                fileName: 'manifest.json',
            });

            expect(result).toBe(join(centralDir, 'manifest.json'));
        });

        it('falls back to alongside when central does not have the file', async () => {
            mockConfig.strategy = 'central';
            const { resolveReadPath } = await loadModule();

            // Only alongside has the file
            await writeFile(join(mediaDir, 'manifest.json'), 'alongside');

            const result = await resolveReadPath({
                mediaFilePath,
                centralDir,
                fileName: 'manifest.json',
            });

            expect(result).toBe(join(mediaDir, 'manifest.json'));
        });

        it('returns null when file is in neither location', async () => {
            mockConfig.strategy = 'central';
            const { resolveReadPath } = await loadModule();

            const result = await resolveReadPath({
                mediaFilePath,
                centralDir,
                fileName: 'manifest.json',
            });

            expect(result).toBeNull();
        });

        it('returns null for alongside when no mediaFilePath', async () => {
            mockConfig.strategy = 'alongside';
            const { resolveReadPath } = await loadModule();

            const result = await resolveReadPath({
                mediaFilePath: null,
                centralDir,
                fileName: 'manifest.json',
            });

            expect(result).toBeNull();
        });

        it('probes alongside subdirectory when specified', async () => {
            mockConfig.strategy = 'alongside-prefer';
            const { resolveReadPath } = await loadModule();

            const subDir = join(mediaDir, '.trickplay', 'abc', '320');
            await mkdir(subDir, { recursive: true });
            await writeFile(join(subDir, '0.webp'), 'sprite');

            const result = await resolveReadPath({
                mediaFilePath,
                centralDir,
                fileName: '0.webp',
                alongsideSubDir: '.trickplay/abc/320',
            });

            expect(result).toBe(join(subDir, '0.webp'));
        });
    });

    // -----------------------------------------------------------------------
    // metadataFileExists
    // -----------------------------------------------------------------------

    describe('metadataFileExists', () => {
        it('returns true when file exists', async () => {
            mockConfig.strategy = 'central';
            const { metadataFileExists } = await loadModule();

            await mkdir(centralDir, { recursive: true });
            await writeFile(join(centralDir, 'test.json'), '{}');

            expect(
                await metadataFileExists({
                    mediaFilePath,
                    centralDir,
                    fileName: 'test.json',
                }),
            ).toBe(true);
        });

        it('returns false when file does not exist', async () => {
            mockConfig.strategy = 'central';
            const { metadataFileExists } = await loadModule();

            expect(
                await metadataFileExists({
                    mediaFilePath,
                    centralDir,
                    fileName: 'test.json',
                }),
            ).toBe(false);
        });
    });

    // -----------------------------------------------------------------------
    // Per-feature strategyOverride (e.g. trickplay diverging from the global)
    // -----------------------------------------------------------------------

    describe('strategyOverride', () => {
        it('writes alongside via override even when the global strategy is "central"', async () => {
            mockConfig.strategy = 'central';
            const { resolveWritePath } = await loadModule();

            const result = await resolveWritePath({
                mediaFilePath,
                centralDir,
                fileName: 'manifest.json',
                strategyOverride: 'alongside',
            });

            expect(result.location).toBe('alongside');
            expect(result.filePath).toBe(join(mediaDir, 'manifest.json'));
        });

        it('writes central via override even when the global strategy is "alongside"', async () => {
            mockConfig.strategy = 'alongside';
            const { resolveWritePath } = await loadModule();

            const result = await resolveWritePath({
                mediaFilePath,
                centralDir,
                fileName: 'manifest.json',
                strategyOverride: 'central',
            });

            expect(result.location).toBe('central');
            expect(result.filePath).toBe(join(centralDir, 'manifest.json'));
        });

        it('throws on override "alongside" with no mediaFilePath (mirrors the global rule)', async () => {
            mockConfig.strategy = 'central';
            const { resolveWritePath } = await loadModule();

            await expect(
                resolveWritePath({
                    mediaFilePath: null,
                    centralDir,
                    fileName: 'manifest.json',
                    strategyOverride: 'alongside',
                }),
            ).rejects.toThrow('no media file path');
        });

        it('read still finds a central file when the override is "alongside" (dual-probe holds)', async () => {
            // Proves flipping trickplay to alongside does NOT orphan files
            // already written to the central location under a prior setting.
            mockConfig.strategy = 'central';
            const { resolveReadPath } = await loadModule();

            await mkdir(centralDir, { recursive: true });
            await writeFile(join(centralDir, 'manifest.json'), 'central');

            const result = await resolveReadPath({
                mediaFilePath,
                centralDir,
                fileName: 'manifest.json',
                strategyOverride: 'alongside',
            });

            expect(result).toBe(join(centralDir, 'manifest.json'));
        });
    });

    // -----------------------------------------------------------------------
    // Invalid strategy fallback
    // -----------------------------------------------------------------------

    describe('invalid strategy', () => {
        it('falls back to central for an unrecognized strategy', async () => {
            mockConfig.strategy = 'bogus' as 'central';
            const { resolveWritePath } = await loadModule();

            const result = await resolveWritePath({
                mediaFilePath,
                centralDir,
                fileName: 'test.json',
            });

            expect(result.location).toBe('central');
        });
    });
});
