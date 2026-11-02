// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
const mocks = vi.hoisted(() => ({ facets: vi.fn() }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: vi.fn().mockResolvedValue({}),
    searchAccessBoundary: () => ({ library: { kind: 'all' }, age: { kind: 'any' } }),
}));
vi.mock('$lib/server/database/queries/audiobook-catalog.queries.js', () => ({
    catalogFacets: mocks.facets,
}));
const { def } = await import('./facets.js');
beforeEach(() => {
    vi.clearAllMocks();
    mocks.facets.mockResolvedValue({
        shelves: [],
        languages: [],
        letterCounts: [{ letter: 'A', count: 2 }],
    });
});
describe('audiobook facets', () => {
    it('returns separate access-scoped facets and counts collapsed entries with the list filters', async () => {
        expect(def.docs?.GET?.responses).toHaveProperty('401');
        const id = '11111111-1111-4111-8111-111111111111';
        const query = def.request!.query!.parse({
            q: 'Book',
            narratorId: id,
            seriesId: id,
            authorId: id,
            libraryGroupId: id,
            lang: 'de',
            collapse: 'series',
        });
        const response = await def.handlers.GET!(
            { locals: { user: { userId: id } } } as unknown as RequestEvent,
            { surface: 'v1', input: { query } } as never,
        );
        expect(await response.json()).toEqual({
            shelves: [],
            languages: [],
            letterCounts: [{ letter: 'A', count: 2 }],
        });
        expect(mocks.facets).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                q: 'Book',
                authorId: id,
                narratorId: id,
                seriesId: id,
                groupId: id,
                lang: 'de',
                collapse: 'series',
            }),
        );
    });
});
