// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
const mocks = vi.hoisted(() => ({ db: vi.fn(), list: vi.fn() }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: mocks.db }));
vi.mock('$lib/server/services/browse-index.service.js', () => ({ loadMediaListing: mocks.list }));
import { def, MediaListingQuerySchema, MediaListingResponseSchema } from './media.js';
import { boundedListEnvelope, paginatedEnvelope } from '$lib/schemas/pagination.js';
import { MediaPreviewSchema } from '$lib/schemas/api-media-preview.js';

describe('GET /media contract', () => {
    it('defaults to a 50-item title page and rejects limits over 100', () => {
        expect(MediaListingQuerySchema.parse({})).toEqual({
            sort: 'title',
            order: 'asc',
            limit: 50,
            offset: 0,
        });
        expect(MediaListingQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
        expect(MediaListingQuerySchema.safeParse({ offset: -1 }).success).toBe(false);
    });
    it('forwards every composable filter and the caller/surface to the listing service', async () => {
        const query = MediaListingQuerySchema.parse({
            type: 'movie',
            genre: 'Action',
            letter: 'A',
            tag: 'time travel',
            keyword: 'space',
            year: 2026,
            sort: 'runtime',
            order: 'desc',
            limit: 2,
            offset: 4,
            include: 'facets',
        });
        const sql = {};
        const user = { username: 'reader' };
        mocks.db.mockReturnValue(sql);
        mocks.list.mockResolvedValue({
            items: [],
            page: { limit: 2, offset: 4, hasMore: false, total: 4 },
            facets: { letterCounts: [], genreCounts: [] },
        });
        const response = await def.handlers.GET!(
            { locals: { user } } as unknown as RequestEvent,
            { surface: 'v1', input: { query } } as Parameters<
                NonNullable<typeof def.handlers.GET>
            >[1],
        );
        expect(mocks.list).toHaveBeenCalledWith(sql, user, 'v1', query);
        expect(MediaListingResponseSchema.safeParse(await response.json()).success).toBe(true);
    });
    it('requires truthful paging metadata or a bounded truncation flag', () => {
        expect(
            paginatedEnvelope(MediaPreviewSchema).safeParse({
                items: [],
                page: { limit: 2, offset: 4, hasMore: false },
            }).success,
        ).toBe(true);
        expect(
            boundedListEnvelope(MediaPreviewSchema).safeParse({ items: [], truncated: false })
                .success,
        ).toBe(true);
        expect(
            boundedListEnvelope(MediaPreviewSchema).safeParse({
                items: [],
                page: { limit: 2, hasMore: false },
            }).success,
        ).toBe(false);
    });
});
