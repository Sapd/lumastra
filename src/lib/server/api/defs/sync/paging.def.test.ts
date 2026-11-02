// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const { readLibrary, readState } = vi.hoisted(() => ({ readLibrary: vi.fn(), readState: vi.fn() }));
vi.mock('$lib/server/database/connection', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/services/sync-changes.service', () => ({
    readSyncLibrary: readLibrary,
    readSyncUserState: readState,
    isSyncCredential: () => true,
    SyncReadError: class extends Error {},
    syncErrorResponse: () => new Response(null, { status: 410 }),
}));
import { def as library } from './library';
import { def as state } from './user-state';

beforeEach(() => {
    vi.clearAllMocks();
    readLibrary.mockResolvedValue({ items: [], page: { limit: 1, hasMore: false } });
    readState.mockResolvedValue({ items: [], page: { limit: 1, hasMore: false } });
});

function event(path: string): RequestEvent {
    return {
        url: new URL(`https://example.test${path}`),
        locals: { user: { userId: 'u1' } },
    } as unknown as RequestEvent;
}

describe.each([
    { path: 'library', kind: 'movie', def: library, read: readLibrary },
    { path: 'user-state', kind: 'rating', def: state, read: readState },
])('sync $path continuation', ({ path, kind, def, read }) => {
    it.each(['/api', '/api/v1'])('accepts only cursor continuation on %s', async (prefix) => {
        const response = await def.handlers.GET!(
            event(`${prefix}/sync/${path}?kind=${kind}&limit=1&cursor=opaque`),
            { surface: prefix === '/api' ? 'internal' : 'v1' },
        );
        expect(response.status).toBe(200);
        expect(read).toHaveBeenCalledWith(expect.objectContaining({ cursor: 'opaque', limit: 1 }));
        expect(await response.json()).toEqual({ items: [], page: { limit: 1, hasMore: false } });
    });
    it.each(['after', 'before', 'since'])(
        'rejects retired %s instead of silently restarting the snapshot',
        async (field) => {
            const response = await def.handlers.GET!(
                event(`/api/v1/sync/${path}?kind=${kind}&${field}=old`),
                { surface: 'v1' },
            );
            expect(response.status).toBe(422);
            expect(read).not.toHaveBeenCalled();
        },
    );
});
