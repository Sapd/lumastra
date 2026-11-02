// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PATCH /api/admin/libraries/[id] — the def's own responsibility is thin:
 * call the service, map 404/409, shape the response. The transactional
 * fan-out and remote-conflict rule are covered by
 * `library-update.service.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const { mockGetDb, mockUpdateLibrary, mockAuditLog } = vi.hoisted(() => ({
    mockGetDb: vi.fn(),
    mockUpdateLibrary: vi.fn(),
    mockAuditLog: vi.fn(),
}));

vi.mock('$lib/server/utils/audit-log.js', () => ({
    auditLog: mockAuditLog,
    auditActor: () => ({ username: 'someone' }),
}));

vi.mock('$lib/server/database/connection.js', () => ({ getDb: mockGetDb }));
vi.mock('$lib/server/services/library-update.service.js', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/services/library-update.service.js')>();
    return {
        ...actual,
        updateLibrary: mockUpdateLibrary,
    };
});

import { def } from './libraries-item.js';

function call(id: string, body: Record<string, unknown>, scopes?: string[]) {
    const event = { locals: scopes ? { principal: { scopes } } : {} } as unknown as RequestEvent;
    return def.handlers.PATCH!(event, { input: { params: { id }, body } } as never);
}

// Name/path deliberately don't describe their type/provider — nothing in this
// def may key off them.
const GROUP = { id: 'grp-1', name: 'Family Vault', display_name: 'Family Vault' };
const PATH = { id: 'path-1', path: '/srv/stuff/a', library_group_id: 'grp-1' };

describe('PATCH /api/admin/libraries/[id]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetDb.mockReturnValue({});
    });

    it('503s when the database is unavailable', async () => {
        mockGetDb.mockReturnValue(null);
        const res = (await call('grp-1', { name: 'X' })) as Response;
        expect(res.status).toBe(503);
    });

    it('404s when the library does not exist', async () => {
        mockUpdateLibrary.mockResolvedValue(null);
        const res = (await call('missing', { name: 'X' })) as Response;
        expect(res.status).toBe(404);
    });

    it('returns the updated group and paths on success', async () => {
        mockUpdateLibrary.mockResolvedValue({
            group: {
                ...GROUP,
                sort_order: 0,
                created_at: new Date('2026-01-01'),
                updated_at: new Date('2026-01-02'),
            },
            paths: [
                {
                    ...PATH,
                    media_type: 'movie',
                    language: 'en',
                    provider: 'tmdb',
                    enabled: true,
                    edition_label: null,
                    scan_chapters: false,
                    fallback_providers: [],
                    source_prefix: null,
                    created_at: new Date('2026-01-01'),
                    updated_at: new Date('2026-01-02'),
                },
            ],
        });

        const res = (await call('grp-1', { name: 'New Name' })) as Response;
        expect(res.status).toBe(200);
        const body = (await res.json()) as { group: { id: string }; paths: { id: string }[] };
        expect(body.group.id).toBe('grp-1');
        expect(body.paths).toHaveLength(1);
    });

    it('maps a remote-library conflict to a 409', async () => {
        const { RemoteLibraryConflictError } =
            await import('$lib/server/services/library-update.service.js');
        mockUpdateLibrary.mockRejectedValue(
            new RemoteLibraryConflictError('cannot repoint a remote folder'),
        );
        const res = (await call('grp-1', { provider: 'tmdb' })) as Response;
        expect(res.status).toBe(409);
    });

    it('rethrows an unexpected error', async () => {
        mockUpdateLibrary.mockRejectedValue(new Error('boom'));
        await expect(call('grp-1', { name: 'X' })).rejects.toThrow('boom');
    });
});

// Access is its own privilege: PUT /api/admin/library-group-permissions needs
// access:admin, this endpoint only library:admin. Folding access into the
// library save must not widen who can change it.
describe('PATCH /api/admin/libraries/[id] — access (allowed_groups)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetDb.mockReturnValue({});
        mockUpdateLibrary.mockResolvedValue({
            group: {
                ...GROUP,
                sort_order: 0,
                created_at: new Date('2026-01-01'),
                updated_at: new Date('2026-01-02'),
            },
            paths: [],
        });
    });

    it('refuses allowed_groups from a caller with library:admin but not access:admin', async () => {
        const res = (await call('grp-1', { allowed_groups: ['kids'] }, [
            'library:admin',
        ])) as Response;
        expect(res.status).toBe(403);
        expect(mockUpdateLibrary).not.toHaveBeenCalled();
    });

    it('refuses allowed_groups when no principal proves the scope', async () => {
        const res = (await call('grp-1', { allowed_groups: [] })) as Response;
        expect(res.status).toBe(403);
        expect(mockUpdateLibrary).not.toHaveBeenCalled();
    });

    it('saves and audits allowed_groups for an access admin', async () => {
        const res = (await call('grp-1', { name: 'Evening', allowed_groups: ['kids'] }, [
            'library:admin',
            'access:admin',
        ])) as Response;
        expect(res.status).toBe(200);
        expect(mockUpdateLibrary).toHaveBeenCalledWith(
            expect.anything(),
            'grp-1',
            expect.objectContaining({ allowed_groups: ['kids'] }),
        );
        expect(mockAuditLog).toHaveBeenCalledWith(
            'library_group.update_permissions',
            'grp-1',
            expect.anything(),
            expect.objectContaining({ allowedGroups: ['kids'] }),
        );
    });

    it('does not ask for access:admin when access is not part of the save', async () => {
        const res = (await call('grp-1', { name: 'Evening' }, ['library:admin'])) as Response;
        expect(res.status).toBe(200);
        expect(mockAuditLog).not.toHaveBeenCalled();
    });
});
