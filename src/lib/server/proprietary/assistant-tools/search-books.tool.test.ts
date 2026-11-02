// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Unit tests for the `search_books` assistant tool.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchBooksTool } from './search-books.tool.js';
import type { AssistantToolContext } from './types.js';
import type { SearchResultGroupDto } from '../../plugins/kavita/types.js';
import { toUserId } from '$lib/shared/user-id.js';

vi.mock('../../plugins/kavita/index.js', () => ({
    search: vi.fn(),
}));
vi.mock('../../config.js', () => ({
    features: { kavita: true },
}));

import * as kavita from '../../plugins/kavita/index.js';
import { features } from '../../config.js';
import { assistantTestUser } from './test-context.js';

function makeCtx(): AssistantToolContext {
    return {
        sql: {} as never,
        userId: toUserId('00000000-0000-0000-0000-000000000001'),
        userIsAdmin: false,
        user: assistantTestUser(),
        writesAllowed: false,
        accessCtx: {
            username: 'alice',
            deniedGroupIds: null,
            ageRating: null,
            liveTvAllowed: true,
            showUnavailableMedia: true,
        },
        embedQuery: async () => '[0]',
    };
}

const group = {
    series: [
        {
            seriesId: 7,
            name: 'Varenth',
            format: 1,
            libraryName: 'Manga',
            libraryId: 2,
        },
    ],
} as unknown as SearchResultGroupDto;

describe('searchBooksTool', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (features as { kavita: boolean }).kavita = true;
    });

    it('returns book/series matches when configured', async () => {
        vi.mocked(kavita.search).mockResolvedValue(group);
        const result = await searchBooksTool.execute({ query: 'Varenth' }, makeCtx());
        const d = JSON.parse(result.summaryForModel);
        expect(d.available).toBe(true);
        expect(d.found).toBe(true);
        expect(d.results[0].title).toBe('Varenth');
        expect(d.results[0].library).toBe('Manga');
    });

    it('reports unavailable when Kavita is not configured', async () => {
        (features as { kavita: boolean }).kavita = false;
        const result = await searchBooksTool.execute({ query: 'Varenth' }, makeCtx());
        expect(JSON.parse(result.summaryForModel).available).toBe(false);
        expect(kavita.search).not.toHaveBeenCalled();
    });

    it('degrades gracefully when the service errors', async () => {
        vi.mocked(kavita.search).mockRejectedValue(new Error('down'));
        const result = await searchBooksTool.execute({ query: 'Varenth' }, makeCtx());
        expect(JSON.parse(result.summaryForModel).error).toBe(true);
    });
});
