// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/library-paths/index.ts POST (add a library path).
 *
 * This handler previously cast its camelCase wire body straight to the
 * snake_case CreateLibraryPathParams (`body as CreateLibraryPathParams`), so
 * createLibraryPath read `params.media_type` / `params.library_group_id` as
 * undefined and the INSERT sent undefined for NOT-NULL/FK columns — the
 * endpoint was broken end-to-end and nothing pinned it. These tests lock the
 * corrected behaviour:
 *
 *   1. a valid camelCase body maps to the exact snake_case insert params;
 *   2. a missing/invalid `mediaType` is rejected by the request schema
 *      (mount() turns that into a 422 before the handler runs);
 *   3. unknown library group / group media-type inconsistency return 422,
 *      matching the admin surface (defs/admin/library-paths.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';

vi.mock('$lib/server/config.js', () => ({ config: { TMDB_LANGUAGE: 'de-DE' } }));

const mockGetDb = vi.fn();
vi.mock('$lib/server/database/index.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

const mockGetAllLibraryPaths = vi.fn();
const mockCreateLibraryPath = vi.fn();
const mockValidateGroupConsistency = vi.fn();
const mockValidateGroupProviderConsistency = vi.fn();
vi.mock('$lib/server/database/queries/library-paths.queries.js', () => ({
    getAllLibraryPaths: (...args: unknown[]) => mockGetAllLibraryPaths(...args),
    createLibraryPath: (...args: unknown[]) => mockCreateLibraryPath(...args),
    validateGroupConsistency: (...args: unknown[]) => mockValidateGroupConsistency(...args),
    validateGroupProviderConsistency: (...args: unknown[]) =>
        mockValidateGroupProviderConsistency(...args),
}));

const mockGetLibraryGroupById = vi.fn();
vi.mock('$lib/server/database/queries/library-groups.queries.js', () => ({
    getLibraryGroupById: (...args: unknown[]) => mockGetLibraryGroupById(...args),
}));

const mockAfterLibraryPathChanged = vi.fn();
vi.mock('$lib/server/services/library-path-sync.service.js', () => ({
    afterLibraryPathChanged: (...args: unknown[]) => mockAfterLibraryPathChanged(...args),
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

const { def } = await import('./index.js');

// RFC 4122-conformant UUIDs (zod's .uuid() checks version/variant bits).
const GROUP_ID = '11111111-2222-4333-8444-555555555555';
const PATH_ID = '99999999-8888-4777-a666-555555555555';

/** A library_paths row as createLibraryPath returns it. */
function makeRow(overrides: Record<string, unknown> = {}) {
    return {
        id: PATH_ID,
        path: '/data/movies',
        media_type: 'movie',
        language: 'en',
        provider: 'tmdb',
        enabled: true,
        provider_path: null,
        library_group_id: GROUP_ID,
        edition_label: null,
        scan_chapters: false,
        fallback_providers: [],
        source_prefix: null,
        created_at: new Date('2026-07-01T00:00:00.000Z'),
        updated_at: new Date('2026-07-01T00:00:00.000Z'),
        ...overrides,
    };
}

const bodySchema = def.request!.body!;

function makeCtx(body: unknown): ApiContext {
    return {
        surface: 'v1',
        input: { body, query: undefined, params: undefined },
    } as ApiContext;
}

function callPost(body: unknown): Promise<Response> {
    const handler = def.handlers.POST!;
    return Promise.resolve(handler({} as RequestEvent, makeCtx(body)));
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue({});
    mockGetLibraryGroupById.mockResolvedValue({ id: GROUP_ID, name: 'Movies' });
    mockValidateGroupConsistency.mockResolvedValue(null);
    mockValidateGroupProviderConsistency.mockResolvedValue(null);
    mockCreateLibraryPath.mockResolvedValue(makeRow());
    mockAfterLibraryPathChanged.mockResolvedValue(undefined);
});

describe('POST /library-paths request schema', () => {
    it('accepts a valid camelCase body', () => {
        const result = bodySchema.safeParse({
            path: '/data/movies',
            libraryGroupId: GROUP_ID,
            mediaType: 'movie',
        });
        expect(result.success).toBe(true);
    });

    it('rejects a body with no mediaType', () => {
        const result = bodySchema.safeParse({
            path: '/data/movies',
            libraryGroupId: GROUP_ID,
        });
        expect(result.success).toBe(false);
    });

    it('rejects a mediaType outside the LibraryPathMediaType union', () => {
        const result = bodySchema.safeParse({
            path: '/data/movies',
            libraryGroupId: GROUP_ID,
            mediaType: 'podcast',
        });
        expect(result.success).toBe(false);
    });

    it('rejects a non-UUID libraryGroupId', () => {
        const result = bodySchema.safeParse({
            path: '/data/movies',
            libraryGroupId: '42',
            mediaType: 'movie',
        });
        expect(result.success).toBe(false);
    });

    /**
     * Regression: zod 4's `.uuid()` enforces the RFC 9562 version nibble (1-8)
     * and variant nibble (8/9/a/b), so it rejected hand-seeded ids — the kind
     * migrations and fixtures use — even though postgres stores them happily
     * and the rows are real and reachable. `library_group_id` is an opaque
     * database key: it is compared against ids already in the table and reaches
     * SQL only as a bound parameter, so the version bits carry no meaning here.
     * The schema uses `.guid()`, which keeps the full 8-4-4-4-12 shape check
     * (and the `format: uuid` in the published OpenAPI document) without the
     * version/variant constraint.
     */
    it.each([
        ['migration-seeded group id', '00000000-0000-0000-0000-00000000b002'],
        ['seeded id with a 0 version nibble', '5c000000-0000-0000-8000-00000000b001'],
        ['seeded id with an out-of-range version nibble', '3a000000-0000-9000-0000-00000000b002'],
        ['gen_random_uuid()-style v4 id', '11111111-2222-4333-8444-555555555555'],
    ])('accepts a %s as libraryGroupId', (_label, libraryGroupId) => {
        const result = bodySchema.safeParse({
            path: '/data/movies',
            libraryGroupId,
            mediaType: 'movie',
        });
        expect(result.success).toBe(true);
    });

    /** The relaxed shape check must still reject anything that is not 8-4-4-4-12 hex. */
    it.each([
        ['too few digits in the last group', '00000000-0000-0000-0000-00000000b00'],
        ['trailing garbage', '00000000-0000-0000-0000-00000000b002x'],
        ['non-hex digit', '0000000g-0000-0000-0000-00000000b002'],
        ['missing dashes', '00000000000000000000000000000b002'],
        ['empty string', ''],
        ['sql fragment', "'; DROP TABLE library_paths--"],
    ])('still rejects %s as libraryGroupId', (_label, libraryGroupId) => {
        const result = bodySchema.safeParse({
            path: '/data/movies',
            libraryGroupId,
            mediaType: 'movie',
        });
        expect(result.success).toBe(false);
    });
});

describe('POST /library-paths handler', () => {
    it('maps the camelCase body to snake_case insert params', async () => {
        const response = await callPost({
            path: '/data/movies',
            libraryGroupId: GROUP_ID,
            mediaType: 'movie',
            enabled: false,
        });

        expect(response.status).toBe(201);
        expect(mockCreateLibraryPath).toHaveBeenCalledTimes(1);
        const [, params] = mockCreateLibraryPath.mock.calls[0];
        expect(params).toEqual({
            path: '/data/movies',
            media_type: 'movie',
            language: 'de',
            library_group_id: GROUP_ID,
            enabled: false,
        });

        // Consistency was validated against the group with the mapped media type.
        expect(mockValidateGroupConsistency).toHaveBeenCalledWith(
            expect.anything(),
            GROUP_ID,
            'movie',
        );
        // Path caches were invalidated after the write (parity with admin surface).
        expect(mockAfterLibraryPathChanged).toHaveBeenCalledTimes(1);

        const payload = (await response.json()) as { path: Record<string, unknown> };
        expect(payload.path.id).toBe(PATH_ID);
        expect(payload.path.mediaType).toBe('movie');
        expect(payload.path.libraryGroupId).toBe(GROUP_ID);
    });

    it('returns 422 when the library group does not exist', async () => {
        mockGetLibraryGroupById.mockResolvedValue(null);

        const response = await callPost({
            path: '/data/movies',
            libraryGroupId: GROUP_ID,
            mediaType: 'movie',
        });

        expect(response.status).toBe(422);
        expect(mockCreateLibraryPath).not.toHaveBeenCalled();
        expect(mockAfterLibraryPathChanged).not.toHaveBeenCalled();
    });

    it('returns 422 when the group already holds a different media type', async () => {
        mockValidateGroupConsistency.mockResolvedValue(
            'Library group already contains movie paths — cannot mix media types',
        );

        const response = await callPost({
            path: '/data/series',
            libraryGroupId: GROUP_ID,
            mediaType: 'tv',
        });

        expect(response.status).toBe(422);
        expect(mockCreateLibraryPath).not.toHaveBeenCalled();
    });

    it('returns 503 when the database is unavailable', async () => {
        mockGetDb.mockReturnValue(null);

        const response = await callPost({
            path: '/data/movies',
            libraryGroupId: GROUP_ID,
            mediaType: 'movie',
        });

        expect(response.status).toBe(503);
        expect(mockCreateLibraryPath).not.toHaveBeenCalled();
    });
});
