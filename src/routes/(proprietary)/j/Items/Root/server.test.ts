// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/** GET /j/Items/Root and the legacy /j/Users/{userId}/Items/Root → the user root folder. */

import type { RequestHandler } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockViews } = vi.hoisted(() => ({ mockViews: vi.fn() }));

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));
vi.mock('$lib/server/database', () => ({ getDb: () => ({}) as never }));
vi.mock('$lib/server/config', () => ({ config: {}, LUMASTRA_MASTER_KEY: 'test-key' }));
vi.mock('$lib/server/config.js', () => ({ config: {}, LUMASTRA_MASTER_KEY: 'test-key' }));
vi.mock('$lib/server/proprietary/jellyfin-compat/library-views-utils', () => ({
    buildLibraryViews: mockViews,
}));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const USER = { username: 'denis', userId: '00000000-0000-0000-0000-0000000000de' };

beforeEach(() => {
    vi.clearAllMocks();
    mockViews.mockResolvedValue([{ Id: 'a' }, { Id: 'b' }]);
});

describe('GET /j/Items/Root', () => {
    it.each([
        ['/Items/Root', () => import('./+server')],
        ['/Users/{userId}/Items/Root', () => import('../../Users/[userId]/Items/Root/+server')],
    ])('%s is the UserRootFolder with the visible libraries as children', async (_, load) => {
        const { GET } = await load();
        const res = await (GET as (e: never) => Promise<Response>)({
            url: new URL('http://localhost/j/Items/Root'),
            locals: { user: USER },
            params: { userId: USER.userId },
        } as never);
        const body = (await res.json()) as Record<string, unknown>;
        const { USER_ROOT_FOLDER_ID } =
            await import('$lib/server/proprietary/jellyfin-compat/constants');
        expect(body).toMatchObject({
            Type: 'UserRootFolder',
            Id: USER_ROOT_FOLDER_ID,
            IsFolder: true,
            ChildCount: 2,
        });
        expect(mockViews).toHaveBeenCalledWith(expect.anything(), USER);
    });
});
