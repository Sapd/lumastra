// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    mkdtemp,
    mkdir,
    writeFile,
    symlink,
    readFile,
    readdir,
    rm,
    lstat,
    chmod,
    realpath as realpathOf,
} from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    ContainmentError,
    isSensitivePath,
    readContainedFile,
    resolveContainedMediaFile,
    setSensitivePrefixesForTests,
    resolveContainedFile,
    writeFileNoFollow,
} from './contained-fs.js';

// No database in unit tests: only the caller-supplied roots count.
vi.mock('../database/connection.js', () => ({ getDb: () => null }));

describe('isSensitivePath', () => {
    const prefixes = [
        '/config',
        '/proc',
        '/sys',
        '/dev',
        '/etc',
        '/root',
        '/run/secrets',
        '/var/run/secrets',
        '/app',
    ];
    it.each([
        ['/config/master.key', true],
        ['/config', true],
        ['/proc/self/environ', true],
        ['/sys/kernel/x', true],
        ['/dev/zero', true],
        ['/etc/shadow', true],
        ['/root/.ssh/id', true],
        ['/run/secrets/db_password', true],
        ['/var/run/secrets/kubernetes.io/token', true],
        ['/app/src/x.ts', true],
        ['/configs/other.mkv', false],
        ['/mnt/debrid/movie.mkv', false],
        ['/data/movies/a.mkv', false],
        ['/etcetera/a.mkv', false],
        // native installs and USB mounts are legitimate media targets
        ['/home/media/movies/a.mkv', false],
        ['/run/media/user/usb/a.mkv', false],
    ])('%s -> %s', (p, expected) => {
        expect(isSensitivePath(p, prefixes)).toBe(expected);
    });
});

describe('contained-fs', () => {
    let root: string;
    let outside: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'cfs-lib-'));
        outside = await mkdtemp(join(tmpdir(), 'cfs-out-'));
        await writeFile(join(outside, 'secret.key'), 'TESTKEY-123');
    });
    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
    });

    describe('read side', () => {
        it('reads a regular file', async () => {
            await writeFile(join(root, 'a.txt'), 'hello');
            expect((await readContainedFile(join(root, 'a.txt'))).toString()).toBe('hello');
        });

        it.runIf(process.platform === 'linux')(
            'validates the actual opened descriptor before reading',
            async () => {
                const file = join(root, 'a.txt');
                await writeFile(file, 'hello');
                const canonical = await realpathOf(file);
                const validateOpenedFile = vi.fn((actualPath: string) => actualPath === canonical);
                expect((await readContainedFile(file, { validateOpenedFile })).toString()).toBe(
                    'hello',
                );
                expect(validateOpenedFile).toHaveBeenCalledWith(canonical);
                await expect(
                    readContainedFile(file, { validateOpenedFile: () => false }),
                ).rejects.toBeInstanceOf(ContainmentError);
            },
        );

        it.runIf(process.platform !== 'linux')(
            'fails closed when descriptor validation has no Linux procfs',
            async () => {
                const file = join(root, 'a.txt');
                await writeFile(file, 'hello');
                await expect(
                    readContainedFile(file, { validateOpenedFile: () => true }),
                ).rejects.toBeInstanceOf(ContainmentError);
            },
        );

        it('refuses a symlink to a file outside the roots (planted Track.txt -> secret)', async () => {
            await symlink(join(outside, 'secret.key'), join(root, 'Track.txt'));
            await expect(
                readContainedFile(join(root, 'Track.txt'), { extraRoots: [root] }),
            ).rejects.toBeInstanceOf(ContainmentError);
            expect(await resolveContainedFile(join(root, 'Track.txt'), [root])).toBeNull();
        });

        it('follows a symlink to another file inside an allowed root', async () => {
            await mkdir(join(root, 'store'));
            await writeFile(join(root, 'store', 'real.txt'), 'in-library');
            await symlink(join(root, 'store', 'real.txt'), join(root, 'alias.txt'));
            const buf = await readContainedFile(join(root, 'alias.txt'), { extraRoots: [root] });
            expect(buf.toString()).toBe('in-library');
        });

        it('allows a symlink into a second root passed by the caller', async () => {
            await symlink(join(outside, 'secret.key'), join(root, 'alias.txt'));
            expect(
                await resolveContainedFile(join(root, 'alias.txt'), [root, outside]),
            ).not.toBeNull();
        });

        it('refuses directories and oversize files', async () => {
            await mkdir(join(root, 'dir'));
            expect(await resolveContainedFile(join(root, 'dir'), [root])).toBeNull();
            await writeFile(join(root, 'big.txt'), 'x'.repeat(100));
            await expect(
                readContainedFile(join(root, 'big.txt'), { maxBytes: 10 }),
            ).rejects.toBeInstanceOf(ContainmentError);
        });

        it('refuses a FIFO without blocking', async () => {
            const fifo = join(root, 'pipe.txt');
            execFileSync('mkfifo', [fifo]);
            expect(await resolveContainedFile(fifo, [root])).toBeNull();
            await expect(readContainedFile(fifo, { extraRoots: [root] })).rejects.toBeInstanceOf(
                ContainmentError,
            );
        });

        it('keeps ENOENT as ENOENT', async () => {
            await expect(readContainedFile(join(root, 'missing.txt'))).rejects.toMatchObject({
                code: 'ENOENT',
            });
        });
    });

    describe('media symlinks', () => {
        it('follow to a mount outside the roots', async () => {
            await writeFile(join(outside, 'movie.mkv'), 'x');
            await symlink(join(outside, 'movie.mkv'), join(root, 'Movie.mkv'));
            expect(await resolveContainedMediaFile(join(root, 'Movie.mkv'), [root])).not.toBeNull();
        });

        it('are refused under a sensitive prefix', async () => {
            setSensitivePrefixesForTests([outside]);
            try {
                await symlink(join(outside, 'secret.key'), join(root, '01.mp3'));
                expect(await resolveContainedMediaFile(join(root, '01.mp3'), [root])).toBeNull();
            } finally {
                setSensitivePrefixesForTests([]);
            }
        });

        it('are refused when the target is not a regular file', async () => {
            await symlink(outside, join(root, 'dirlink.mkv'));
            expect(await resolveContainedMediaFile(join(root, 'dirlink.mkv'), [root])).toBeNull();
        });
    });

    // A path stored in the DB at scan time is served later: by then the file, or a
    // directory on the way to it, may have been swapped for a link.
    describe('DB-stored paths (parents: true)', () => {
        it('refuses a file swapped for a symlink after the scan', async () => {
            const p = join(root, 'Movie.mkv');
            await writeFile(p, 'x');
            expect(await resolveContainedMediaFile(p, [root], { parents: true })).toBe(
                await realpathOf(p),
            );
            await rm(p);
            setSensitivePrefixesForTests([outside]);
            try {
                await symlink(join(outside, 'secret.key'), p);
                expect(await resolveContainedMediaFile(p, [root], { parents: true })).toBeNull();
                expect(await resolveContainedFile(p, [root], { parents: true })).toBeNull();
            } finally {
                setSensitivePrefixesForTests([]);
            }
        });

        it('refuses a file under a directory swapped for a link into a sensitive dir', async () => {
            await mkdir(join(root, 'Show'));
            await writeFile(join(root, 'Show', 'secret.key'), 'x');
            const p = join(root, 'Show', 'secret.key');
            expect(await resolveContainedFile(p, [root], { parents: true })).toBe(
                await realpathOf(p),
            );
            await rm(join(root, 'Show'), { recursive: true });
            await symlink(outside, join(root, 'Show'));
            setSensitivePrefixesForTests([outside]);
            try {
                expect(await resolveContainedFile(p, [root], { parents: true })).toBeNull();
                expect(await resolveContainedMediaFile(p, [root], { parents: true })).toBeNull();
                await expect(
                    readContainedFile(p, { extraRoots: [root], parents: true }),
                ).rejects.toBeInstanceOf(ContainmentError);
                // Without `parents` only the final component is checked (scan-time callers).
                expect(await resolveContainedFile(p, [root])).toBe(p);
            } finally {
                setSensitivePrefixesForTests([]);
            }
        });

        it('follows a directory link inside the roots or to a non-sensitive mount', async () => {
            await mkdir(join(root, 'store'));
            await writeFile(join(root, 'store', 'a.srt'), 'in-library');
            await symlink(join(root, 'store'), join(root, 'Show'));
            const viaRoot = await resolveContainedFile(join(root, 'Show', 'a.srt'), [root], {
                parents: true,
            });
            expect(viaRoot).toBe(await realpathOf(join(root, 'store', 'a.srt')));

            await writeFile(join(outside, 'b.mkv'), 'x');
            await symlink(outside, join(root, 'Nas'));
            expect(
                await resolveContainedMediaFile(join(root, 'Nas', 'b.mkv'), [root], {
                    parents: true,
                }),
            ).toBe(await realpathOf(join(outside, 'b.mkv')));
        });

        it('reads a plain file unchanged', async () => {
            await writeFile(join(root, 'a.txt'), 'hello');
            const buf = await readContainedFile(join(root, 'a.txt'), {
                extraRoots: [root],
                parents: true,
            });
            expect(buf.toString()).toBe('hello');
        });
    });

    describe('write side', () => {
        it('does not write through a planted symlink; the link is replaced', async () => {
            const target = join(outside, 'secret.key');
            await symlink(target, join(root, 'poster.jpg'));
            await writeFileNoFollow(join(root, 'poster.jpg'), 'IMAGE-BYTES');
            expect(await readFile(target, 'utf8')).toBe('TESTKEY-123');
            expect((await lstat(join(root, 'poster.jpg'))).isSymbolicLink()).toBe(false);
            expect(await readFile(join(root, 'poster.jpg'), 'utf8')).toBe('IMAGE-BYTES');
        });

        it('handles a long non-ASCII basename (temp name is short and fixed-length)', async () => {
            const name = `${'ü'.repeat(120)}.json`; // 240 bytes
            await writeFileNoFollow(join(root, name), 'x');
            expect(await readFile(join(root, name), 'utf8')).toBe('x');
            expect(await readdir(root)).toEqual([name]);
        });

        it('keeps the mode of the file it replaces', async () => {
            await writeFile(join(root, 'm.json'), 'old', { mode: 0o600 });
            await chmod(join(root, 'm.json'), 0o600);
            await writeFileNoFollow(join(root, 'm.json'), 'new');
            expect((await lstat(join(root, 'm.json'))).mode & 0o777).toBe(0o600);
        });

        it('overwrites a regular file and leaves no temp file behind', async () => {
            await writeFile(join(root, 'm.json'), 'old');
            await writeFileNoFollow(join(root, 'm.json'), Buffer.from('new'));
            expect(await readFile(join(root, 'm.json'), 'utf8')).toBe('new');
            expect(await readdir(root)).toEqual(['m.json']);
        });
    });
});

// ---------------------------------------------------------------------------
// Class guard: every raw read of a path under src/lib/server or src/routes is
// either one of the allowlisted files below (each with the reason it is not a
// library-derived path) or goes through the containment helpers. A NEW file
// with a raw readFile/createReadStream/open fails here and must be routed
// through readContainedFile / readSidecarText, or be added with a reason.
// ---------------------------------------------------------------------------

const SERVER_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ROUTES_DIR = resolve(SERVER_DIR, '../../routes');

const RAW_READ = /\b(?:safeReadFile|readFile|createReadStream|fsOpen|open)\(/;

/** Paths are app-owned (HLS/transcode/cache/config/tmp dirs), never a library sidecar. */
const APP_OWNED = [
    'ai/batch-embeddings.ts',
    'api/defs/admin/fix/host-pressure.ts',
    'config/config.service.ts',
    'handlers/hls/lumastra-segment-handler.ts',
    'middleware/immutable-asset-fallback.ts',
    'jellyfin-compat/video-attachments.ts', // reads ffmpeg's own mkdtemp output
    'services/cluster-node-runtime.ts',
    'services/essentia-analysis.service.ts',
    'services/ffmpeg-transcode.service.ts',
    'services/frame-candidate.service.ts',
    'services/hls/gop-segment-assembler.ts',
    'services/hls/job-restoration.ts',
    'services/hls/muxed-root-asset.ts',
    'services/hls/output-marker.ts',
    'services/hls/segment-action-executor.ts',
    'services/hls/segment-file-responder.ts',
    'services/hls/tail-run.ts',
    'services/hls/vod-playlist.ts',
    'services/image-proxy/cache.ts',
    'services/library-backdrop.service.ts',
    'services/music/cover-collage.service.ts',
    'services/music-transcode/progressive.ts',
    'services/music-transcode/route-handler.ts',
    'services/music-transcode/service.ts',
    'services/topshelf/topshelf-artifact.store.ts',
    'services/transcoding/file-manager.ts',
    'services/transcoding/seek-controller.ts',
    'services/transcoding/transcode-failure-classifier.ts',
    'services/trickplay-generator.service.ts',
    'utils/ffmpeg-analysis.ts',
    'utils/ffmpeg-subtitle-extractor.ts',
    'utils/file-hash.ts',
    'utils/hls-request-utils.ts',
    'utils/http-range.ts',
    'utils/placeholder-image.ts',
    'utils/synthetic-iframe.ts',
    'routes/admin/system/instance/+page.server.ts',
    'routes/api/setup/gpu-detect/+server.ts',
];

/** Reads of library MEDIA files by DB path (ingest guards the link at scan time); not sidecars. */
const MEDIA_FILE_READS = [
    'services/upload-session.service.ts',
    'services/transcoding/input-guard.ts',
    'tasks/builtin/native/media-sources/_helpers/file-scanner/vorbis-raw-reader.ts',
    'utils/file-streaming.ts',
    'utils/playlist-sniff.ts',
];

/** The helpers themselves. */
const HELPERS = ['utils/contained-fs.ts', 'utils/safe-fs.ts'];

const ALLOWED_RAW = new Set([...APP_OWNED, ...MEDIA_FILE_READS, ...HELPERS]);

function serverSource(rel: string): string {
    const full = rel.startsWith('routes/')
        ? join(ROUTES_DIR, rel.slice('routes/'.length))
        : join(SERVER_DIR, rel);
    return readFileSync(full, 'utf8');
}

function collectRawReaders(): string[] {
    const found: string[] = [];
    const walk = (dir: string, base: string): void => {
        for (const name of readdirSync(dir)) {
            const full = join(dir, name);
            if (statSync(full).isDirectory()) {
                if (name !== 'node_modules') walk(full, base);
            } else if (full.endsWith('.ts') && !/\.test\.ts$/.test(full)) {
                const lines = readFileSync(full, 'utf8')
                    .split('\n')
                    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
                if (lines.some((l) => RAW_READ.test(l))) {
                    const rel = relative(base, full);
                    found.push(base === ROUTES_DIR ? `routes/${rel}` : rel);
                }
            }
        }
    };
    walk(SERVER_DIR, SERVER_DIR);
    walk(ROUTES_DIR, ROUTES_DIR);
    return found;
}

describe('library-derived file access uses the containment helpers', () => {
    it('no source file outside the allowlist does a raw read/open', () => {
        const offenders = collectRawReaders().filter((f) => !ALLOWED_RAW.has(f));
        expect(offenders).toEqual([]);
    });

    it('every allowlisted file still exists and still matches (no stale entries)', () => {
        const found = new Set(collectRawReaders());
        expect([...ALLOWED_RAW].filter((f) => !found.has(f))).toEqual([]);
    });

    it('the sidecar readers contain no raw read', () => {
        const GUARDED = [
            'utils/sidecar-text.ts',
            'utils/music-scanner-utils.ts',
            'utils/walk-directory.ts',
            'utils/nfo-parser.ts',
            'tasks/builtin/native/trickplay-providers/jellyfin-disk.ts',
            'tasks/builtin/native/lyrics-ingestion-backfill.ts',
            'services/trickplay-storage.service.ts',
            'services/subtitle-resolver.service.ts',
            'services/subtitle-cache.service.ts',
        ];
        const raw = /\b(?:safeReadFile|readFile|createReadStream|fsOpen|open)\(/;
        for (const file of GUARDED) {
            const src = readFileSync(join(SERVER_DIR, file), 'utf8')
                .split('\n')
                .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
                .join('\n');
            expect(src, file).not.toMatch(raw);
        }
    });

    // A path stored in the DB is served long after the scan checked it, so the
    // file (or a directory above it) may have been swapped for a link since.
    it('DB-stored paths are re-contained when they are served', () => {
        for (const [file, calls] of [
            ['routes/api/image/custom/[id]/[type]/+server.ts', [/readContainedFile\(/]],
            ['services/cache/subtitle-file-cache.service.ts', [/readContainedFile\(/]],
            [
                'subsonic-compat/handlers/stream.ts',
                [/resolveContainedMediaFile\(/, /createNoFollowReadStream\(servePath/],
            ],
            ['utils/file-streaming.ts', [/resolveContainedMediaFile\(/]],
        ] as const) {
            const src = serverSource(file);
            for (const call of calls) expect(src, `${file} ${call}`).toMatch(call);
            expect(src, file).toMatch(/parents: true/);
        }
        expect(serverSource('subsonic-compat/handlers/stream.ts')).not.toMatch(
            /createReadStream\(/,
        );
    });

    // serveFileByPath follows links; DB media paths go through serveContainedMediaFile.
    it('serveFileByPath is only called for app-owned files', () => {
        const APP_OWNED_SERVES = ['api/defs/renditions/[renditionId]/file.ts'];
        const callers: string[] = [];
        const walk = (dir: string, base: string): void => {
            for (const name of readdirSync(dir)) {
                const full = join(dir, name);
                if (statSync(full).isDirectory()) {
                    if (name !== 'node_modules') walk(full, base);
                } else if (full.endsWith('.ts') && !/\.test\.ts$/.test(full)) {
                    if (/\bserveFileByPath\(/.test(readFileSync(full, 'utf8'))) {
                        const rel = relative(base, full);
                        callers.push(base === ROUTES_DIR ? `routes/${rel}` : rel);
                    }
                }
            }
        };
        walk(SERVER_DIR, SERVER_DIR);
        walk(ROUTES_DIR, ROUTES_DIR);
        expect(callers.filter((f) => f !== 'utils/file-streaming.ts').sort()).toEqual(
            APP_OWNED_SERVES,
        );
    });

    it('writers into library/alongside dirs use writeFileNoFollow', () => {
        for (const [file, call] of [
            ['services/media-image-storage.service.ts', /writeFileNoFollow\(filePath, buffer\)/],
            [
                'services/trickplay-storage.service.ts',
                /writeFileNoFollow\(result\.filePath, data\)/,
            ],
            ['tasks/builtin/native/album-enrichment.ts', /writeFileNoFollow\(filePath,/],
            ['services/frame-candidate.service.ts', /writeFileNoFollow\(outputPath,/],
        ] as const) {
            expect(readFileSync(join(SERVER_DIR, file), 'utf8'), file).toMatch(call);
        }
    });
});
