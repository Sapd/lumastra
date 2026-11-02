// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    findEpisodeThumbnailWork: vi.fn(),
}));

vi.mock('$lib/server/database/queries/media-artwork.queries.js', () => ({
    findEpisodeThumbnailWork: mocks.findEpisodeThumbnailWork,
    loadEpisodeThumbnailExclusions: vi.fn(async () => ({ shared: [] })),
    hasArtworkSuppressionForType: vi.fn(async () => false),
    isArtworkSuppressed: vi.fn(async () => false),
    upsertLocalArtwork: vi.fn(async () => true),
}));
vi.mock('$lib/server/services/episode-thumbnail-publication.service.js', () => ({
    captureEpisodeThumbnailInput: vi.fn(async () => ({})),
    publishEpisodeThumbnail: vi.fn(async () => true),
}));
vi.mock('$lib/server/services/frame-candidate.service.js', () => ({
    generateEpisodeThumbnail: vi.fn(async () => ({ success: true, bestEffort: false })),
}));
vi.mock('$lib/server/utils/safe-fs.js', () => ({
    // Every directory lists its episode thumb as present, so nothing is actionable.
    safeReaddir: vi.fn(async () => []),
}));
vi.mock('$lib/server/services/episode-thumbnail-state.js', () => ({
    classifyEpisodeThumbnail: vi.fn(() => ({ state: 'ok' })),
    expectedThumbNames: vi.fn(() => ['x-thumb.jpg']),
}));

import { resolveEpisodeSpan, episodeThumbnailGenerateTask } from './episode-thumbnail-generate.js';

const CURSOR_KEY = 'episode-thumbnail-generate-cursor';

function makeRows(ids: string[]) {
    return ids.map((episodeId) => ({
        episodeId,
        seasonId: 's1',
        fileId: `f-${episodeId}`,
        videoPath: `/lib/${episodeId}.mkv`,
        durationSeconds: 100,
        artworkPath: null,
        startOffsetMs: null,
        endOffsetMs: null,
    }));
}

function makeCtx(input: Record<string, unknown>, store: Map<string, string>) {
    return {
        input,
        sql: {},
        signal: new AbortController().signal,
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        cache: {
            get: vi.fn(async (k: string) => store.get(k) ?? null),
            set: vi.fn(async (k: string, v: string) => {
                store.set(k, v);
            }),
            del: vi.fn(async (k: string) => {
                store.delete(k);
            }),
        },
    };
}

async function run(input: Record<string, unknown>, store: Map<string, string>) {
    const ctx = makeCtx(input, store);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: any = await episodeThumbnailGenerateTask.execute(ctx as any);
    return { out, ctx };
}

describe('episode-thumbnail-generate scan cursor', () => {
    beforeEach(() => {
        mocks.findEpisodeThumbnailWork.mockReset();
    });

    it("resumes after the previous run's last inspected id", async () => {
        const store = new Map<string, string>();
        // limit 1 => window 6, page size 1: six full pages of one row each.
        mocks.findEpisodeThumbnailWork.mockImplementation(async (_sql, after: string | null) => {
            const n = after === null ? 0 : Number(after.slice(1));
            return makeRows([`e${n + 1}`]);
        });
        await run({ limit: 1 }, store);
        expect(store.get(CURSOR_KEY)).toBe('e6');

        mocks.findEpisodeThumbnailWork.mockClear();
        await run({ limit: 1 }, store);
        expect(mocks.findEpisodeThumbnailWork.mock.calls[0][1]).toBe('e6');
        expect(store.get(CURSOR_KEY)).toBe('e12');
    });

    it('clears the cursor when the candidate query returns fewer rows than requested', async () => {
        const store = new Map<string, string>([[CURSOR_KEY, 'e500']]);
        mocks.findEpisodeThumbnailWork.mockResolvedValueOnce(makeRows(['e501']));
        const { out } = await run({ limit: 5 }, store);
        expect(out.result.wrapped).toBe(true);
        expect(store.has(CURSOR_KEY)).toBe(false);
    });

    it('does not read or write the cursor for a seasonId run', async () => {
        const store = new Map<string, string>([[CURSOR_KEY, 'e500']]);
        mocks.findEpisodeThumbnailWork.mockResolvedValueOnce(makeRows(['e1']));
        const { ctx } = await run(
            { limit: 5, seasonId: '11111111-1111-4111-8111-111111111111' },
            store,
        );
        expect(mocks.findEpisodeThumbnailWork.mock.calls[0][1]).toBeNull();
        expect(ctx.cache.set).not.toHaveBeenCalled();
        expect(ctx.cache.del).not.toHaveBeenCalled();
        expect(store.get(CURSOR_KEY)).toBe('e500');
    });
});

describe('resolveEpisodeSpan', () => {
    const base = {
        episodeId: 'e1',
        seasonId: 's1',
        fileId: 'f1',
        videoPath: '/v.mkv',
        artworkPath: null,
    };

    it('uses the whole file when there are no segment offsets', () => {
        expect(
            resolveEpisodeSpan({
                ...base,
                durationSeconds: 2765,
                startOffsetMs: null,
                endOffsetMs: null,
            }),
        ).toEqual({ base: 0, duration: 2765 });
    });

    it('honours a combined multi-episode file window', () => {
        // bigint columns arrive as STRINGS from postgres.js; string arithmetic
        // here would silently produce a garbage window.
        expect(
            resolveEpisodeSpan({
                ...base,
                durationSeconds: 5400,
                startOffsetMs: '2700000',
                endOffsetMs: '5400000',
            }),
        ).toEqual({ base: 2700, duration: 2700 });
    });

    it('falls back when the offsets are inverted or unparseable', () => {
        expect(
            resolveEpisodeSpan({
                ...base,
                durationSeconds: 1200,
                startOffsetMs: '900000',
                endOffsetMs: '600000',
            }),
        ).toEqual({ base: 0, duration: 1200 });
    });
});
