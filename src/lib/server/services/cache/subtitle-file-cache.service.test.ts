// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SubtitleFileCacheService — byte-budget eviction + legacy-dir migration.
 *
 * cleanup() previously only deleted TTL-expired files, so a directory full of
 * fresh-mtime (never-stale) subtitle files could grow without bound. These
 * tests seed the cache dir directly on disk (mirroring
 * preview-cache.store.test.ts) and assert cleanup() enforces
 * config.SUBTITLE_CACHE_MAX_BYTES with coldest-first eviction.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    mkdtempSync,
    rmSync,
    writeFileSync,
    mkdirSync,
    existsSync,
    utimesSync,
    chmodSync,
    readdirSync,
    readFileSync,
    statSync,
    symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('$lib/server/config.js', () => ({
    config: {
        get SUBTITLE_CACHE_MAX_BYTES() {
            return mockMaxBytes;
        },
        get SUBTITLE_STORAGE_LOCATION() {
            return mockSubtitleLocation;
        },
        get METADATA_STORAGE_LOCATION() {
            return mockMetadataLocation;
        },
    },
}));

// No database: containment roots are the caller's own (contained-fs).
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => null }));

let mockMaxBytes = 0;
let mockSubtitleLocation: 'inherit' | 'central' | 'alongside' | 'alongside-prefer' = 'inherit';
let mockMetadataLocation: 'central' | 'alongside' | 'alongside-prefer' = 'central';
let root: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'subcache-'));
    mockMaxBytes = 0;
    mockSubtitleLocation = 'inherit';
    mockMetadataLocation = 'central';
});

afterEach(async () => {
    const { SubtitleFileCacheService } = await import('./subtitle-file-cache.service.js');
    SubtitleFileCacheService._setCacheDirForTesting(null);
    rmSync(root, { recursive: true, force: true });
});

/** Write a file with a specific mtime so ordering is deterministic. */
function seedFile(dir: string, name: string, bytes: number, mtime: Date): void {
    writeFileSync(join(dir, name), Buffer.alloc(bytes, 'x'));
    utimesSync(join(dir, name), mtime, mtime);
}

describe('SubtitleFileCacheService.cleanup — byte budget', () => {
    it('evicts coldest-first when total exceeds SUBTITLE_CACHE_MAX_BYTES, newest files survive', async () => {
        const { SubtitleFileCacheService } = await import('./subtitle-file-cache.service.js');
        SubtitleFileCacheService._setCacheDirForTesting(root);

        const now = Date.now();
        // Four 100-byte files, all fresh (well under the 7d/90d TTL), each
        // one minute newer than the last.
        seedFile(root, 'a_0.vtt', 100, new Date(now - 4 * 60_000));
        seedFile(root, 'b_0.vtt', 100, new Date(now - 3 * 60_000));
        seedFile(root, 'c_0.vtt', 100, new Date(now - 2 * 60_000));
        seedFile(root, 'd_0.vtt', 100, new Date(now - 1 * 60_000));

        mockMaxBytes = 250; // budget only fits 2 of the 4 files

        await SubtitleFileCacheService.cleanup();

        const stats = await SubtitleFileCacheService.getStatistics();
        expect(stats.totalSizeBytes).toBeLessThanOrEqual(250);
        // Coldest-first eviction: the two oldest must be gone, the two
        // newest must survive.
        expect(existsSync(join(root, 'a_0.vtt'))).toBe(false);
        expect(existsSync(join(root, 'b_0.vtt'))).toBe(false);
        expect(existsSync(join(root, 'c_0.vtt'))).toBe(true);
        expect(existsSync(join(root, 'd_0.vtt'))).toBe(true);
    });

    it('does nothing when total is already under budget', async () => {
        const { SubtitleFileCacheService } = await import('./subtitle-file-cache.service.js');
        SubtitleFileCacheService._setCacheDirForTesting(root);

        seedFile(root, 'a_0.vtt', 100, new Date());
        mockMaxBytes = 10_000;

        const deleted = await SubtitleFileCacheService.cleanup();

        expect(deleted).toBe(0);
        expect(existsSync(join(root, 'a_0.vtt'))).toBe(true);
    });

    it('budget of 0 disables budget enforcement (TTL-only cleanup)', async () => {
        const { SubtitleFileCacheService } = await import('./subtitle-file-cache.service.js');
        SubtitleFileCacheService._setCacheDirForTesting(root);

        seedFile(root, 'a_0.vtt', 100, new Date());
        seedFile(root, 'b_0.vtt', 100, new Date());
        mockMaxBytes = 0;

        await SubtitleFileCacheService.cleanup();

        expect(existsSync(join(root, 'a_0.vtt'))).toBe(true);
        expect(existsSync(join(root, 'b_0.vtt'))).toBe(true);
    });
});

describe('SubtitleFileCacheService cache directory — legacy migration', () => {
    let cwdSpy: ReturnType<typeof vi.spyOn>;
    let fakeCwd: string;

    beforeEach(() => {
        fakeCwd = mkdtempSync(join(tmpdir(), 'subcache-cwd-'));
        cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(fakeCwd);
    });

    afterEach(() => {
        cwdSpy.mockRestore();
        rmSync(fakeCwd, { recursive: true, force: true });
    });

    it('uses the legacy cache/subtitles dir when it holds files and .cache/subtitles does not exist', async () => {
        const { SubtitleFileCacheService } = await import('./subtitle-file-cache.service.js');
        SubtitleFileCacheService._setCacheDirForTesting(null);
        SubtitleFileCacheService._resetCacheDirResolutionForTesting();

        const legacyDir = join(fakeCwd, 'cache', 'subtitles');
        mkdirSync(legacyDir, { recursive: true });
        writeFileSync(join(legacyDir, 'old_0.vtt'), 'WEBVTT');

        await SubtitleFileCacheService.set('media1', 0, 'hello');

        expect(existsSync(join(legacyDir, 'media1_0.vtt'))).toBe(true);
    });

    // Startup used to mkdir the legacy dir unconditionally, so every fresh
    // container saw an EMPTY legacy dir and no new dir, and pinned the cache to
    // the unmounted path: per-replica, and wiped on every deploy.
    it('ignores an EMPTY legacy dir and uses .cache/subtitles', async () => {
        const { SubtitleFileCacheService } = await import('./subtitle-file-cache.service.js');
        SubtitleFileCacheService._setCacheDirForTesting(null);
        SubtitleFileCacheService._resetCacheDirResolutionForTesting();

        mkdirSync(join(fakeCwd, 'cache', 'subtitles'), { recursive: true });

        await SubtitleFileCacheService.set('media3', 0, 'hello');

        expect(existsSync(join(fakeCwd, '.cache', 'subtitles', 'media3_0.vtt'))).toBe(true);
        expect(existsSync(join(fakeCwd, 'cache', 'subtitles', 'media3_0.vtt'))).toBe(false);
    });

    it('uses the new .cache/subtitles dir when neither dir exists yet', async () => {
        const { SubtitleFileCacheService } = await import('./subtitle-file-cache.service.js');
        SubtitleFileCacheService._setCacheDirForTesting(null);
        SubtitleFileCacheService._resetCacheDirResolutionForTesting();

        await SubtitleFileCacheService.set('media2', 0, 'hello');

        expect(existsSync(join(fakeCwd, '.cache', 'subtitles', 'media2_0.vtt'))).toBe(true);
        expect(existsSync(join(fakeCwd, 'cache', 'subtitles', 'media2_0.vtt'))).toBe(false);
    });
});

describe('SubtitleFileCacheService — bitmap subtitles are kept, not expired', () => {
    const YEAR_AGO = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);

    it('serves a binary entry of any age when it postdates the probe', async () => {
        const { SubtitleFileCacheService } = await import('./subtitle-file-cache.service.js');
        SubtitleFileCacheService._setCacheDirForTesting(root);
        seedFile(root, 'item_file_3.render', 10, YEAR_AGO);

        const probedBefore = new Date(YEAR_AGO.getTime() - 1000);
        const hit = await SubtitleFileCacheService.getBinary(
            'item_file',
            3,
            'render',
            probedBefore,
        );

        expect(hit?.length).toBe(10);
    });

    it('still retires a binary entry written before the file was re-probed', async () => {
        const { SubtitleFileCacheService } = await import('./subtitle-file-cache.service.js');
        SubtitleFileCacheService._setCacheDirForTesting(root);
        seedFile(root, 'item_file_3.sup', 10, YEAR_AGO);

        expect(
            await SubtitleFileCacheService.getBinary('item_file', 3, 'sup', new Date()),
        ).toBeNull();
        expect(existsSync(join(root, 'item_file_3.sup'))).toBe(false);
    });

    it('the sweep ages out text but never binary', async () => {
        const { SubtitleFileCacheService } = await import('./subtitle-file-cache.service.js');
        SubtitleFileCacheService._setCacheDirForTesting(root);
        seedFile(root, 'item_file_2.vtt', 10, YEAR_AGO);
        for (const ext of ['sup', 'sub', 'render'])
            seedFile(root, `item_file_3.${ext}`, 10, YEAR_AGO);

        await SubtitleFileCacheService.cleanup();

        expect(readdirSync(root).sort()).toEqual([
            'item_file_3.render',
            'item_file_3.sub',
            'item_file_3.sup',
        ]);
    });
});

describe('SubtitleFileCacheService — alongside-media storage', () => {
    let mediaDir: string;
    let mediaFile: string;

    beforeEach(() => {
        mediaDir = join(root, 'media', 'Film (1999)');
        mkdirSync(mediaDir, { recursive: true });
        mediaFile = join(mediaDir, 'Film (1999).mkv');
        writeFileSync(mediaFile, '');
    });

    afterEach(() => {
        chmodSync(mediaDir, 0o755);
    });

    async function service() {
        const { SubtitleFileCacheService } = await import('./subtitle-file-cache.service.js');
        const central = join(root, 'central');
        SubtitleFileCacheService._setCacheDirForTesting(central);
        return { SubtitleFileCacheService, central };
    }

    function alongsideFiles(): string[] {
        const dir = join(mediaDir, '.subtitle-cache');
        if (!existsSync(dir)) return [];
        return readdirSync(dir).flatMap((key) => readdirSync(join(dir, key)));
    }

    it("inherits METADATA_STORAGE_LOCATION: 'alongside' writes next to the media", async () => {
        mockMetadataLocation = 'alongside';
        const { SubtitleFileCacheService, central } = await service();

        await SubtitleFileCacheService.setBinary(
            'item_file',
            3,
            'sup',
            Buffer.from('PG'),
            mediaFile,
        );

        expect(alongsideFiles()).toEqual(['3.sup']);
        expect(existsSync(join(central, 'item_file_3.sup'))).toBe(false);
        const hit = await SubtitleFileCacheService.getBinary(
            'item_file',
            3,
            'sup',
            null,
            mediaFile,
        );
        expect(hit?.toString()).toBe('PG');
    });

    it('its own setting overrides the inherited one', async () => {
        mockMetadataLocation = 'alongside';
        mockSubtitleLocation = 'central';
        const { SubtitleFileCacheService, central } = await service();

        await SubtitleFileCacheService.setBinary(
            'item_file',
            3,
            'sup',
            Buffer.from('PG'),
            mediaFile,
        );

        expect(alongsideFiles()).toEqual([]);
        expect(existsSync(join(central, 'item_file_3.sup'))).toBe(true);
    });

    it('reads check both locations whatever the setting, so switching orphans nothing', async () => {
        mockSubtitleLocation = 'alongside';
        const { SubtitleFileCacheService } = await service();
        await SubtitleFileCacheService.setBinary(
            'item_file',
            3,
            'sup',
            Buffer.from('PG'),
            mediaFile,
        );

        mockSubtitleLocation = 'central';
        expect(
            await SubtitleFileCacheService.hasFreshBinary('item_file', 3, 'sup', null, mediaFile),
        ).toBe(true);
        const hit = await SubtitleFileCacheService.getBinary(
            'item_file',
            3,
            'sup',
            null,
            mediaFile,
        );
        expect(hit?.toString()).toBe('PG');
    });

    it('an alongside entry swapped for a link after it was written is not served', async () => {
        mockSubtitleLocation = 'alongside';
        const { SubtitleFileCacheService } = await service();
        await SubtitleFileCacheService.setBinary(
            'item_file',
            3,
            'sup',
            Buffer.from('PG'),
            mediaFile,
        );
        const secretDir = join(root, 'config');
        mkdirSync(secretDir);
        const secret = join(secretDir, 'master.key');
        writeFileSync(secret, 'TESTKEY-123');
        const old = new Date(Date.now() - 3_600_000);
        utimesSync(secret, old, old);
        const entryDir = join(
            mediaDir,
            '.subtitle-cache',
            readdirSync(join(mediaDir, '.subtitle-cache'))[0],
        );
        rmSync(join(entryDir, '3.sup'));
        symlinkSync(secret, join(entryDir, '3.sup'));

        const hit = await SubtitleFileCacheService.getBinary(
            'item_file',
            3,
            'sup',
            new Date(0),
            mediaFile,
        );
        expect(hit).toBeNull();
        // The validated-read touch must not reach the link target either.
        // Rounded: some filesystems report mtimeMs with a sub-millisecond float error.
        expect(Math.round(statSync(secret).mtimeMs)).toBe(old.getTime());
    });

    it("'alongside-prefer' falls back to central when the media folder is read-only", async () => {
        mockSubtitleLocation = 'alongside-prefer';
        const { SubtitleFileCacheService, central } = await service();
        chmodSync(mediaDir, 0o555);

        await SubtitleFileCacheService.setBinary(
            'item_file',
            3,
            'sup',
            Buffer.from('PG'),
            mediaFile,
        );

        expect(existsSync(join(central, 'item_file_3.sup'))).toBe(true);
    });

    it('uses central when there is no media path to sit next to, even under strict alongside', async () => {
        mockSubtitleLocation = 'alongside';
        const { SubtitleFileCacheService, central } = await service();

        await SubtitleFileCacheService.setBinary('item_file', 3, 'sup', Buffer.from('PG'), null);

        expect(existsSync(join(central, 'item_file_3.sup'))).toBe(true);
    });

    it('a write prunes subtitle folders whose video is gone, and keeps live siblings', async () => {
        mockSubtitleLocation = 'alongside';
        const { SubtitleFileCacheService } = await service();
        const renamedAway = join(mediaDir, 'Old Name.mkv');
        const sibling = join(mediaDir, 'Film (1999) - Extended.mkv');
        writeFileSync(sibling, '');
        await SubtitleFileCacheService.setBinary('old', 3, 'sup', Buffer.from('PG'), renamedAway);
        await SubtitleFileCacheService.setBinary('sib', 3, 'sup', Buffer.from('PG'), sibling);

        // 'Old Name.mkv' never existed on disk: its folder is an orphan.
        await SubtitleFileCacheService.setBinary(
            'item_file',
            3,
            'sup',
            Buffer.from('PG'),
            mediaFile,
        );

        expect(
            await SubtitleFileCacheService.hasFreshBinary('old', 3, 'sup', null, renamedAway),
        ).toBe(false);
        expect(await SubtitleFileCacheService.hasFreshBinary('sib', 3, 'sup', null, sibling)).toBe(
            true,
        );
        expect(
            await SubtitleFileCacheService.hasFreshBinary('item_file', 3, 'sup', null, mediaFile),
        ).toBe(true);
    });

    it("'alongside' refuses to fall back to central", async () => {
        mockSubtitleLocation = 'alongside';
        const { SubtitleFileCacheService, central } = await service();
        chmodSync(mediaDir, 0o555);

        await expect(
            SubtitleFileCacheService.setBinary('item_file', 3, 'sup', Buffer.from('PG'), mediaFile),
        ).rejects.toThrow();
        expect(existsSync(join(central, 'item_file_3.sup'))).toBe(false);
    });

    it("deleteAlongside removes that file's subtitles and leaves a sibling film alone", async () => {
        mockSubtitleLocation = 'alongside';
        const { SubtitleFileCacheService } = await service();
        const other = join(mediaDir, 'Film (1999) - Extended.mkv');
        writeFileSync(other, '');
        await SubtitleFileCacheService.setBinary('a', 3, 'sup', Buffer.from('PG'), mediaFile);
        await SubtitleFileCacheService.setBinary('b', 3, 'sup', Buffer.from('PG'), other);

        await SubtitleFileCacheService.deleteAlongside(mediaFile);

        expect(await SubtitleFileCacheService.hasFreshBinary('a', 3, 'sup', null, mediaFile)).toBe(
            false,
        );
        expect(await SubtitleFileCacheService.hasFreshBinary('b', 3, 'sup', null, other)).toBe(
            true,
        );
    });
});

describe('SubtitleFileCacheService — temp files', () => {
    it('concurrent set() calls in the same millisecond do not share a temp path', async () => {
        const { SubtitleFileCacheService } = await import('./subtitle-file-cache.service.js');
        SubtitleFileCacheService._setCacheDirForTesting(root);
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_791_839_104_833);
        try {
            await Promise.all([
                SubtitleFileCacheService.set('src-1', 3, 'WEBVTT\n\nfirst'),
                SubtitleFileCacheService.set('src-1', 3, 'WEBVTT\n\nsecond'),
            ]);
        } finally {
            nowSpy.mockRestore();
        }
        const files = readdirSync(root);
        expect(files.filter((f) => f.includes('.tmp'))).toEqual([]);
        const final = files.filter((f) => f.endsWith('.vtt'));
        expect(final).toHaveLength(1);
        const content = readFileSync(join(root, final[0]), 'utf-8');
        expect(['WEBVTT\n\nfirst', 'WEBVTT\n\nsecond']).toContain(content);
    });

    it('cleanup() keeps a fresh .tmp file and deletes one older than the grace period', async () => {
        const { SubtitleFileCacheService } = await import('./subtitle-file-cache.service.js');
        SubtitleFileCacheService._setCacheDirForTesting(root);
        const now = Date.now();
        seedFile(root, 'a_3.vtt.tmp.8.fresh', 10, new Date(now - 30_000));
        seedFile(root, 'b_3.vtt.tmp.8.stale', 10, new Date(now - 11 * 60_000));

        const deleted = await SubtitleFileCacheService.cleanup();

        expect(deleted).toBe(1);
        expect(existsSync(join(root, 'a_3.vtt.tmp.8.fresh'))).toBe(true);
        expect(existsSync(join(root, 'b_3.vtt.tmp.8.stale'))).toBe(false);
    });
});
