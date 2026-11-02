// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';

const q = vi.hoisted(() => ({
    getLibraryPathById: vi.fn(),
    updateLibraryPath: vi.fn(),
    deleteLibraryPath: vi.fn(),
    restampLibraryPathFileGroups: vi.fn(),
    validateGroupConsistency: vi.fn(),
    validateGroupProviderConsistency: vi.fn(),
    getLibraryPathsByGroup: vi.fn(),
    getAllLibraryGroupPermissions: vi.fn(),
    deleteLibraryGroup: vi.fn(),
    getLibraryGroupById: vi.fn(),
    listRuns: vi.fn(),
    cancelRun: vi.fn(),
    startRun: vi.fn(),
    abortUpload: vi.fn(),
    getUploadSessionById: vi.fn(),
    afterLibraryPathChanged: vi.fn(),
    afterLibraryGroupChanged: vi.fn(),
}));

vi.mock('$lib/server/database/queries/library-paths.queries.js', () => ({
    getLibraryPathById: q.getLibraryPathById,
    updateLibraryPath: q.updateLibraryPath,
    deleteLibraryPath: q.deleteLibraryPath,
    restampLibraryPathFileGroups: q.restampLibraryPathFileGroups,
    validateGroupConsistency: q.validateGroupConsistency,
    validateGroupProviderConsistency: q.validateGroupProviderConsistency,
    getLibraryPathsByGroup: q.getLibraryPathsByGroup,
}));
vi.mock('$lib/server/database/queries/library-group-permissions.queries.js', () => ({
    getAllLibraryGroupPermissions: q.getAllLibraryGroupPermissions,
}));
vi.mock('$lib/server/database/queries/library-groups.queries.js', () => ({
    deleteLibraryGroup: q.deleteLibraryGroup,
    getLibraryGroupById: q.getLibraryGroupById,
}));
vi.mock('$lib/server/services/library-path-sync.service.js', () => ({
    afterLibraryPathChanged: q.afterLibraryPathChanged,
    afterLibraryGroupChanged: q.afterLibraryGroupChanged,
}));
vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: { listRuns: q.listRuns, cancelRun: q.cancelRun, startRun: q.startRun },
}));
vi.mock('$lib/server/tasks/builtin/native/media-sources/file-scanner.js', () => ({
    requestFileScannerAbortForKey: vi.fn(),
}));
vi.mock('$lib/server/services/upload-session.service.js', () => ({ abortUpload: q.abortUpload }));
vi.mock('$lib/server/database/queries/upload-sessions.queries.js', () => ({
    getUploadSessionById: q.getUploadSessionById,
}));
vi.mock('$lib/server/services/library-root-validation.js', () => ({
    checkLibraryRootForApi: async (_s: unknown, p: string) => ({ path: p }),
}));

import {
    deleteLibraryFolder,
    deleteLibraryGroupChecked,
    updateLibraryFolder,
} from './library-folder.service.js';

const PATH_ID = '00000000-0000-4000-8000-000000000001';
const KIDS = '00000000-0000-4000-8000-0000000000a1';
const OPEN = '00000000-0000-4000-8000-0000000000a2';

/** Fake sql: tagged template answers a file count, begin() runs the callback. */
function fakeSql(state: { uploads?: string[]; files?: number } = {}): postgres.Sql {
    const fn = (async (strings: TemplateStringsArray) => {
        const text = strings.join(' ');
        if (text.includes('FROM upload_sessions')) {
            return (state.uploads ?? []).map((id) => ({ id }));
        }
        if (text.includes('COUNT(*)')) return [{ n: state.files ?? 0 }];
        return [];
    }) as unknown as postgres.Sql & { begin: unknown };
    (fn as unknown as { begin: (cb: (tx: unknown) => unknown) => unknown }).begin = (cb) => cb(fn);
    return fn;
}

function row(over: Record<string, unknown> = {}) {
    return {
        id: PATH_ID,
        path: '/data/movies',
        media_type: 'movie',
        provider: 'tmdb',
        fallback_providers: [],
        library_group_id: OPEN,
        enabled: true,
        provider_path: null,
        ...over,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    q.getLibraryPathById.mockResolvedValue(row());
    q.updateLibraryPath.mockImplementation(async (_s, _id, p) => ({ ...row(), ...p }));
    q.deleteLibraryPath.mockResolvedValue(true);
    q.validateGroupConsistency.mockResolvedValue(null);
    q.validateGroupProviderConsistency.mockResolvedValue(null);
    q.getAllLibraryGroupPermissions.mockResolvedValue([
        { library_group_id: KIDS, allowed_groups: ['kids'] },
    ]);
    q.listRuns.mockResolvedValue({ runs: [] });
    q.cancelRun.mockResolvedValue({ accepted: true });
    q.startRun.mockResolvedValue({ runId: 'run-1' });
    q.getLibraryPathsByGroup.mockResolvedValue([]);
    q.deleteLibraryGroup.mockResolvedValue(true);
    q.getLibraryGroupById.mockResolvedValue({ id: OPEN });
});

describe('access scope for access-changing library operations', () => {
    it('moving a folder into a restricted library needs access:admin', async () => {
        const res = await updateLibraryFolder(fakeSql(), PATH_ID, { library_group_id: KIDS }, [
            'library:admin',
        ]);
        expect(res.ok).toBe(false);
        expect(!res.ok && res.problem.status).toBe(403);
        expect(q.updateLibraryPath).not.toHaveBeenCalled();
    });

    it('a move between unrestricted libraries needs only library:admin', async () => {
        const other = '00000000-0000-4000-8000-0000000000a3';
        const res = await updateLibraryFolder(fakeSql(), PATH_ID, { library_group_id: other }, [
            'library:admin',
        ]);
        expect(res.ok).toBe(true);
        expect(q.restampLibraryPathFileGroups).toHaveBeenCalledWith(
            expect.anything(),
            '/data/movies',
            other,
        );
    });

    it('with access:admin the restricted move goes through', async () => {
        const res = await updateLibraryFolder(fakeSql(), PATH_ID, { library_group_id: KIDS }, [
            'library:admin',
            'access:admin',
        ]);
        expect(res.ok).toBe(true);
    });

    it('deleting a folder of a restricted library needs access:admin', async () => {
        q.getLibraryPathById.mockResolvedValue(row({ library_group_id: KIDS }));
        const res = await deleteLibraryFolder(fakeSql(), PATH_ID, { scopes: ['library:admin'] });
        expect(!res.ok && res.problem.status).toBe(403);
        expect(q.deleteLibraryPath).not.toHaveBeenCalled();
    });

    it('deleting a restricted library needs access:admin', async () => {
        const res = await deleteLibraryGroupChecked(fakeSql(), KIDS, ['library:admin']);
        expect(!res.ok && res.problem.status).toBe(403);
        expect(q.deleteLibraryGroup).not.toHaveBeenCalled();
    });
});

describe('deleteLibraryFolder', () => {
    it('refuses with 409 while a scan of the folder runs', async () => {
        q.listRuns.mockResolvedValue({
            runs: [{ id: 'scan-1', input: { libraryPathId: PATH_ID } }],
        });
        const res = await deleteLibraryFolder(fakeSql(), PATH_ID, {});
        expect(!res.ok && res.problem.status).toBe(409);
        expect(q.deleteLibraryPath).not.toHaveBeenCalled();
    });

    it('with force cancels the scan, aborts the upload, deletes, and detaches the files', async () => {
        q.listRuns.mockResolvedValue({
            runs: [
                { id: 'scan-1', input: { libraryPathId: PATH_ID } },
                { id: 'scan-other', input: { libraryPathId: 'someone-else' } },
            ],
        });
        q.getUploadSessionById.mockResolvedValue({ id: 'up-1' });
        const res = await deleteLibraryFolder(fakeSql({ uploads: ['up-1'], files: 12 }), PATH_ID, {
            force: true,
        });

        expect(res.ok && res.value).toEqual({
            filesToDetach: 12,
            detachRunId: 'run-1',
            scansCancelled: 1,
            uploadsAborted: 1,
        });
        expect(q.cancelRun).toHaveBeenCalledTimes(1);
        expect(q.cancelRun).toHaveBeenCalledWith('scan-1', expect.anything());
        expect(q.abortUpload).toHaveBeenCalledTimes(1);
        expect(q.startRun).toHaveBeenCalledWith(
            'library-folder-detach',
            { path: '/data/movies' },
            expect.anything(),
        );
        expect(q.afterLibraryPathChanged).toHaveBeenCalled();
    });

    it('starts no detach run for a folder with no scanned files', async () => {
        const res = await deleteLibraryFolder(fakeSql({ files: 0 }), PATH_ID, {});
        expect(res.ok && res.value.detachRunId).toBeUndefined();
        expect(q.startRun).not.toHaveBeenCalled();
    });

    it('answers 404 for a non-UUID id without touching the database', async () => {
        const res = await deleteLibraryFolder(fakeSql(), 'nope', {});
        expect(!res.ok && res.problem.status).toBe(404);
        expect(q.getLibraryPathById).not.toHaveBeenCalled();
    });
});

describe('deleteLibraryGroupChecked', () => {
    it('refuses with 409 while the library has folders', async () => {
        q.getLibraryPathsByGroup.mockResolvedValue([row()]);
        const res = await deleteLibraryGroupChecked(fakeSql(), OPEN, ['admin']);
        expect(!res.ok && res.problem.status).toBe(409);
    });

    it('deletes an empty library and clears the library caches', async () => {
        const res = await deleteLibraryGroupChecked(fakeSql(), OPEN, ['library:admin']);
        expect(res.ok).toBe(true);
        expect(q.afterLibraryGroupChanged).toHaveBeenCalled();
    });
});

it('rejects a nonexistent destination library group with 422 before writing', async () => {
    q.getLibraryGroupById.mockResolvedValue(null);
    const res = await updateLibraryFolder(fakeSql(), PATH_ID, { library_group_id: KIDS }, [
        'admin',
    ]);
    expect(!res.ok && res.problem.status).toBe(422);
    expect(q.updateLibraryPath).not.toHaveBeenCalled();
});
