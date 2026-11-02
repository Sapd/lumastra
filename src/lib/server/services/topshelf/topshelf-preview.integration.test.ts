// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the tvOS Top Shelf preview/cinemagraph pipeline (§9.2).
 *
 * Uses a REAL Postgres (lumastra_tests) and REAL ffmpeg (via lavfi-synthesized
 * source clips, same pattern as ffmpeg-spawn.integration.test.ts — no external
 * fixture file dependency, fast, deterministic).
 *
 * `TOPSHELF_PREVIEW_CACHE_DIR` / `FEATURE_TOPSHELF_PREVIEWS` / TTL are set on
 * `process.env` BEFORE any config-touching module is imported (dynamic
 * `import()` after the env is set), so this file's artifact store points at a
 * throwaway temp directory instead of the real `/config/cache/topshelf`.
 */
process.env.FEATURE_TOPSHELF_PREVIEWS = 'true';
process.env.TOPSHELF_PREVIEW_URL_TTL_SECONDS = '172800';
process.env.TOPSHELF_PREVIEW_DURATION_SECONDS = '2';
process.env.TOPSHELF_TRAILER_MAX_SECONDS = '2';
process.env.TOPSHELF_CINEMAGRAPH_DURATION_SECONDS = '1';
process.env.TOPSHELF_MAX_CONCURRENT_RENDERS = '2';
process.env.TOPSHELF_MAX_PENDING_RENDERS = '24';
// Top Shelf's OWN render-size knob — buildTopShelfFfmpegArgs no longer reads
// PREVIEW_MAX_WIDTH (the hover-preview knob), so shrinking the render for a
// fast test run happens here now.
process.env.TOPSHELF_RENDER_MAX_WIDTH = '320';
process.env.TOPSHELF_RENDER_MAX_HEIGHT = '180';
process.env.PREVIEW_ENCODING_PRESET = 'ultrafast';
process.env.PREVIEW_MAX_VIDEO_BITRATE_MBPS = '1';

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type postgres from 'postgres';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import { checkFFmpegAvailability, spawnFFmpegSafely } from '$lib/server/utils/ffmpeg-spawn.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { invalidateLibraryGroupPermissionsCache } from '$lib/server/cache/library-group-permissions-cache.js';
import { upsertLibraryGroupPermission } from '$lib/server/database/queries/library-group-permissions.queries.js';
import { computeTopShelfContentKey } from './topshelf-content-key.js';
import type { UserContext } from '$lib/server/types.js';

let tmpRoot: string;
let sql: postgres.Sql;

// Modules re-imported dynamically per-test-run AFTER TOPSHELF_PREVIEW_CACHE_DIR
// is pointed at the throwaway tmp dir, so the singleton store never touches
// the real /config/cache/topshelf.
let getTopShelfArtifactStore: typeof import('./topshelf-artifact.store.js').getTopShelfArtifactStore;
let __resetTopShelfArtifactStoreForTests: typeof import('./topshelf-artifact.store.js').__resetTopShelfArtifactStoreForTests;
let selectTopShelfSource: typeof import('./topshelf-render.service.js').selectTopShelfSource;
let resolveAndEnqueueTopShelfVariant: typeof import('./topshelf-render.service.js').resolveAndEnqueueTopShelfVariant;
let enqueueTopShelfRender: typeof import('./topshelf-render.service.js').enqueueTopShelfRender;
let __resetTopShelfRenderStateForTests: typeof import('./topshelf-render.service.js').__resetTopShelfRenderStateForTests;
// The SAME module instance topshelf-render.service.js resolves
// `spawnFFmpegSafely` from after a `vi.resetModules()` epoch — re-imported
// here (rather than relying on this file's own static top-level import) so
// `vi.spyOn` below observes calls made from inside the render service, not a
// stale pre-reset module instance.
let ffmpegSpawnModule: typeof import('$lib/server/utils/ffmpeg-spawn.js');

async function reloadTopShelfModules(): Promise<void> {
    vi.resetModules();
    ffmpegSpawnModule = await import('$lib/server/utils/ffmpeg-spawn.js');
    const store = await import('./topshelf-artifact.store.js');
    getTopShelfArtifactStore = store.getTopShelfArtifactStore;
    __resetTopShelfArtifactStoreForTests = store.__resetTopShelfArtifactStoreForTests;
    const render = await import('./topshelf-render.service.js');
    selectTopShelfSource = render.selectTopShelfSource;
    resolveAndEnqueueTopShelfVariant = render.resolveAndEnqueueTopShelfVariant;
    enqueueTopShelfRender = render.enqueueTopShelfRender;
    __resetTopShelfRenderStateForTests = render.__resetTopShelfRenderStateForTests;
}

// Resolved at MODULE LOAD (top-level await), NOT inside `beforeAll` —
// `it.runIf(...)` predicates are evaluated at collection time, which runs
// BEFORE any `beforeAll` hook fires. Setting this flag inside `beforeAll` (as
// before) always left `it.runIf` reading the `false` initializer, silently
// skipping every ffmpeg-dependent test regardless of ffmpeg's real
// availability.
const ffmpegAvailable = await checkFFmpegAvailability(true);

async function insertMovie(title: string, runtimeSeconds?: number): Promise<string> {
    const rows = await sql<{ id: string }[]>`
        INSERT INTO media_items (title, media_type, has_files, runtime_seconds)
        VALUES (${title}, 'movie', true, ${runtimeSeconds ?? null})
        RETURNING id
    `;
    return rows[0].id;
}

/**
 * `resolvePreviewStartPosition`'s smart-position heuristic clamps its intro
 * guard to a 60s FLOOR regardless of runtime (see `calculateSmartPreviewPosition`
 * in `$lib/shared/preview-position.ts`) — with no `runtime_seconds` at all it
 * falls back to a 120s constant. Either way, a snippet/cinemagraph render
 * against a source shorter than that seeks past EOF: ffmpeg exits 0 almost
 * instantly having encoded zero frames (an empty-but-valid MP4 container),
 * which silently defeats any test asserting on the rendered STREAM CONTENT
 * (codec/pixel format) or on realistic render TIMING (coalescing). Giving the
 * test movie a `runtime_seconds` of `SYNTHETIC_MOVIE_RUNTIME_SECONDS` pins the
 * heuristic to exactly 60s (`introGuardSeconds === maxStart === 60` for any
 * runtime this size), so a `SYNTHETIC_CLIP_DURATION_SECONDS`-long source clip
 * comfortably covers the seek + the (tiny, test-env) render duration.
 */
const SYNTHETIC_MOVIE_RUNTIME_SECONDS = 90;
const SYNTHETIC_CLIP_DURATION_SECONDS = 70;

async function insertLibraryGroup(): Promise<string> {
    const rows = await sql<{ id: string }[]>`
        INSERT INTO library_groups (name) VALUES ('Restricted Group') RETURNING id
    `;
    return rows[0].id;
}

/** Generate a tiny synthetic video file via lavfi (fast, deterministic, self-contained). */
async function generateSourceClip(path: string, durationSeconds: number): Promise<void> {
    await spawnFFmpegSafely({
        args: [
            '-y',
            '-f',
            'lavfi',
            '-i',
            `color=c=blue:s=320x240:d=${durationSeconds}`,
            '-f',
            'lavfi',
            '-i',
            `anullsrc=r=44100:cl=stereo`,
            '-shortest',
            '-c:v',
            'libx264',
            '-preset',
            'ultrafast',
            '-c:a',
            'aac',
            path,
        ],
        timeout: 20_000,
    });
}

async function linkFileToMovie(
    movieId: string,
    filePath: string,
    durationSeconds: number,
    libraryGroupId?: string,
): Promise<string> {
    const [file] = await sql<{ id: string }[]>`
        INSERT INTO media_files (file_path, duration_seconds, library_group_id)
        VALUES (${filePath}, ${durationSeconds}, ${libraryGroupId ?? null})
        RETURNING id
    `;
    await sql`
        INSERT INTO media_file_items (file_id, media_item_id, is_default)
        VALUES (${file.id}, ${movieId}, true)
    `;
    return file.id;
}

function makeUser(overrides: Partial<UserContext> = {}): UserContext {
    return {
        userId: 'test-user' as UserContext['userId'],
        username: 'alice',
        groups: '',
        userGroups: [],
        hasWatchPermission: true,
        hasLiveTvPermission: false,
        hasRequestPermission: false,
        ownerIsAdmin: false,
        isModerator: false,
        maxAgeRating: null,
        isAgeRestricted: false,
        liveTvPriority: 'low',
        ...overrides,
    } as UserContext;
}

describe('Top Shelf preview pipeline (integration)', () => {
    beforeAll(async () => {
        sql = getTestDb();
        tmpRoot = mkdtempSync(join(tmpdir(), 'topshelf-integration-'));
        process.env.TOPSHELF_PREVIEW_CACHE_DIR = tmpRoot;
        await reloadTopShelfModules();
    }, 30_000);

    afterAll(async () => {
        __resetTopShelfArtifactStoreForTests();
        __resetTopShelfRenderStateForTests();
        await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        invalidateLibraryGroupPermissionsCache();
        __resetTopShelfRenderStateForTests();
        __resetTopShelfArtifactStoreForTests();
        process.env.TOPSHELF_PREVIEW_CACHE_DIR = tmpRoot;
        await reloadTopShelfModules();
    });

    it.runIf(ffmpegAvailable)(
        'renders a preview snippet and serves it with Range support',
        async () => {
            const movieId = await insertMovie('Top Shelf Movie A', SYNTHETIC_MOVIE_RUNTIME_SECONDS);
            const srcPath = join(tmpRoot, 'source-a.mp4');
            await generateSourceClip(srcPath, SYNTHETIC_CLIP_DURATION_SECONDS);
            await linkFileToMovie(movieId, srcPath, SYNTHETIC_CLIP_DURATION_SECONDS);

            const selection = await selectTopShelfSource(sql, movieId, 'preview');
            expect(selection.status).toBe('ready');
            expect(selection.previewSource).toBe('snippet');

            const result = await resolveAndEnqueueTopShelfVariant(sql, movieId, 'preview');
            expect(result.state).toBe('pending');

            // Wait for the coalesced background render to land in the store
            // (bounded poll — real ffmpeg, not mocked, so this genuinely encodes).
            const store = getTopShelfArtifactStore();
            const deadline = Date.now() + 15_000;
            let lookup = await store.getVariantArtifact(movieId, 'preview');
            while (lookup.status !== 'ready' && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 250));
                lookup = await store.getVariantArtifact(movieId, 'preview');
            }
            expect(lookup.status).toBe('ready');

            if (lookup.status === 'ready') {
                const { serveFileWithRange } = await import('$lib/server/utils/http-range.js');
                const fullReq = new Request('http://localhost/file');
                const fullRes = await serveFileWithRange(lookup.path, fullReq, {
                    contentType: 'video/mp4',
                });
                expect(fullRes.status).toBe(200);
                expect(fullRes.headers.get('accept-ranges')).toBe('bytes');

                const rangeReq = new Request('http://localhost/file', {
                    headers: { Range: 'bytes=0-99' },
                });
                const rangeRes = await serveFileWithRange(lookup.path, rangeReq, {
                    contentType: 'video/mp4',
                });
                expect(rangeRes.status).toBe(206);
                expect(rangeRes.headers.get('content-range')).toMatch(/^bytes 0-99\//);
            }
        },
        30_000,
    );

    it.runIf(ffmpegAvailable)(
        'cinemagraph artifact has zero audio streams (h264/yuv420p, silent)',
        async () => {
            const movieId = await insertMovie('Top Shelf Movie B', SYNTHETIC_MOVIE_RUNTIME_SECONDS);
            const srcPath = join(tmpRoot, 'source-b.mp4');
            await generateSourceClip(srcPath, SYNTHETIC_CLIP_DURATION_SECONDS);
            await linkFileToMovie(movieId, srcPath, SYNTHETIC_CLIP_DURATION_SECONDS);

            await resolveAndEnqueueTopShelfVariant(sql, movieId, 'cinemagraph');

            const store = getTopShelfArtifactStore();
            const deadline = Date.now() + 15_000;
            let lookup = await store.getVariantArtifact(movieId, 'cinemagraph');
            while (lookup.status !== 'ready' && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 250));
                lookup = await store.getVariantArtifact(movieId, 'cinemagraph');
            }
            expect(lookup.status).toBe('ready');
            if (lookup.status !== 'ready') return;

            const { probeMediaFile } = await import('$lib/server/utils/ffprobe.js');
            const probe = await probeMediaFile(lookup.path);
            expect(probe.audioStreams.length).toBe(0);
            expect(probe.video?.codec).toBe('h264');
            expect(probe.video?.pixelFormat).toBe('yuv420p');
        },
        30_000,
    );

    it('trailer-parent gating: a NULL-group trailer must not leak past a denied parent group', async () => {
        const groupId = await insertLibraryGroup();
        await upsertLibraryGroupPermission(sql, {
            libraryGroupId: groupId,
            allowedGroups: ['staff'],
        });
        invalidateLibraryGroupPermissionsCache();

        const movieId = await insertMovie('Top Shelf Movie C');
        // Parent's OWN file carries the restricted group.
        await linkFileToMovie(movieId, '/data/movies/c.mkv', 100, groupId);
        // Trailer child carries library_group_id = NULL (pre-16.159.0 ingest shape).
        const [trailer] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, extra_type, parent_id)
            VALUES ('trailer', 'extra', 'trailer', ${movieId})
            RETURNING id
        `;
        const [trailerFile] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path, is_missing, library_group_id)
            VALUES ('/data/movies/c-trailer.mkv', false, NULL)
            RETURNING id
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id)
            VALUES (${trailerFile.id}, ${trailer.id})
        `;

        const outsider = makeUser({ userGroups: ['public'] });
        const accessible = await checkMediaAccess(sql, movieId, outsider);
        expect(accessible).toBe(false);

        const staffMember = makeUser({ userGroups: ['staff'] });
        const staffAccessible = await checkMediaAccess(sql, movieId, staffMember);
        expect(staffAccessible).toBe(true);

        const selection = await selectTopShelfSource(sql, movieId, 'preview');
        expect(selection.status).toBe('ready');
        expect(selection.previewSource).toBe('trailer');
    });

    it('manifest-present/file-missing → serving lookup reports missing_file (410 path)', async () => {
        const movieId = await insertMovie('Top Shelf Movie D');
        const store = getTopShelfArtifactStore();
        await store.recordVariant(movieId, 'preview', {
            contentKey: 'deadbeefdeadbeef',
            source: 'snippet',
            bytes: 1024,
            createdAt: new Date().toISOString(),
            lastRequestedAt: new Date().toISOString(),
        });
        // Deliberately do NOT write the artifact file — simulates a crash
        // mid-GC or a disk swap.
        const lookup = await store.getVariantArtifact(movieId, 'preview');
        expect(lookup.status).toBe('missing_file');
    });

    it.runIf(ffmpegAvailable)(
        'coalescing: two concurrent enqueues for the same content key spawn ffmpeg exactly once',
        async () => {
            const movieId = await insertMovie('Top Shelf Movie E', SYNTHETIC_MOVIE_RUNTIME_SECONDS);
            const srcPath = join(tmpRoot, 'source-e.mp4');
            await generateSourceClip(srcPath, SYNTHETIC_CLIP_DURATION_SECONDS);
            await linkFileToMovie(movieId, srcPath, SYNTHETIC_CLIP_DURATION_SECONDS);

            // Resolve the source and contentKey ONCE — both are deterministic
            // pure functions of the (item, file, variant) tuple, so this is
            // exactly what two concurrent mints for the same item+variant
            // would each independently compute.
            const selection = await selectTopShelfSource(sql, movieId, 'preview');
            expect(selection.status).toBe('ready');
            const contentKey = computeTopShelfContentKey({
                sourceItemId: selection.sourceItemId!,
                fileId: selection.fileId!,
                fileVersion: selection.fileVersion ?? 'unknown',
                variant: 'preview',
                startSeconds: selection.startSeconds!,
                durationSeconds: selection.durationSeconds!,
            });

            // Spy on the SAME spawnFFmpegSafely instance the freshly-reloaded
            // render service resolves (see ffmpegSpawnModule above) — calls
            // through to the real implementation, just counts invocations.
            const spawnSpy = vi.spyOn(ffmpegSpawnModule, 'spawnFFmpegSafely');

            // Call the coalescing decision point (§4.4's in-flight Map)
            // directly, twice, back-to-back with the identical contentKey —
            // this is what two concurrent mints collapse onto after each
            // independently resolves the same source. Going through two
            // parallel `resolveAndEnqueueTopShelfVariant` calls instead (each
            // running its own real DB round-trips) is flaky here: this
            // test's tiny 2s/ultrafast-preset clip can render AND clear the
            // in-flight entry faster than a second independent DB lookup
            // completes, which races the dedup rather than exercising it — a
            // side effect of this test env's fast local Postgres and tiny
            // clip duration, not a real coalescing gap (a real mint always
            // checks `store.getVariantArtifact()` first, and production
            // render/encode times dwarf a DB round-trip).
            const first = enqueueTopShelfRender({
                mediaId: movieId,
                variant: 'preview',
                selection,
                contentKey,
            });
            const second = enqueueTopShelfRender({
                mediaId: movieId,
                variant: 'preview',
                selection,
                contentKey,
            });
            expect(first.enqueued).toBe(true);
            expect(second.enqueued).toBe(true);

            const store = getTopShelfArtifactStore();
            const deadline = Date.now() + 15_000;
            let lookup = await store.getVariantArtifact(movieId, 'preview');
            while (lookup.status !== 'ready' && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 250));
                lookup = await store.getVariantArtifact(movieId, 'preview');
            }
            expect(lookup.status).toBe('ready');
            // Both enqueue attempts resolved onto the SAME contentKey, so the
            // coalescing map held exactly one in-flight render — the manifest
            // carries a single artifact AND ffmpeg itself was spawned exactly
            // once (§9.2).
            const manifest = await store.readManifest(movieId);
            expect(Object.keys(manifest?.variants ?? {})).toEqual(['preview']);
            expect(spawnSpy).toHaveBeenCalledTimes(1);
            spawnSpy.mockRestore();
        },
        30_000,
    );
});
