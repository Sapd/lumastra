// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for PATCH /api/admin/library-paths/[id], covering the new
 * provider/fallback_providers consistency check added alongside the existing
 * media_type one. Fixture path deliberately doesn't describe a media type or
 * provider ("/srv/stuff/a") — the handler must key only off stored fields.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const {
    mockGetDb,
    mockGetLibraryPathById,
    mockUpdateLibraryPath,
    mockValidateGroupConsistency,
    mockValidateGroupProviderConsistency,
    mockAfterLibraryPathChanged,
    mockRestamp,
} = vi.hoisted(() => ({
    mockRestamp: vi.fn(async () => 0),
    mockGetDb: vi.fn(),
    mockGetLibraryPathById: vi.fn(),
    mockUpdateLibraryPath: vi.fn(),
    mockValidateGroupConsistency: vi.fn(),
    mockValidateGroupProviderConsistency: vi.fn(),
    mockAfterLibraryPathChanged: vi.fn(async () => {}),
}));

vi.mock('$lib/server/database/queries/library-groups.queries.js', () => ({
    getLibraryGroupById: vi.fn(async (_sql: unknown, id: string) => ({ id })),
}));

vi.mock('$lib/server/database/connection.js', () => ({ getDb: mockGetDb }));
vi.mock('$lib/server/database/queries/library-paths.queries.js', async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import('$lib/server/database/queries/library-paths.queries.js')
        >();
    return {
        ...actual,
        getLibraryPathById: mockGetLibraryPathById,
        updateLibraryPath: mockUpdateLibraryPath,
        validateGroupConsistency: mockValidateGroupConsistency,
        validateGroupProviderConsistency: mockValidateGroupProviderConsistency,
        restampLibraryPathFileGroups: mockRestamp,
    };
});
vi.mock('$lib/server/services/library-path-sync.service.js', () => ({
    afterLibraryPathChanged: mockAfterLibraryPathChanged,
}));
const mockPermissions = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
vi.mock('$lib/server/database/queries/library-group-permissions.queries.js', () => ({
    getAllLibraryGroupPermissions: mockPermissions,
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

import { def } from './library-paths-item.js';

const PATH_ID = '00000000-0000-4000-8000-000000000001';

function call(id: string, body: Record<string, unknown>) {
    return def.handlers.PATCH!(
        { locals: {} } as unknown as RequestEvent,
        { input: { params: { id }, body } } as never,
    );
}

function currentRow(over: Record<string, unknown> = {}) {
    return {
        id: 'path-1',
        path: '/srv/stuff/a',
        media_type: 'movie',
        provider: 'tmdb',
        fallback_providers: [],
        library_group_id: '00000000-0000-4000-8000-0000000000bb',
        enabled: true,
        provider_path: null,
        ...over,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    const tx = { tx: true };
    mockGetDb.mockReturnValue({ begin: async (fn: (t: unknown) => unknown) => fn(tx) });
    mockGetLibraryPathById.mockResolvedValue(currentRow());
    mockValidateGroupConsistency.mockResolvedValue(null);
    mockValidateGroupProviderConsistency.mockResolvedValue(null);
    mockUpdateLibraryPath.mockImplementation(async (_sql, id, params) => ({
        ...currentRow({ id }),
        ...params,
        created_at: new Date('2026-01-01'),
        updated_at: new Date('2026-01-01'),
    }));
});

describe('PATCH /api/admin/library-paths/[id] — provider consistency', () => {
    it('checks provider consistency when provider changes', async () => {
        await call(PATH_ID, { provider: 'jellyfin' });
        expect(mockValidateGroupProviderConsistency).toHaveBeenCalledWith(
            expect.anything(),
            '00000000-0000-4000-8000-0000000000bb',
            'jellyfin',
            [],
            PATH_ID,
        );
    });

    it('checks provider consistency when only fallback_providers changes', async () => {
        await call(PATH_ID, { fallback_providers: ['anidb'] });
        expect(mockValidateGroupProviderConsistency).toHaveBeenCalledWith(
            expect.anything(),
            '00000000-0000-4000-8000-0000000000bb',
            'tmdb',
            ['anidb'],
            PATH_ID,
        );
    });

    it('rejects a provider that would conflict with the group', async () => {
        mockValidateGroupProviderConsistency.mockResolvedValue(
            'Library already uses the tmdb provider — cannot mix providers within a library',
        );
        const res = (await call(PATH_ID, { provider: 'jellyfin' })) as Response;
        expect(res.status).toBe(422);
        expect(mockUpdateLibraryPath).not.toHaveBeenCalled();
    });

    it('does not check provider consistency for an unrelated field change', async () => {
        await call(PATH_ID, { language: 'de' });
        expect(mockValidateGroupProviderConsistency).not.toHaveBeenCalled();
    });
});

describe('PATCH /api/admin/library-paths/[id] — audiobooks only from AudiobookShelf', () => {
    it('rejects changing a folder library to audiobook', async () => {
        const res = (await call(PATH_ID, { media_type: 'audiobook' })) as Response;
        expect(res.status).toBe(422);
        expect(JSON.stringify(await res.json())).toContain('AudiobookShelf');
        expect(mockUpdateLibraryPath).not.toHaveBeenCalled();
    });

    it('keeps an existing local audiobook folder editable', async () => {
        mockGetLibraryPathById.mockResolvedValue(
            currentRow({ media_type: 'audiobook', provider: 'musicbrainz' }),
        );
        const res = (await call(PATH_ID, {
            media_type: 'audiobook',
            library_group_id: '00000000-0000-4000-8000-000000000001',
        })) as Response;
        expect(res.status).toBe(200);
        expect(mockUpdateLibraryPath).toHaveBeenCalled();
    });

    it('lets an existing local audiobook folder move to music', async () => {
        mockGetLibraryPathById.mockResolvedValue(
            currentRow({ media_type: 'audiobook', provider: 'musicbrainz' }),
        );
        const res = (await call(PATH_ID, { media_type: 'music' })) as Response;
        expect(res.status).toBe(200);
    });
});

describe('PATCH /api/admin/library-paths/[id] — moving a folder to another library', () => {
    const NEW_GROUP = '00000000-0000-4000-8000-0000000000aa';

    it('re-stamps the folder’s scanned files with the new library group', async () => {
        const res = (await call(PATH_ID, { library_group_id: NEW_GROUP })) as Response;
        expect(res.status).toBe(200);
        expect(mockRestamp).toHaveBeenCalledWith(expect.anything(), '/srv/stuff/a', NEW_GROUP);
    });

    it('does not touch files when the group is unchanged or not part of the patch', async () => {
        await call(PATH_ID, { library_group_id: '00000000-0000-4000-8000-0000000000bb' });
        await call(PATH_ID, { language: 'de' });
        expect(mockRestamp).not.toHaveBeenCalled();
    });
});

describe('PATCH/DELETE /api/admin/library-paths/[id] — error mapping', () => {
    it('returns 409 when the new path collides with another folder', async () => {
        mockUpdateLibraryPath.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));
        const res = (await call(PATH_ID, { path: '/srv/other' })) as Response;
        expect(res.status).toBe(409);
    });

    it('returns 404 for a non-UUID id instead of a database error', async () => {
        const res = (await call('not-a-uuid', { enabled: false })) as Response;
        expect(res.status).toBe(404);
        expect(mockUpdateLibraryPath).not.toHaveBeenCalled();
    });
});
