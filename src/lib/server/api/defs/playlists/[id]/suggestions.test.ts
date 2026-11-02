// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Response body of GET /playlists/{id}/suggestions: item cap, page.truncated,
 * source and the public Track DTO shape. Authorization lives in
 * playlist-suggestions-access.integration.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mocks = vi.hoisted(() => ({
    metadata: vi.fn(),
    sonic: vi.fn(),
    coverage: vi.fn(),
    sonicEnabled: { value: false },
}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: async () => ({}) },
}));
vi.mock('$lib/server/utils/playlist-utils.js', () => ({
    getUserRole: async () => ({ role: 'owner' }),
}));
vi.mock('$lib/server/database/queries/music.queries.js', () => ({
    getPlaylistSuggestionsFull: mocks.metadata,
    getPlaylistSuggestionsViaSonic: mocks.sonic,
    countPlaylistSonicEmbeddings: mocks.coverage,
}));
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: vi.fn(async () => ({})),
    searchAccessBoundary: vi.fn(() => ({})),
}));
vi.mock('$lib/server/utils/media-access-batch.js', () => ({
    filterAccessibleRows: vi.fn(async (_sql: unknown, rows: unknown[]) => rows),
}));
vi.mock('$lib/server/services/image-descriptor/index.js', () => ({
    resolveImageSets: vi.fn(async () => new Map()),
}));
vi.mock('$lib/server/config.js', async (original) => {
    const actual = await original<typeof import('$lib/server/config.js')>();
    return {
        ...actual,
        features: new Proxy(actual.features, {
            get: (target, key, receiver) =>
                key === 'sonicEmbeddings'
                    ? mocks.sonicEnabled.value
                    : Reflect.get(target, key, receiver),
        }),
    };
});

const { def, SuggestionsResponseSchema } = await import('./suggestions.js');

function row(n: number) {
    return {
        id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
        title: `Invented Song ${String.fromCharCode(64 + n)}${n}`,
        runtime_seconds: 180,
        custom_poster_url: null,
        // distinct artists so the diversity pass keeps every row
        artist_title: `Invented Artist ${n}`,
        album_title: `Invented Album ${n}`,
        similarity_score: 1 - n / 100,
    };
}
const rows = (n: number) => Array.from({ length: n }, (_, i) => row(i + 1));

function get(count?: number) {
    const url = new URL(
        `http://localhost/api/playlists/1/suggestions${count === undefined ? '' : `?count=${count}`}`,
    );
    return def.handlers.GET!(
        {
            url,
            params: { id: '1' },
            request: new Request(url),
            locals: { user: { userId: '110e8400-e29b-41d4-a716-446655440000', username: 'alice' } },
        } as unknown as RequestEvent,
        { surface: 'internal' },
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.sonicEnabled.value = false;
    mocks.metadata.mockResolvedValue(rows(5));
    mocks.sonic.mockResolvedValue(rows(5));
    mocks.coverage.mockResolvedValue(0);
});

describe('GET /playlists/{id}/suggestions body', () => {
    it('caps items at count and flags truncation when more candidates exist', async () => {
        const response = await get(3);
        expect(response.status).toBe(200);
        const body = SuggestionsResponseSchema.parse(await response.json());
        expect(body.items).toHaveLength(3);
        expect(body.page).toEqual({ limit: 3, truncated: true });
        expect(body.source).toBe('metadata');
    });

    it('flags truncation when exactly count+1 candidates exist', async () => {
        mocks.metadata.mockResolvedValue(rows(3));
        const body = await (await get(2)).json();
        expect(body.items).toHaveLength(2);
        expect(body.page.truncated).toBe(true);
    });

    it('does not flag truncation when exactly count or fewer candidates exist', async () => {
        mocks.metadata.mockResolvedValue(rows(3));
        const exact = await (await get(3)).json();
        expect(exact.items).toHaveLength(3);
        expect(exact.page).toEqual({ limit: 3, truncated: false });
        const fewer = await (await get(10)).json();
        expect(fewer.items).toHaveLength(3);
        expect(fewer.page).toEqual({ limit: 10, truncated: false });
    });

    it('defaults to six items and clamps count to 50', async () => {
        mocks.metadata.mockResolvedValue(rows(60));
        expect((await (await get()).json()).page.limit).toBe(6);
        const big = await (await get(50)).json();
        expect(big.items).toHaveLength(50);
        expect(big.page.truncated).toBe(true);
    });

    it('reports source sonic when the playlist has enough sonic coverage', async () => {
        mocks.sonicEnabled.value = true;
        mocks.coverage.mockResolvedValue(5);
        const body = SuggestionsResponseSchema.parse(await (await get(3)).json());
        expect(body.source).toBe('sonic');
        expect(mocks.sonic).toHaveBeenCalledOnce();
        expect(mocks.metadata).not.toHaveBeenCalled();
    });

    it('falls back to metadata when sonic coverage is too low or returns nothing', async () => {
        mocks.sonicEnabled.value = true;
        mocks.coverage.mockResolvedValue(1);
        expect((await (await get(3)).json()).source).toBe('metadata');
        mocks.coverage.mockResolvedValue(5);
        mocks.sonic.mockResolvedValue([]);
        expect((await (await get(3)).json()).source).toBe('metadata');
    });

    it('keeps at most two tracks per artist', async () => {
        mocks.metadata.mockResolvedValue(
            rows(5).map((r, i) => ({ ...r, artist_title: i < 4 ? 'Same Artist' : 'Other Artist' })),
        );
        const body = await (await get(10)).json();
        expect(body.items).toHaveLength(3);
    });
});
