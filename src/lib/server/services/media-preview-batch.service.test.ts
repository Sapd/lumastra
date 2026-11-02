// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { UserContext } from '$lib/server/types.js';
import { toUserId } from '$lib/shared/user-id.js';
import { unrestrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';

const mocks = vi.hoisted(() => ({
    metadata: vi.fn(async () => new Map()),
    images: vi.fn(async () => new Map()),
    detail: vi.fn(),
    library: vi.fn(() => ''),
    age: vi.fn(() => ''),
    requestsConfigured: true,
}));
vi.mock('$lib/server/config.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/config.js')>()),
    features: {
        get requestsConfigured() {
            return mocks.requestsConfigured;
        },
    },
}));
vi.mock('$lib/server/database/queries/media-rail-metadata.queries.js', () => ({
    getMediaRailMetadataBatch: mocks.metadata,
}));
vi.mock('./image-descriptor/resolver.js', () => ({ resolveImageSets: mocks.images }));
// Audiobook decoration has its own queries; this test pins the shared producer's count.
vi.mock('$lib/server/database/queries/audiobook-catalog.queries.js', () => ({
    audiobookPreviewsForAdmittedIds: vi.fn(async () => []),
}));
vi.mock('$lib/server/api/defs/catalog/media-id.js', () => ({
    buildMediaDetail: mocks.detail,
    MediaDetailResponseSchema: {
        parse: (item: unknown) => item,
        safeParse: (item: unknown) => ({ success: true, data: item }),
    },
}));
vi.mock('$lib/server/database/queries/builders/library-access.builder.js', () => ({
    buildLibraryAccessFilter: mocks.library,
}));
vi.mock('$lib/server/database/queries/builders/age-rating.builder.js', () => ({
    buildAgeRatingFilter: mocks.age,
}));
import {
    hydrateMediaPreviews,
    previewRevision,
    type MediaPreviewBatchContext,
} from './media-preview-batch.service.js';

const movie = '123e4567-e89b-42d3-a456-426614174000';
const episode = '123e4567-e89b-42d3-a456-426614174001';
function row(id: string, raw = id, type = 'movie') {
    return {
        id,
        raw,
        media_type: type,
        title: type,
        year: 2026,
        has_files: true,
        season_number: null,
        episode_number: null,
        series_id: null,
        series_title: null,
        ids: {},
    };
}
function context(rows: ReturnType<typeof row>[]): MediaPreviewBatchContext {
    const tag = vi.fn(async (strings: TemplateStringsArray) =>
        strings.join('').includes('WITH RECURSIVE') ? rows : [],
    );
    const sql = Object.assign(tag, {
        json: vi.fn((value: unknown) => value),
    }) as unknown as postgres.Sql;
    return {
        sql,
        user: { userId: toUserId(movie), username: 'reader' } as UserContext,
        access: unrestrictedAccess(),
        surface: 'v1',
    };
}
beforeEach(() => {
    vi.clearAllMocks();
    mocks.requestsConfigured = true;
});

// vi.mocked() on the postgres Sql type is too deep for the type checker.
function readQueries(sql: unknown): unknown[][] {
    const calls = (sql as { mock: { calls: unknown[][] } }).mock.calls;
    return calls.filter((call) => /^\s*(SELECT|WITH)\b/i.test(String(call[0])));
}

describe('batch hydration', () => {
    it('preserves request order and collapses repeated IDs and aliases to their first position', async () => {
        const ctx = context([row(movie), row(episode), row(movie, 'tmdb:550:movie')]);
        const result = await hydrateMediaPreviews(ctx, [episode, movie, episode, 'tmdb:550:movie']);
        expect(result.items.map((item) => item.id)).toEqual([episode, movie]);
        expect(result.missing).toEqual([]);
        expect(result.items.every((item) => /^[a-f0-9]{16}$/.test(item.revision!))).toBe(true);
    });
    it('reports unknown, malformed and hidden IDs identically, with duplicate missing IDs collapsed', async () => {
        const hidden = '123e4567-e89b-42d3-a456-426614174099';
        const ctx = context([row(movie)]);
        const result = await hydrateMediaPreviews(ctx, [
            'bad',
            hidden,
            movie,
            'tmdb:999:movie',
            'bad',
        ]);
        expect(result.missing).toEqual(['bad', hidden, 'tmdb:999:movie']);
        expect(result.items.map((item) => item.id)).toEqual([movie]);
        expect(mocks.library).toHaveBeenCalledWith(ctx.sql, ctx.access.library);
        expect(mocks.age).toHaveBeenCalledWith(ctx.sql, ctx.access.age);
    });
    it('does not flag file-less titles as requestable when no request path is configured', async () => {
        mocks.requestsConfigured = false;
        const ghost = movie.slice(0, -2) + 'a1';
        const ctx = context([{ ...row(ghost, ghost, 'movie'), has_files: false }]);
        const result = await hydrateMediaPreviews(ctx, [ghost]);
        expect(result.items.map((item) => item.availability)).toEqual([
            { isAvailable: false, canRequest: false, hasFile: false },
        ]);
    });
    it('flags file-less titles as requestable and file-less episodes as not', async () => {
        const fileless = (id: string, type: string) => ({ ...row(id, id, type), has_files: false });
        const ctx = context([
            row(movie),
            fileless(movie.slice(0, -2) + 'a1', 'movie'),
            fileless(movie.slice(0, -2) + 'a2', 'tv'),
            fileless(episode, 'episode'),
        ]);
        const result = await hydrateMediaPreviews(ctx, [
            movie,
            movie.slice(0, -2) + 'a1',
            movie.slice(0, -2) + 'a2',
            episode,
        ]);
        expect(result.items.map((item) => item.availability)).toEqual([
            { isAvailable: true, canRequest: false, hasFile: true },
            { isAvailable: false, canRequest: true, hasFile: false },
            { isAvailable: false, canRequest: true, hasFile: false },
            { isAvailable: false, canRequest: false, hasFile: false },
        ]);
    });
    it('hydrates all eight kinds through the shared producer with a constant query count', async () => {
        const kinds = ['movie', 'tv', 'season', 'episode', 'album', 'track', 'artist', 'audiobook'];
        const rows = kinds.map((type, index) =>
            row(movie.slice(0, -2) + String(index).padStart(2, '0'), undefined, type),
        );
        const ctx = context(rows);
        const result = await hydrateMediaPreviews(
            ctx,
            rows.map((r) => r.id),
        );
        expect(result.items.map((item) => item.type)).toEqual([
            'movie',
            'series',
            ...kinds.slice(2),
        ]);
        expect(
            readQueries(ctx.sql),
        ).toHaveLength(2); // batch lookup and watch state; fragments are not reads
        expect(mocks.metadata).toHaveBeenCalledTimes(1);
        expect(mocks.images).toHaveBeenCalledTimes(1);
        expect(result.items.every((item) => item.catalogId === item.id && item.images)).toBe(true);
    });
    it('keeps the same read count for the full 100-ID cap', async () => {
        const rows = Array.from({ length: 100 }, (_, i) =>
            row(movie.slice(0, -3) + String(i).padStart(3, '0')),
        );
        const ctx = context(rows);
        expect(
            (
                await hydrateMediaPreviews(
                    ctx,
                    rows.map((r) => r.id),
                )
            ).items,
        ).toHaveLength(100);
        expect(
            readQueries(ctx.sql),
        ).toHaveLength(2);
        expect(mocks.metadata).toHaveBeenCalledTimes(1);
        expect(mocks.images).toHaveBeenCalledTimes(1);
    });
    it('accepts the two-part TMDB form without changing the global single-ID parser', async () => {
        const ctx = context([row(movie, 'tmdb:550')]);
        const result = await hydrateMediaPreviews(ctx, ['tmdb:550']);
        expect(result.items[0].id).toBe(movie);
        expect(result.missing).toEqual([]);
        expect(vi.mocked(ctx.sql.json).mock.calls[0][0]).toEqual([
            { raw: 'tmdb:550', uuid: null, provider: 'tmdb', external_id: '550', media_type: null },
        ]);
    });
    it('returns the unchanged GET detail plus revision, and passes the same boundary', async () => {
        const ctx = context([row(movie)]);
        const detail = {
            id: movie,
            title: 'Movie',
            type: 'movie',
            credits: { cast: [], crew: [] },
        };
        mocks.detail.mockResolvedValue(detail);
        const result = await hydrateMediaPreviews(ctx, [movie], { include: 'detail' });
        expect(result).toEqual({
            items: [{ ...detail, revision: previewRevision(detail) }],
            missing: [],
        });
        expect(mocks.detail).toHaveBeenCalledWith(
            ctx.sql,
            movie,
            'v1',
            '',
            ctx.user.userId,
            expect.any(Function),
        );
        expect(await mocks.detail.mock.calls[0][5]()).toBe(ctx.access);
        expect(mocks.metadata).not.toHaveBeenCalled();
    });
    it('reports kinds unsupported by GET detail in missing', async () => {
        mocks.detail.mockResolvedValue(null);
        expect(
            await hydrateMediaPreviews(context([row(movie)]), [movie], { include: 'detail' }),
        ).toEqual({ items: [], missing: [movie] });
    });
    it('denies every kind when either boundary axis denies all', async () => {
        const ctx = context([]);
        ctx.access.library = { kind: 'denyAll' };
        expect(await hydrateMediaPreviews(ctx, [movie])).toEqual({ items: [], missing: [movie] });
        expect(ctx.sql).not.toHaveBeenCalled();
    });
    it('enforces the cap before database work, including before deduplication', async () => {
        const ctx = context([]);
        await expect(hydrateMediaPreviews(ctx, Array(101).fill(movie))).rejects.toThrow(RangeError);
        await expect(hydrateMediaPreviews(ctx, [])).rejects.toThrow(RangeError);
        expect(ctx.sql).not.toHaveBeenCalled();
    });
});

describe('previewRevision', () => {
    it('is a stable SHA256 prefix across recursively reordered keys and existing item revisions', () => {
        const first = { id: movie, images: { primary: { revision: 'image-1', href: '/image' } } };
        const reordered = {
            revision: 'old',
            images: { primary: { href: '/image', revision: 'image-1' } },
            id: movie,
        };
        expect(previewRevision(first)).toMatch(/^[a-f0-9]{16}$/);
        expect(previewRevision(first)).toBe(previewRevision(reordered));
        expect(previewRevision(first)).toBe(previewRevision(first));
    });
    it('changes when an image revision or array order changes', () => {
        expect(previewRevision({ images: { primary: { revision: '1' } } })).not.toBe(
            previewRevision({ images: { primary: { revision: '2' } } }),
        );
        expect(previewRevision({ genres: ['a', 'b'] })).not.toBe(
            previewRevision({ genres: ['b', 'a'] }),
        );
    });
    it('hashes the serialized JSON fields, including toJSON and undefined omission', () => {
        expect(previewRevision({ date: new Date('2026-01-01Z'), absent: undefined })).toBe(
            previewRevision({ date: '2026-01-01T00:00:00.000Z' }),
        );
    });
});
