// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for POST /api/setup/library — the first-run "add a library + scan"
 * endpoint. Verifies path-readability gating (no create when unreadable), input
 * validation, the create→scan happy path (in a transaction), dedup of an existing
 * path, transaction-failure handling, and the scan-start soft-fail (backpressure
 * AND any other orchestrator error). All collaborators mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
    mockGetSql,
    mockReadable,
    mockCreateGroup,
    mockCreatePath,
    mockGetPaths,
    mockUpdatePath,
    mockAfter,
    mockStartRun,
    mockListLibraries,
    mockStat,
} = vi.hoisted(() => ({
    mockStat: vi.fn(),
    mockGetSql: vi.fn(),
    mockReadable: vi.fn(),
    mockCreateGroup: vi.fn(),
    mockCreatePath: vi.fn(),
    mockGetPaths: vi.fn(),
    mockUpdatePath: vi.fn(),
    mockAfter: vi.fn(),
    mockStartRun: vi.fn(),
    mockListLibraries: vi.fn(),
}));

vi.mock('$lib/server/config.js', () => ({ config: { TMDB_LANGUAGE: 'de-DE' } }));

class FakeBackpressureError extends Error {
    retryAfterMs = 5000;
    constructor() {
        super('Queue at capacity');
        this.name = 'BackpressureError';
    }
}

vi.mock('$lib/server/middleware/auth.js', () => ({
    requireAdmin: (fn: (event: unknown) => unknown) => fn,
}));
vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (fn: (event: unknown) => unknown) => fn,
}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...a: unknown[]) => mockGetSql(...a) },
}));
vi.mock('$lib/server/preflight/dependency-checks.js', () => ({
    isPathReadable: (...a: unknown[]) => mockReadable(...a),
}));
vi.mock('$lib/server/utils/safe-fs.js', () => ({
    safeStat: (...a: unknown[]) => mockStat(...a),
}));
vi.mock('$lib/server/database/queries/library-groups.queries.js', () => ({
    createLibraryGroup: (...a: unknown[]) => mockCreateGroup(...a),
}));
// `importOriginal` rather than a hand-mirrored `normalizeLibraryPath`. The mirror
// this replaces had silently drifted: it still collapsed `//`, so it mangled the
// `abs://<id>` sentinel that the real implementation now deliberately preserves —
// meaning a remote-provider test written against the mirror would assert the
// corrupted path and "pass". Only the three DB functions are stubbed.
vi.mock('$lib/server/database/queries/library-paths.queries.js', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    createLibraryPath: (...a: unknown[]) => mockCreatePath(...a),
    getAllLibraryPaths: (...a: unknown[]) => mockGetPaths(...a),
    updateLibraryPath: (...a: unknown[]) => mockUpdatePath(...a),
}));
// NOT `importOriginal` here (unlike the query module below, where the real
// `normalizeLibraryPath` is the point). The real module builds an ABS client and
// reads `$lib/server/config`, so spreading it drags the whole config system into
// a unit test's import graph — measurably enough to push this file's first test
// past its 30s timeout under a full-suite run. The route imports exactly one
// symbol from here, so supplying just that keeps the file light.
//
// The fake still mirrors production values verbatim (`abs://` scheme,
// `audiobookshelf-sync`, the label) so the derived sentinel and task id under
// test are the real ones; only `listLibraries` is stubbed.
vi.mock('$lib/server/services/remote-library-sources.js', () => ({
    getRemoteLibrarySource: (provider: string) => {
        if (provider !== 'audiobookshelf') return undefined;
        return {
            provider: 'audiobookshelf',
            label: 'AudiobookShelf',
            mediaType: 'audiobook',
            settingsHref: '/admin/settings/audiobookshelf',
            requiredKeys: ['AUDIOURL', 'AUDIOAPIKEY'],
            syncTaskId: 'audiobookshelf-sync',
            pathFor: (id: string) => `abs://${id}`,
            listLibraries: () => mockListLibraries(),
        };
    },
}));
// Folder validation touches the real filesystem (realpath); these tests cover
// the handler around it, so the folders are taken as valid here. The rules
// themselves: services/library-root-validation.test.ts.
vi.mock('$lib/server/services/library-root-validation.js', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/services/library-root-validation.js')>();
    const norm = (p: string): string =>
        p
            .trim()
            .replace(/\/{2,}/g, '/')
            .replace(/(.)\/+$/, '$1');
    return {
        ...actual,
        assertLibraryRootAllowed: async (_sql: unknown, p: string) => norm(p),
        checkLibraryRootForApi: async (_sql: unknown, p: string) => ({ path: norm(p) }),
        isWithinAllowedLibraryRoots: async () => true,
        configuredLibraryRoots: () => [],
    };
});
vi.mock('$lib/server/services/library-path-sync.service.js', () => ({
    afterLibraryPathChanged: (...a: unknown[]) => mockAfter(...a),
}));
vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: { startRun: (...a: unknown[]) => mockStartRun(...a) },
}));
vi.mock('$lib/server/tasks/backpressure.js', () => ({ BackpressureError: FakeBackpressureError }));

// A sql handle whose .begin(fn) runs the transaction callback with a `tx` marker.
const sqlMock = { begin: async (fn: (tx: unknown) => unknown) => fn({ tx: true }) };

const callPost = async (body: unknown, username = 'admin') => {
    const { POST } = await import('./+server.js');
    const event = {
        request: new Request('http://localhost/test', {
            method: 'POST',
            body: JSON.stringify(body),
        }),
        locals: { user: { username } },
    };
    return (POST as (event: unknown) => Promise<Response>)(event);
};

describe('POST /api/setup/library', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue(sqlMock);
        mockReadable.mockResolvedValue(true);
        mockStat.mockResolvedValue({ isDirectory: () => true });
        mockGetPaths.mockResolvedValue([]); // no existing library by default
        mockCreateGroup.mockResolvedValue({ id: 'group-1' });
        mockCreatePath.mockResolvedValue({ id: 'path-1' });
        mockUpdatePath.mockResolvedValue({ id: 'path-existing', enabled: true });
        mockAfter.mockResolvedValue(undefined);
        mockStartRun.mockResolvedValue({ runId: 'run-1', deduped: false });
    });

    it.each([undefined, '', '  '])(
        'inherits effective TMDB language when language=%s',
        async (language) => {
            await callPost({ path: '/data/movies', mediaType: 'movie', language });
            expect(mockCreatePath).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ language: 'de' }),
            );
        },
    );

    it('keeps an explicit per-library language', async () => {
        await callPost({ path: '/data/movies', mediaType: 'movie', language: 'fr-FR' });
        expect(mockCreatePath).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ language: 'fr-FR' }),
        );
    });

    it('rejects a missing path', async () => {
        const res = await callPost({ mediaType: 'movie' });
        expect(res.status).toBe(422);
        expect(mockCreateGroup).not.toHaveBeenCalled();
    });

    it('rejects an unknown media type', async () => {
        const res = await callPost({ path: '/data/x', mediaType: 'nope' });
        expect(res.status).toBe(422);
        expect(mockCreateGroup).not.toHaveBeenCalled();
    });

    it('rejects an audiobook library from a local folder, naming AudiobookShelf', async () => {
        const res = await callPost({ path: '/data/books', mediaType: 'audiobook' });
        expect(res.status).toBe(422);
        expect(JSON.stringify(await res.json())).toContain('AudiobookShelf');
        expect(mockReadable).not.toHaveBeenCalled();
        expect(mockCreateGroup).not.toHaveBeenCalled();
    });

    it('does NOT create anything when the path is unreadable', async () => {
        mockReadable.mockResolvedValue(false);
        const res = await callPost({ path: '/data/missing', mediaType: 'movie' });
        const body = await res.json();

        expect(body).toEqual({ ok: false, readable: false });
        expect(mockCreateGroup).not.toHaveBeenCalled();
        expect(mockStartRun).not.toHaveBeenCalled();
    });

    it('does NOT create a library on a readable regular file (the scan could only fail)', async () => {
        mockStat.mockResolvedValue({ isDirectory: () => false });
        const res = await callPost({ path: '/data/movie.mkv', mediaType: 'movie' });

        expect(await res.json()).toEqual({ ok: false, readable: true, notDirectory: true });
        expect(mockCreateGroup).not.toHaveBeenCalled();
        expect(mockStartRun).not.toHaveBeenCalled();
    });

    it('refuses a folder already registered as another media type instead of reusing it', async () => {
        mockGetPaths.mockResolvedValue([
            {
                id: 'path-existing',
                media_type: 'music',
                path: '/data/media',
                enabled: true,
                library_group_id: 'group-existing',
            },
        ]);
        const res = await callPost({ path: '/data/media', mediaType: 'movie' });

        expect(await res.json()).toEqual({
            ok: false,
            readable: true,
            conflict: 'media-type',
            existingMediaType: 'music',
        });
        expect(mockUpdatePath).not.toHaveBeenCalled();
        expect(mockStartRun).not.toHaveBeenCalled();
    });

    it('creates the group + path in a transaction and starts the scan', async () => {
        const res = await callPost({ path: '/data/movies', mediaType: 'movie' });
        const body = await res.json();

        expect(body).toMatchObject({
            ok: true,
            scanStarted: true,
            runId: 'run-1',
            libraryPathId: 'path-1',
            groupId: 'group-1',
        });
        expect(mockCreateGroup).toHaveBeenCalledWith(expect.anything(), { name: 'Movies' });
        expect(mockCreatePath).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                path: '/data/movies',
                media_type: 'movie',
                library_group_id: 'group-1',
            }),
        );
        expect(mockAfter).toHaveBeenCalled();
        expect(mockStartRun).toHaveBeenCalledWith(
            'file-library-scan',
            { libraryPathId: 'path-1', mode: 'manual' },
            {
                trigger: { kind: 'manual', by: 'admin', sourceRoute: 'setup.library' },
                idempotencyKey: 'library-ingest:file-library-scan:path-1',
            },
        );
    });

    // The first-run wizard offers the same types as the admin wizard. Each one
    // must pass the server's media-type check and get its default group name.
    it.each([
        ['home_video', 'Home Videos'],
        ['training', 'Training'],
        ['educational', 'Educational'],
        ['personal', 'Personal'],
    ])(
        'accepts a %s library from the setup path and names its group "%s"',
        async (mediaType, groupName) => {
            const res = await callPost({ path: `/data/${mediaType}`, mediaType });

            expect(await res.json()).toMatchObject({ ok: true, scanStarted: true });
            expect(mockCreateGroup).toHaveBeenCalledWith(expect.anything(), { name: groupName });
            expect(mockCreatePath).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ path: `/data/${mediaType}`, media_type: mediaType }),
            );
        },
    );

    it('scans the EXISTING library (no duplicate create) when the path is already registered', async () => {
        mockGetPaths.mockResolvedValue([
            {
                id: 'path-existing',
                media_type: 'movie',
                path: '/data/movies',
                library_group_id: 'group-existing',
                enabled: true,
            },
        ]);
        const res = await callPost({ path: '/data/movies', mediaType: 'movie' });
        const body = await res.json();

        expect(mockCreateGroup).not.toHaveBeenCalled();
        expect(mockCreatePath).not.toHaveBeenCalled();
        expect(mockUpdatePath).not.toHaveBeenCalled();
        expect(mockStartRun).toHaveBeenCalledWith(
            'file-library-scan',
            { libraryPathId: 'path-existing', mode: 'manual' },
            expect.anything(),
        );
        expect(body).toMatchObject({
            ok: true,
            libraryPathId: 'path-existing',
            groupId: 'group-existing',
        });
    });

    it('re-enables a DISABLED existing library (not a 500) and scans it', async () => {
        // A previously-removed library leaves a disabled library_paths row that
        // the table-wide UNIQUE(path) still occupies. Adding it again must attach
        // to + re-enable it rather than trip the unique constraint.
        mockGetPaths.mockResolvedValue([
            {
                id: 'path-disabled',
                media_type: 'movie',
                path: '/data/movies',
                library_group_id: 'group-disabled',
                enabled: false,
            },
        ]);
        const res = await callPost({ path: '/data/movies', mediaType: 'movie' });
        const body = await res.json();

        expect(mockCreatePath).not.toHaveBeenCalled();
        expect(mockUpdatePath).toHaveBeenCalledWith(expect.anything(), 'path-disabled', {
            enabled: true,
        });
        expect(mockAfter).toHaveBeenCalled();
        expect(body).toMatchObject({
            ok: true,
            libraryPathId: 'path-disabled',
            groupId: 'group-disabled',
        });
        expect(mockStartRun).toHaveBeenCalledWith(
            'file-library-scan',
            { libraryPathId: 'path-disabled', mode: 'manual' },
            expect.anything(),
        );
    });

    it('500s (no orphaned group) when the create transaction fails with a non-conflict error', async () => {
        mockCreatePath.mockRejectedValue(new Error('boom'));
        const res = await callPost({ path: '/data/movies', mediaType: 'movie' });

        expect(res.status).toBe(500);
        expect(mockStartRun).not.toHaveBeenCalled();
    });

    it('normalizes a trailing-slash path so it dedupes against the stored (slash-less) library', async () => {
        // Stored library was created from the normalized form.
        mockGetPaths.mockResolvedValue([
            {
                id: 'path-existing',
                media_type: 'movie',
                path: '/data/movies',
                library_group_id: 'group-existing',
                enabled: true,
            },
        ]);
        const res = await callPost({ path: '/data/movies/', mediaType: 'movie' });
        const body = await res.json();

        expect(mockReadable).toHaveBeenCalledWith('/data/movies');
        expect(mockCreateGroup).not.toHaveBeenCalled();
        expect(mockCreatePath).not.toHaveBeenCalled();
        expect(body).toMatchObject({
            ok: true,
            libraryPathId: 'path-existing',
            groupId: 'group-existing',
        });
    });

    it('recovers idempotently on a 23505 unique-violation race (concurrent submission won first)', async () => {
        const conflict = Object.assign(
            new Error('duplicate key value violates unique constraint'),
            {
                code: '23505',
            },
        );
        mockCreatePath.mockRejectedValue(conflict);
        // After the failed insert, re-query finds the row the concurrent
        // request just committed.
        mockGetPaths.mockResolvedValueOnce([]).mockResolvedValueOnce([
            {
                id: 'path-race',
                path: '/data/movies',
                library_group_id: 'group-race',
                enabled: true,
            },
        ]);

        const res = await callPost({ path: '/data/movies', mediaType: 'movie' });
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toMatchObject({ ok: true, libraryPathId: 'path-race', groupId: 'group-race' });
        expect(mockAfter).not.toHaveBeenCalled();
        expect(mockUpdatePath).not.toHaveBeenCalled();
    });

    it('recovers on a 23505 race where the conflicting row is DISABLED (re-enables it)', async () => {
        const conflict = Object.assign(
            new Error('duplicate key value violates unique constraint'),
            {
                code: '23505',
            },
        );
        mockCreatePath.mockRejectedValue(conflict);
        // Re-query after the conflict surfaces a DISABLED row for the same path.
        mockGetPaths.mockResolvedValueOnce([]).mockResolvedValueOnce([
            {
                id: 'path-dis',
                path: '/data/movies',
                library_group_id: 'group-dis',
                enabled: false,
            },
        ]);

        const res = await callPost({ path: '/data/movies', mediaType: 'movie' });
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toMatchObject({ ok: true, libraryPathId: 'path-dis', groupId: 'group-dis' });
        expect(mockUpdatePath).toHaveBeenCalledWith(expect.anything(), 'path-dis', {
            enabled: true,
        });
    });

    it('500s if a 23505 race occurs but the re-query finds no matching row', async () => {
        const conflict = Object.assign(
            new Error('duplicate key value violates unique constraint'),
            {
                code: '23505',
            },
        );
        mockCreatePath.mockRejectedValue(conflict);
        mockGetPaths.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

        const res = await callPost({ path: '/data/movies', mediaType: 'movie' });
        expect(res.status).toBe(500);
        expect(mockStartRun).not.toHaveBeenCalled();
    });

    it('soft-fails (library kept, no runId) when the scan queue is at capacity', async () => {
        mockStartRun.mockRejectedValue(new FakeBackpressureError());
        const res = await callPost({ path: '/data/movies', mediaType: 'movie' });
        const body = await res.json();

        expect(body).toMatchObject({ ok: true, scanStarted: false, libraryPathId: 'path-1' });
        expect(body.runId).toBeUndefined();
    });

    it('soft-fails on any other scan-start error (library still created)', async () => {
        mockStartRun.mockRejectedValue(new Error('orchestrator down'));
        const res = await callPost({ path: '/data/movies', mediaType: 'movie' });
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toMatchObject({ ok: true, scanStarted: false, libraryPathId: 'path-1' });
    });

    // -----------------------------------------------------------------------
    // Remote providers (AudiobookShelf)
    // -----------------------------------------------------------------------

    describe('remote providers', () => {
        const ABS_ID = '2231b38d-b79d-439d-aca1-3c3753e31dad';

        beforeEach(() => {
            mockListLibraries.mockResolvedValue({
                status: 'ok',
                libraries: [
                    { id: ABS_ID, name: 'Hörbücher', kind: 'book', supported: true },
                    {
                        id: 'pod-1',
                        name: 'Podcasts',
                        kind: 'podcast',
                        supported: false,
                        unsupportedReason:
                            'Lumastra can only ingest book libraries; this one is a podcast library.',
                    },
                ],
            });
        });

        const remoteBody = (over: Record<string, unknown> = {}) => ({
            provider: 'audiobookshelf',
            remoteLibraryId: ABS_ID,
            mediaType: 'audiobook',
            language: 'de',
            ...over,
        });

        it('does not invent a language and preserves the selected upstream name', async () => {
            await callPost(remoteBody({ language: undefined }));
            expect(mockCreatePath).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ language: '' }),
            );
            expect(mockCreateGroup).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ name: 'Hörbücher' }),
            );
        });

        it('never stats the filesystem for a remote provider', async () => {
            await callPost(remoteBody());
            // `stat()` on `abs://<uuid>` can only fail, so the readability gate
            // must not be consulted at all.
            expect(mockReadable).not.toHaveBeenCalled();
        });

        it.each(['x'.repeat(101), 'x'.repeat(99) + '🎧日本語'])(
            'bounds an untrusted ABS name to the group limit without splitting Unicode',
            async (name) => {
                mockListLibraries.mockResolvedValue({
                    status: 'ok',
                    libraries: [{ id: ABS_ID, name, kind: 'book', supported: true }],
                });
                const response = await callPost(remoteBody());
                expect(response.status).toBe(200);
                const saved = mockCreateGroup.mock.calls[0][1].name as string;
                expect(saved.length).toBeLessThanOrEqual(100);
                expect(saved).not.toMatch(/[\uD800-\uDFFF]$/u);
                expect(name.startsWith(saved)).toBe(true);
            },
        );

        it('derives BOTH the abs:// sentinel and provider_path, and preserves the double slash', async () => {
            await callPost(remoteBody());

            expect(mockCreatePath).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({
                    // `provider_path` — not `path` — is what the sweep resolves a
                    // library from. A row with only the sentinel ingests nothing.
                    path: `abs://${ABS_ID}`,
                    provider_path: ABS_ID,
                    provider: 'audiobookshelf',
                    media_type: 'audiobook',
                    language: 'de',
                }),
            );
        });

        it("starts the SOURCE's sync task, not file-library-scan", async () => {
            await callPost(remoteBody());

            // `file-library-scan` readdir()s `library_paths.path`; for a URI that
            // run can only fail, while burning a slot and writing a run-history
            // entry that reads like the import failed.
            expect(mockStartRun).toHaveBeenCalledWith(
                'audiobookshelf-sync',
                { libraryPathId: 'path-1' },
                {
                    trigger: { kind: 'manual', by: 'admin', sourceRoute: 'setup.library' },
                    idempotencyKey: 'library-ingest:audiobookshelf-sync:path-1',
                },
            );
            const [[taskId]] = mockStartRun.mock.calls;
            expect(taskId).not.toBe('file-library-scan');
        });

        it('ignores a caller-supplied path instead of trusting it', async () => {
            await callPost(remoteBody({ path: '/etc/passwd' }));

            expect(mockCreatePath).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ path: `abs://${ABS_ID}` }),
            );
        });

        it('rejects a missing remoteLibraryId without creating anything', async () => {
            const res = await callPost(remoteBody({ remoteLibraryId: undefined }));
            expect(res.status).toBe(422);
            expect(mockCreateGroup).not.toHaveBeenCalled();
            expect(mockStartRun).not.toHaveBeenCalled();
        });

        it('rejects an id the remote server does not have', async () => {
            const res = await callPost(remoteBody({ remoteLibraryId: 'not-a-real-library' }));
            expect(res.status).toBe(422);
            expect(mockCreateGroup).not.toHaveBeenCalled();
        });

        it('rejects an unsupported (podcast) library, quoting the reason', async () => {
            const res = await callPost(remoteBody({ remoteLibraryId: 'pod-1' }));
            expect(res.status).toBe(422);
            expect(await res.text()).toMatch(/book libraries/i);
            expect(mockCreateGroup).not.toHaveBeenCalled();
        });

        it('reports not-configured rather than creating an unusable library', async () => {
            mockListLibraries.mockResolvedValue({
                status: 'not_configured',
                missingKeys: ['AUDIOURL', 'AUDIOAPIKEY'],
            });
            const res = await callPost(remoteBody());
            expect(res.status).toBe(422);
            expect(await res.text()).toMatch(/AUDIOURL and AUDIOAPIKEY/);
            expect(mockCreateGroup).not.toHaveBeenCalled();
        });

        it('reports unreachable rather than creating a library it could not verify', async () => {
            mockListLibraries.mockResolvedValue({
                status: 'unreachable',
                message: 'Could not reach the AudiobookShelf server: ENOTFOUND',
            });
            const res = await callPost(remoteBody());
            expect(res.status).toBe(422);
            expect(await res.text()).toMatch(/ENOTFOUND/);
            expect(mockCreateGroup).not.toHaveBeenCalled();
        });
    });
});

describe('setup ingest deduplication', () => {
    it('attaches Retry to a scan already started by the schedule', async () => {
        mockGetSql.mockResolvedValue(sqlMock);
        mockReadable.mockResolvedValue(true);
        mockStat.mockResolvedValue({ isDirectory: () => true });
        mockGetPaths.mockResolvedValue([
            {
                id: 'path-existing',
                path: '/data/movies',
                media_type: 'movie',
                enabled: true,
                library_group_id: 'group-1',
            },
        ]);
        mockStartRun.mockImplementation(async (_task, _input, opts) =>
            opts.idempotencyKey === 'library-ingest:file-library-scan:path-existing'
                ? { runId: 'scheduled-run', deduped: true }
                : { runId: 'duplicate-run', deduped: false },
        );
        const res = await callPost({ path: '/data/movies', mediaType: 'movie' });
        expect(await res.json()).toMatchObject({ runId: 'scheduled-run', scanStarted: true });
    });
});
