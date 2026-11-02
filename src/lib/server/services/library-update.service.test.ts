// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the "update a library" service: a Settings save fans
 * media_type/provider/fallback_providers out to every folder of the group in
 * one transaction, refuses to repoint a remote-source folder, and fires the
 * same cache/watcher hooks the group-PATCH and path-PATCH defs do.
 *
 * Fixture names/paths deliberately do NOT describe their type or provider
 * (e.g. a movie library named "Family Vault", folder "/srv/stuff/a") — the
 * service must never key off a name or path string, only stored fields.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';

const getLibraryGroupById = vi.fn();
const updateLibraryGroup = vi.fn();
const getLibraryPathsByGroup = vi.fn();
const updateLibraryPath = vi.fn();
const afterLibraryGroupChanged = vi.fn(async (..._a: unknown[]) => {});
const afterLibraryPathChanged = vi.fn(async (..._a: unknown[]) => {});

vi.mock('$lib/server/database/queries/library-groups.queries.js', () => ({
    getLibraryGroupById: (...a: unknown[]) => getLibraryGroupById(...a),
    updateLibraryGroup: (...a: unknown[]) => updateLibraryGroup(...a),
}));
vi.mock('$lib/server/database/queries/library-paths.queries.js', () => ({
    getLibraryPathsByGroup: (...a: unknown[]) => getLibraryPathsByGroup(...a),
    updateLibraryPath: (...a: unknown[]) => updateLibraryPath(...a),
}));
vi.mock('$lib/server/services/library-path-sync.service.js', () => ({
    afterLibraryGroupChanged: (...a: unknown[]) => afterLibraryGroupChanged(...a),
    afterLibraryPathChanged: (...a: unknown[]) => afterLibraryPathChanged(...a),
}));

import {
    updateLibrary,
    RemoteLibraryConflictError,
    LocalAudiobookLibraryError,
} from './library-update.service.js';

/** Fake sql whose begin() runs the callback with the same handle (single tx). */
function makeFakeSql(): Sql {
    const sql = {
        begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(sql),
    };
    return sql as unknown as Sql;
}

const GROUP = { id: 'grp-1', name: 'Family Vault', display_name: 'Family Vault' };

function folderRow(over: Record<string, unknown> = {}) {
    return {
        id: 'path-1',
        path: '/srv/stuff/a',
        media_type: 'movie',
        provider: 'tmdb',
        fallback_providers: [],
        library_group_id: 'grp-1',
        ...over,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    getLibraryGroupById.mockResolvedValue(GROUP);
    getLibraryPathsByGroup.mockResolvedValue([folderRow()]);
    updateLibraryGroup.mockImplementation(async (_sql: unknown, id: string, params: object) => ({
        ...GROUP,
        id,
        ...params,
    }));
    updateLibraryPath.mockImplementation(async (_sql: unknown, id: string, params: object) => ({
        ...folderRow({ id }),
        ...params,
    }));
});

describe('updateLibrary', () => {
    it('returns null when the group does not exist', async () => {
        getLibraryGroupById.mockResolvedValue(null);
        const result = await updateLibrary(makeFakeSql(), 'missing', { name: 'X' });
        expect(result).toBeNull();
        expect(updateLibraryGroup).not.toHaveBeenCalled();
    });

    it('updates the group row from name/icon/description/max_age_rating', async () => {
        await updateLibrary(makeFakeSql(), 'grp-1', {
            name: 'New Name',
            max_age_rating: 12,
        });
        expect(updateLibraryGroup).toHaveBeenCalledWith(
            expect.anything(),
            'grp-1',
            expect.objectContaining({ name: 'New Name', max_age_rating: 12 }),
        );
    });

    it('fans media_type/provider/fallback_providers out to every folder', async () => {
        getLibraryPathsByGroup.mockResolvedValue([
            folderRow({ id: 'path-1' }),
            folderRow({ id: 'path-2', path: '/srv/stuff/b' }),
        ]);
        const result = await updateLibrary(makeFakeSql(), 'grp-1', {
            media_type: 'tv',
            provider: 'jellyfin',
            fallback_providers: ['tmdb'],
        });
        expect(updateLibraryPath).toHaveBeenCalledTimes(2);
        for (const call of updateLibraryPath.mock.calls) {
            expect(call[2]).toMatchObject({
                media_type: 'tv',
                provider: 'jellyfin',
                fallback_providers: ['tmdb'],
            });
        }
        expect(result?.paths).toHaveLength(2);
    });

    it('leaves folders untouched when the save only changes group-level fields', async () => {
        await updateLibrary(makeFakeSql(), 'grp-1', { description: 'new desc' });
        expect(updateLibraryPath).not.toHaveBeenCalled();
    });

    it('fires both cache/watcher hooks after commit', async () => {
        await updateLibrary(makeFakeSql(), 'grp-1', { name: 'X' });
        expect(afterLibraryGroupChanged).toHaveBeenCalledTimes(1);
        expect(afterLibraryPathChanged).toHaveBeenCalledTimes(1);
    });

    it('rejects changing media_type on a library with a remote-source folder', async () => {
        getLibraryPathsByGroup.mockResolvedValue([
            folderRow({ provider: 'audiobookshelf', media_type: 'audiobook', path: 'abs://xyz' }),
        ]);
        await expect(
            updateLibrary(makeFakeSql(), 'grp-1', { media_type: 'movie' }),
        ).rejects.toBeInstanceOf(RemoteLibraryConflictError);
        expect(updateLibraryGroup).not.toHaveBeenCalled();
    });

    it('rejects changing provider on a library with a remote-source folder', async () => {
        getLibraryPathsByGroup.mockResolvedValue([
            folderRow({ provider: 'audiobookshelf', media_type: 'audiobook', path: 'abs://xyz' }),
        ]);
        await expect(
            updateLibrary(makeFakeSql(), 'grp-1', { provider: 'tmdb' }),
        ).rejects.toBeInstanceOf(RemoteLibraryConflictError);
    });

    it('rejects switching a folder library to a remote provider', async () => {
        await expect(
            updateLibrary(makeFakeSql(), 'grp-1', { provider: 'audiobookshelf' }),
        ).rejects.toBeInstanceOf(RemoteLibraryConflictError);
        expect(updateLibraryGroup).not.toHaveBeenCalled();
    });

    it('allows a settings save on a remote-source library when media_type/provider are unchanged', async () => {
        getLibraryPathsByGroup.mockResolvedValue([
            folderRow({ provider: 'audiobookshelf', media_type: 'audiobook', path: 'abs://xyz' }),
        ]);
        const result = await updateLibrary(makeFakeSql(), 'grp-1', {
            name: 'New Name',
            media_type: 'audiobook',
            provider: 'audiobookshelf',
        });
        expect(result).not.toBeNull();
        expect(updateLibraryGroup).toHaveBeenCalled();
    });

    it('allows a name/description-only save on a remote-source library', async () => {
        getLibraryPathsByGroup.mockResolvedValue([
            folderRow({ provider: 'audiobookshelf', media_type: 'audiobook', path: 'abs://xyz' }),
        ]);
        const result = await updateLibrary(makeFakeSql(), 'grp-1', { name: 'New Name' });
        expect(result).not.toBeNull();
    });
});

describe('updateLibrary — audiobooks only from AudiobookShelf', () => {
    it('rejects turning a folder library into an audiobook library', async () => {
        await expect(
            updateLibrary(makeFakeSql(), 'grp-1', { media_type: 'audiobook' }),
        ).rejects.toBeInstanceOf(LocalAudiobookLibraryError);
        expect(updateLibraryGroup).not.toHaveBeenCalled();
        expect(updateLibraryPath).not.toHaveBeenCalled();
    });

    it('keeps an existing local audiobook library editable', async () => {
        getLibraryPathsByGroup.mockResolvedValue([
            folderRow({ media_type: 'audiobook', provider: 'musicbrainz' }),
        ]);
        const result = await updateLibrary(makeFakeSql(), 'grp-1', {
            name: 'New Name',
            media_type: 'audiobook',
        });
        expect(result).not.toBeNull();
    });

    it('lets an existing local audiobook library change to music', async () => {
        getLibraryPathsByGroup.mockResolvedValue([
            folderRow({ media_type: 'audiobook', provider: 'musicbrainz' }),
        ]);
        const result = await updateLibrary(makeFakeSql(), 'grp-1', { media_type: 'music' });
        expect(result?.paths[0]).toMatchObject({ media_type: 'music' });
    });
});
