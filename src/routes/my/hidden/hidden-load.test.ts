// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test, vi } from 'vitest';
import { load } from './+page.server';
import type { PageServerLoadEvent } from './$types';

vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => null }));
vi.mock('$lib/server/database/queries/user-media-flags.queries.js', () => ({
    getUserFlags: { all: vi.fn() },
    fetchDismissalMediaInfo: vi.fn(),
}));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock('$lib/utils/image-utils.js', () => ({ getCatalogImageUrl: vi.fn() }));

test('hidden loader registers the restore invalidation dependency even when no database is available', async () => {
    const depends = vi.fn();
    const event = {
        locals: { user: { username: 'viewer', userId: 'viewer-id' } },
        depends,
    } as unknown as PageServerLoadEvent;
    const data = await load(event);
    expect(depends).toHaveBeenCalledWith('app:hidden-items');
    expect(data).toEqual({ items: [] });
});
