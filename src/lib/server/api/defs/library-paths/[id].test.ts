// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/library-paths/[id].ts PATCH (update a library path).
 *
 * The PATCH gate previously stripped `libraryGroupId` (so the documented
 * group-reassign capability was dead) and accepted a camelCase `mediaType` the
 * snake_case UpdateLibraryPathParams never read. These tests lock the activated
 * behaviour: `libraryGroupId` (a UUID) reaches `library_group_id`, `mediaType`
 * maps to `media_type`, and absent fields stay undefined.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';

const mockGetDb = vi.fn();
vi.mock('$lib/server/database/index.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

const mockGetLibraryPathById = vi.fn();
vi.mock('$lib/server/database/queries/library-paths.queries.js', () => ({
    getLibraryPathById: (...args: unknown[]) => mockGetLibraryPathById(...args),
}));

// The v1 handlers delegate to the shared folder service (same rules as the
// admin surface); these tests pin the wire mapping. The rules themselves are
// covered by library-folder.service tests.
const mockUpdateLibraryPath = vi.fn();
const mockDeleteFolder = vi.fn();
vi.mock('$lib/server/services/library-folder.service.js', () => ({
    updateLibraryFolder: async (...args: unknown[]) => {
        const row = await mockUpdateLibraryPath(...args);
        return row
            ? { ok: true, value: row }
            : { ok: false, problem: new Response(null, { status: 404 }) };
    },
    deleteLibraryFolder: (...args: unknown[]) => mockDeleteFolder(...args),
}));

const { def } = await import('./[id].js');

const PATH_ID = '99999999-8888-4777-a666-555555555555';
const OLD_GROUP_ID = '11111111-2222-4333-8444-555555555555';
const NEW_GROUP_ID = '22222222-3333-4444-8555-666666666666';

function makeRow(overrides: Record<string, unknown> = {}) {
    return {
        id: PATH_ID,
        path: '/data/movies',
        media_type: 'movie',
        language: 'en',
        provider: 'tmdb',
        enabled: true,
        provider_path: null,
        library_group_id: OLD_GROUP_ID,
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

function makeEvent(): RequestEvent {
    return { params: { id: PATH_ID }, locals: {} } as unknown as RequestEvent;
}

function callPatch(body: unknown): Promise<Response> {
    const handler = def.handlers.PATCH!;
    return Promise.resolve(handler(makeEvent(), makeCtx(body)));
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue({});
    mockUpdateLibraryPath.mockResolvedValue(makeRow({ library_group_id: NEW_GROUP_ID }));
});

describe('PATCH /library-paths/{id} request schema', () => {
    it('accepts a libraryGroupId reassignment', () => {
        expect(bodySchema.safeParse({ libraryGroupId: NEW_GROUP_ID }).success).toBe(true);
    });

    it('accepts a mediaType change', () => {
        expect(bodySchema.safeParse({ mediaType: 'tv' }).success).toBe(true);
    });

    it('rejects a non-UUID libraryGroupId', () => {
        expect(bodySchema.safeParse({ libraryGroupId: '42' }).success).toBe(false);
    });

    it('rejects a mediaType outside the LibraryPathMediaType union', () => {
        expect(bodySchema.safeParse({ mediaType: 'podcast' }).success).toBe(false);
    });
});

describe('PATCH /library-paths/{id} handler', () => {
    it('passes libraryGroupId through and maps mediaType to media_type', async () => {
        const response = await callPatch({
            libraryGroupId: NEW_GROUP_ID,
            mediaType: 'tv',
            enabled: false,
        });

        expect(response.status).toBe(200);
        expect(mockUpdateLibraryPath).toHaveBeenCalledTimes(1);
        const [, id, params] = mockUpdateLibraryPath.mock.calls[0];
        expect(id).toBe(PATH_ID);
        expect(params).toEqual({
            path: undefined,
            enabled: false,
            media_type: 'tv',
            library_group_id: NEW_GROUP_ID,
        });

        const payload = (await response.json()) as { path: Record<string, unknown> };
        expect(payload.path.libraryGroupId).toBe(NEW_GROUP_ID);
    });

    it('leaves group/media untouched for an enabled-only toggle', async () => {
        mockUpdateLibraryPath.mockResolvedValue(makeRow({ enabled: false }));

        await callPatch({ enabled: false });

        const [, , params] = mockUpdateLibraryPath.mock.calls[0];
        expect(params).toEqual({
            path: undefined,
            enabled: false,
            media_type: undefined,
            library_group_id: undefined,
        });
    });

    it('returns 404 when the path does not exist', async () => {
        mockUpdateLibraryPath.mockResolvedValue(null);

        const response = await callPatch({ enabled: false });

        expect(response.status).toBe(404);
    });
});

describe('DELETE /library-paths/{id} handler', () => {
    it('passes force through and answers 204', async () => {
        mockDeleteFolder.mockResolvedValue({
            ok: true,
            value: { filesToDetach: 3, scansCancelled: 1, uploadsAborted: 0 },
        });
        const res = await Promise.resolve(
            def.handlers.DELETE!(makeEvent(), {
                surface: 'v1',
                input: { query: { force: '1' } },
            } as unknown as ApiContext),
        );
        expect(res.status).toBe(204);
        expect(mockDeleteFolder).toHaveBeenCalledWith(
            expect.anything(),
            PATH_ID,
            expect.objectContaining({ force: true }),
        );
    });

    it('returns the service problem (409 while busy)', async () => {
        mockDeleteFolder.mockResolvedValue({
            ok: false,
            problem: new Response(null, { status: 409 }),
        });
        const res = await Promise.resolve(
            def.handlers.DELETE!(makeEvent(), {
                surface: 'v1',
                input: { query: {} },
            } as unknown as ApiContext),
        );
        expect(res.status).toBe(409);
    });
});
