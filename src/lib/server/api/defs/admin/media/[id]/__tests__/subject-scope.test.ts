// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every task-starting endpoint on the admin media detail page must tag its run
 * with the media item it acts upon, using that item's UUID — the admin
 * page reconstructs "what is running for this item" by filtering on
 * `scope.subjectId`, so an endpoint that tags an alias id (or nothing at all)
 * drops out of that set and its button loses live progress.
 *
 * These routes take the UUID only (adminMediaId): nothing resolves aliases on
 * them, so the last test pins that an alias is refused rather than tagged.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import {
    TrickplayGenerateResponseSchema,
    SegmentsGenerateResponseSchema,
} from '$lib/schemas/api-admin-responses.js';
import { SyncEnqueuedResponseSchema } from '$lib/schemas/metadata-sync.js';
import { getAnalyzerReadinessBatch } from '$lib/server/database/queries/media-segment-input.queries.js';

const INTERNAL_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ALIAS_ID = 'tmdb:550:movie';

const startRun = vi.fn(async (..._args: unknown[]) => ({ runId: 'run-1', deduped: false }));

vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: { startRun: (...args: unknown[]) => startRun(...args) },
}));

const mockGetDb = vi.fn();
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

vi.mock('$lib/server/database/queries/media-segment-input.queries.js', () => ({
    getAnalyzerReadinessBatch: vi.fn(),
}));

function makeEvent(id: string = INTERNAL_ID): RequestEvent {
    const url = new URL(`http://localhost/api/admin/media/${encodeURIComponent(id)}/x`);
    return {
        url,
        params: { id },
        request: new Request(url.toString(), { method: 'POST' }),
        locals: {
            user: { username: 'denis' },
        },
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeCtx(body: unknown): any {
    return { surface: 'internal' as const, input: { body, params: undefined, query: {} } };
}

/** Minimal postgres.js stand-in: a tagged template that always resolves rows. */
function fakeSql(rows: unknown[]) {
    return () => Promise.resolve(rows);
}

const subjectOf = (call: unknown[]) =>
    (call[2] as { subject?: { type: string; id: string } }).subject;

beforeEach(() => {
    vi.clearAllMocks();
    startRun.mockResolvedValue({ runId: 'run-1', deduped: false });
    mockGetDb.mockReturnValue(fakeSql([{ id: INTERNAL_ID, media_type: 'tv' }]));
    // d046376876 requires a selected, probed video before queuing analysis.
    vi.mocked(getAnalyzerReadinessBatch).mockResolvedValue([
        {
            mediaId: INTERNAL_ID,
            state: 'ready',
            inputIdentity: 'selected-input',
            fileId: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            filePath: '/media/episode.mkv',
            alternate: false,
            proof: null,
        },
    ]);
});

describe('admin media task endpoints tag their runs with the media-item subject', () => {
    it('trickplay/generate passes subject { type: mediaItem, id: internalId }', async () => {
        const { def } = await import('../trickplay/generate.js');
        await def.handlers.POST!(makeEvent(), makeCtx({ force: false }));

        expect(startRun).toHaveBeenCalledTimes(1);
        expect(subjectOf(startRun.mock.calls[0])).toEqual({
            type: 'mediaItem',
            id: INTERNAL_ID,
        });
    });

    it('chapters/sync passes the subject', async () => {
        const { def } = await import('../chapters/sync.js');
        await def.handlers.POST!(makeEvent(), makeCtx(undefined));

        expect(subjectOf(startRun.mock.calls[0])).toEqual({
            type: 'mediaItem',
            id: INTERNAL_ID,
        });
    });

    it('episode-thumbnails/regenerate passes the subject', async () => {
        const { def } = await import('../episode-thumbnails/regenerate.js');
        await def.handlers.POST!(
            makeEvent(),
            makeCtx({ mode: 'execute', force: false, scope: undefined }),
        );

        expect(subjectOf(startRun.mock.calls[0])).toEqual({
            type: 'mediaItem',
            id: INTERNAL_ID,
        });
    });

    it('images/sync passes the subject and collapses a repeat click', async () => {
        const { def } = await import('../images/sync.js');
        const body = { mode: 'execute', scope: 'movie', force: false, extractVideo: false };
        await def.handlers.POST!(makeEvent(), makeCtx(body));
        await def.handlers.POST!(makeEvent(), makeCtx(body));

        expect(subjectOf(startRun.mock.calls[0])).toEqual({
            type: 'mediaItem',
            id: INTERNAL_ID,
        });
        const keyOf = (call: unknown[]) => (call[2] as { idempotencyKey?: string }).idempotencyKey;
        expect(keyOf(startRun.mock.calls[0])).toBeTruthy();
        expect(keyOf(startRun.mock.calls[1])).toBe(keyOf(startRun.mock.calls[0]));
    });

    it('sync (includeChildren) passes the subject', async () => {
        const { def } = await import('../sync.js');
        await def.handlers.POST!(
            makeEvent(),
            makeCtx({ includeChildren: true, forceChildren: false }),
        );

        expect(subjectOf(startRun.mock.calls[0])).toEqual({
            type: 'mediaItem',
            id: INTERNAL_ID,
        });
    });

    it('sync (includeChildren) opts the run into creating children of a not-owned series', async () => {
        const { def } = await import('../sync.js');
        await def.handlers.POST!(
            makeEvent(),
            makeCtx({ includeChildren: true, forceChildren: false }),
        );

        expect(startRun.mock.calls[0][1]).toMatchObject({
            mediaItemId: INTERNAL_ID,
            force: true,
            forceCreateChildren: true,
        });
    });

    it('segments (single scope) passes the item id to the analyzer too', async () => {
        const { def } = await import('../segments.js');
        const res = await def.handlers.POST!(makeEvent(), makeCtx({ scope: 'single' }));

        expect(res.status).toBe(200);
        expect(getAnalyzerReadinessBatch).toHaveBeenCalledWith(expect.any(Function), [INTERNAL_ID]);
        expect(startRun).toHaveBeenCalledTimes(1);
        expect(subjectOf(startRun.mock.calls[0])).toEqual({
            type: 'mediaItem',
            id: INTERNAL_ID,
        });
        // The analyzer's own input key must be the same item, or the run would
        // analyse a different item than the one the page is showing.
        expect(startRun.mock.calls[0][1]).toMatchObject({ mediaId: INTERNAL_ID });
    });

    it('segments refuses analysis without a ready input instead of starting a run', async () => {
        vi.mocked(getAnalyzerReadinessBatch).mockResolvedValue([
            {
                mediaId: INTERNAL_ID,
                state: 'awaiting-input',
                inputIdentity: null,
                fileId: null,
                filePath: null,
                alternate: false,
                proof: null,
            },
        ]);
        const { def } = await import('../segments.js');
        const res = await def.handlers.POST!(makeEvent(), makeCtx({ scope: 'single' }));

        expect(res.status).toBe(409);
        expect(startRun).not.toHaveBeenCalled();
    });

    it('refuses an alias id with 404 instead of starting a run for it', async () => {
        const { def } = await import('../trickplay/generate.js');
        const res = await def.handlers.POST!(makeEvent(ALIAS_ID), makeCtx({ force: false }));

        expect(res.status).toBe(404);
        expect(startRun).not.toHaveBeenCalled();
    });
});

/**
 * `SyncEnqueuedResponseSchema` also requires `success`, which neither
 * `sync` nor `chapters/sync` has ever sent — a SEPARATE, pre-existing
 * client/server divergence in that schema, deliberately left alone here so
 * these assertions isolate `deduped`.
 */
const withSuccess = (body: unknown) => ({ success: true, ...(body as object) });

describe('deduped is propagated to the response body', () => {
    beforeEach(() => {
        startRun.mockResolvedValue({
            runId: 'run-existing',
            deduped: true,
            existingRunId: 'run-existing',
        } as never);
    });

    it('trickplay/generate', async () => {
        const { def } = await import('../trickplay/generate.js');
        const res = await def.handlers.POST!(makeEvent(), makeCtx({ force: false }));
        expect((await res.json()).deduped).toBe(true);
    });

    it('chapters/sync', async () => {
        const { def } = await import('../chapters/sync.js');
        const res = await def.handlers.POST!(makeEvent(), makeCtx(undefined));
        expect((await res.json()).deduped).toBe(true);
    });

    it('episode-thumbnails/regenerate', async () => {
        const { def } = await import('../episode-thumbnails/regenerate.js');
        const res = await def.handlers.POST!(
            makeEvent(),
            makeCtx({ mode: 'execute', force: false, scope: undefined }),
        );
        expect((await res.json()).deduped).toBe(true);
    });

    it('sync', async () => {
        const { def } = await import('../sync.js');
        const res = await def.handlers.POST!(
            makeEvent(),
            makeCtx({ includeChildren: true, forceChildren: false }),
        );
        expect((await res.json()).deduped).toBe(true);
    });

    it('segments', async () => {
        const { def } = await import('../segments.js');
        const res = await def.handlers.POST!(makeEvent(), makeCtx({ scope: 'single' }));
        expect(res.status).toBe(200);
        expect((await res.json()).deduped).toBe(true);
    });
});

/**
 * The client parses these responses with its OWN copies of the response
 * schemas, and `apiFetch` runs them over the raw body. A copy that does not
 * declare `deduped` drops the flag (or, under `toStrict`, turns every queued
 * response into a reported schema mismatch) — invisible to typecheck, to lint
 * and to every server-side assertion above, which is exactly how the
 * `deduped: true` UI branch would ship dead.
 *
 * So: take the REAL body each handler emits and push it through the CLIENT
 * schema the corresponding `$lib/api/admin` call site uses.
 */
describe('deduped survives the client-side response schemas', () => {
    beforeEach(() => {
        startRun.mockResolvedValue({
            runId: 'run-existing',
            deduped: true,
            existingRunId: 'run-existing',
        } as never);
    });

    it('trickplay/generate → TrickplayGenerateResponseSchema (generateTrickplay)', async () => {
        const { def } = await import('../trickplay/generate.js');
        const res = await def.handlers.POST!(makeEvent(), makeCtx({ force: false }));
        expect(TrickplayGenerateResponseSchema.parse(await res.json()).deduped).toBe(true);
    });

    it('episode-thumbnails/regenerate → TrickplayGenerateResponseSchema (regenerateEpisodeThumbnails)', async () => {
        const { def } = await import('../episode-thumbnails/regenerate.js');
        const res = await def.handlers.POST!(
            makeEvent(),
            makeCtx({ mode: 'execute', force: false, scope: undefined }),
        );
        expect(TrickplayGenerateResponseSchema.parse(await res.json()).deduped).toBe(true);
    });

    it('segments → SegmentsGenerateResponseSchema (generateMediaSegments)', async () => {
        const { def } = await import('../segments.js');
        const res = await def.handlers.POST!(makeEvent(), makeCtx({ scope: 'single' }));
        expect(res.status).toBe(200);
        expect(SegmentsGenerateResponseSchema.parse(await res.json()).deduped).toBe(true);
    });

    it('sync → SyncEnqueuedResponseSchema (syncMediaMetadataEnqueue)', async () => {
        const { def } = await import('../sync.js');
        const res = await def.handlers.POST!(
            makeEvent(),
            makeCtx({ includeChildren: true, forceChildren: false }),
        );
        expect(SyncEnqueuedResponseSchema.parse(withSuccess(await res.json())).deduped).toBe(true);
    });

    it('chapters/sync → SyncEnqueuedResponseSchema (syncChapters)', async () => {
        const { def } = await import('../chapters/sync.js');
        const res = await def.handlers.POST!(makeEvent(), makeCtx(undefined));
        expect(SyncEnqueuedResponseSchema.parse(withSuccess(await res.json())).deduped).toBe(true);
    });
});
