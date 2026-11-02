// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for POST /api/admin/library-paths, covering the two behaviours
 * added by the library-sources restructure (step 1):
 *   - provider/fallback_providers default from the group's EXISTING folders
 *     when the body omits them and the group is non-empty (still 'tmdb'/[]
 *     for a brand-new/empty group);
 *   - a provider/fallback_providers mismatch against the group is rejected,
 *     the same way media_type already is.
 *
 * Fixture group/folder names and paths deliberately don't describe a media
 * type or provider (e.g. "Family Vault" / "/srv/stuff/a") — this handler must
 * never infer anything from them, only from stored fields.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const {
    mockGetDb,
    mockGetAllLibraryPaths,
    mockGetLibraryPathsByGroup,
    mockCreateLibraryPath,
    mockValidateGroupConsistency,
    mockValidateGroupProviderConsistency,
    mockGetLibraryGroupById,
    mockAfterLibraryPathChanged,
    mockGetRemoteLibrarySource,
} = vi.hoisted(() => ({
    mockGetDb: vi.fn(),
    mockGetAllLibraryPaths: vi.fn(),
    mockGetLibraryPathsByGroup: vi.fn(),
    mockCreateLibraryPath: vi.fn(),
    mockValidateGroupConsistency: vi.fn(),
    mockValidateGroupProviderConsistency: vi.fn(),
    mockGetLibraryGroupById: vi.fn(),
    mockAfterLibraryPathChanged: vi.fn(async () => {}),
    mockGetRemoteLibrarySource: vi.fn(),
}));

vi.mock('$lib/server/config.js', () => ({ config: { TMDB_LANGUAGE: 'de-DE' } }));

vi.mock('$lib/server/database/connection.js', () => ({ getDb: mockGetDb }));
vi.mock('$lib/server/database/queries/library-paths.queries.js', async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import('$lib/server/database/queries/library-paths.queries.js')
        >();
    return {
        ...actual,
        getAllLibraryPaths: mockGetAllLibraryPaths,
        getLibraryPathsByGroup: mockGetLibraryPathsByGroup,
        createLibraryPath: mockCreateLibraryPath,
        validateGroupConsistency: mockValidateGroupConsistency,
        validateGroupProviderConsistency: mockValidateGroupProviderConsistency,
    };
});
vi.mock('$lib/server/database/queries/library-groups.queries.js', () => ({
    getLibraryGroupById: mockGetLibraryGroupById,
}));
vi.mock('$lib/server/services/library-path-sync.service.js', () => ({
    afterLibraryPathChanged: mockAfterLibraryPathChanged,
}));
vi.mock('$lib/server/services/remote-library-sources.js', () => ({
    getRemoteLibrarySource: mockGetRemoteLibrarySource,
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

import { def } from './library-paths.js';

function call(body: Record<string, unknown>) {
    return def.handlers.POST!(
        { locals: {} } as unknown as RequestEvent,
        { input: { body } } as never,
    );
}

const GROUP = { id: 'grp-1', name: 'Family Vault' };

function folderRow(over: Record<string, unknown> = {}) {
    return {
        id: 'path-1',
        path: '/srv/stuff/a',
        media_type: 'movie',
        provider: 'tmdb',
        fallback_providers: [],
        library_group_id: 'grp-1',
        enabled: true,
        ...over,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue({});
    mockGetLibraryGroupById.mockResolvedValue(GROUP);
    mockGetLibraryPathsByGroup.mockResolvedValue([]);
    mockValidateGroupConsistency.mockResolvedValue(null);
    mockValidateGroupProviderConsistency.mockResolvedValue(null);
    mockGetRemoteLibrarySource.mockReturnValue(undefined);
    mockCreateLibraryPath.mockImplementation(async (_sql, params) => ({
        id: 'new-path',
        created_at: new Date('2026-01-01'),
        updated_at: new Date('2026-01-01'),
        ...params,
    }));
});

describe('POST /api/admin/library-paths — metadata language', () => {
    it.each([undefined, '', '  '])(
        'inherits effective TMDB language when language=%s',
        async (language) => {
            await call({
                path: '/srv/stuff/a',
                media_type: 'movie',
                library_group_id: 'grp-1',
                language,
            });
            expect(mockCreateLibraryPath).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ language: 'de' }),
            );
        },
    );

    it('keeps an explicit per-library language', async () => {
        await call({
            path: '/srv/stuff/a',
            media_type: 'movie',
            library_group_id: 'grp-1',
            language: 'fr-FR',
        });
        expect(mockCreateLibraryPath).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ language: 'fr-FR' }),
        );
    });
});

describe('POST /api/admin/library-paths — provider defaulting', () => {
    it('defaults provider/fallback_providers to tmdb/[] for a brand-new group', async () => {
        mockGetLibraryPathsByGroup.mockResolvedValue([]);
        await call({
            path: '/srv/stuff/a',
            media_type: 'movie',
            library_group_id: 'grp-1',
        });
        expect(mockCreateLibraryPath).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ provider: 'tmdb', fallback_providers: [] }),
        );
    });

    it("defaults provider/fallback_providers from the group's existing folders when omitted", async () => {
        mockGetLibraryPathsByGroup.mockResolvedValue([
            folderRow({ provider: 'anidb', fallback_providers: ['tmdb'] }),
        ]);
        await call({
            path: '/srv/stuff/b',
            media_type: 'movie',
            library_group_id: 'grp-1',
        });
        expect(mockCreateLibraryPath).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ provider: 'anidb', fallback_providers: ['tmdb'] }),
        );
    });

    it('an explicit provider in the body overrides the group default', async () => {
        mockGetLibraryPathsByGroup.mockResolvedValue([folderRow({ provider: 'anidb' })]);
        await call({
            path: '/srv/stuff/b',
            media_type: 'movie',
            library_group_id: 'grp-1',
            provider: 'jellyfin',
        });
        expect(mockCreateLibraryPath).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ provider: 'jellyfin' }),
        );
    });

    it('rejects a provider mismatch against the group', async () => {
        mockValidateGroupProviderConsistency.mockResolvedValue(
            'Library already uses the anidb provider — cannot mix providers within a library',
        );
        const res = (await call({
            path: '/srv/stuff/b',
            media_type: 'movie',
            library_group_id: 'grp-1',
            provider: 'jellyfin',
        })) as Response;
        expect(res.status).toBe(422);
        expect(mockCreateLibraryPath).not.toHaveBeenCalled();
    });
});

describe('POST /api/admin/library-paths — audiobooks only from AudiobookShelf', () => {
    it('rejects an audiobook library from a local folder, naming AudiobookShelf', async () => {
        const res = (await call({
            path: '/srv/stuff/a',
            media_type: 'audiobook',
            library_group_id: 'grp-1',
            provider: 'musicbrainz',
        })) as Response;
        expect(res.status).toBe(422);
        expect(JSON.stringify(await res.json())).toContain('AudiobookShelf');
        expect(mockCreateLibraryPath).not.toHaveBeenCalled();
    });

    it('rejects it when the provider is omitted and defaults to tmdb', async () => {
        const res = (await call({
            path: '/srv/stuff/a',
            media_type: 'audiobook',
            library_group_id: 'grp-1',
        })) as Response;
        expect(res.status).toBe(422);
        expect(mockCreateLibraryPath).not.toHaveBeenCalled();
    });

    it('still creates an audiobook library from AudiobookShelf', async () => {
        mockGetRemoteLibrarySource.mockReturnValue({
            label: 'AudiobookShelf',
            listLibraries: async () => ({
                status: 'ok',
                libraries: [{ id: 'abs-lib', name: 'Books', supported: true }],
            }),
            pathFor: (id: string) => `abs://${id}`,
        });
        const res = (await call({
            media_type: 'audiobook',
            library_group_id: 'grp-1',
            provider: 'audiobookshelf',
            remote_library_id: 'abs-lib',
        })) as Response;
        expect(res.status).toBe(201);
        expect(mockCreateLibraryPath).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ path: 'abs://abs-lib', media_type: 'audiobook' }),
        );
    });
});
