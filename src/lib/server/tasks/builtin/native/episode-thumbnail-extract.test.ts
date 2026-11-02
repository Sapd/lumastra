// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockContext, runTask } from '@sapd/lumastra-plugin-sdk-testing';

const mocks = vi.hoisted(() => ({ item: vi.fn(), extract: vi.fn(), maintain: vi.fn() }));
vi.mock('$lib/server/database/queries/image-sync.queries.js', () => ({
    getMediaItemForImageSync: mocks.item,
}));
vi.mock('$lib/server/services/video-frame-extractor.service.js', () => ({
    extractFramesBatch: mocks.extract,
}));
vi.mock('$lib/server/services/episode-picture-maintenance.service.js', () => ({
    maintainEpisodePictures: mocks.maintain,
}));
vi.mock('../../registry.js', () => ({ registry: { registerTask: vi.fn() } }));
import { episodeThumbnailExtractTask } from './episode-thumbnail-extract.js';

const id = '781cf231-79ed-448e-b4b9-5adc65b70229';
beforeEach(() => {
    vi.clearAllMocks();
    mocks.item.mockResolvedValue({ id, media_type: 'season' });
    mocks.maintain.mockResolvedValue({
        extracted: 27,
        remapped: 0,
        skipped: 0,
        errors: 0,
        planned: 0,
        capped: false,
    });
    mocks.extract.mockResolvedValue({
        extracted: 27,
        errors: 0,
        processed: 27,
        skipped: 0,
        planned: 0,
    });
});

describe('admin episode thumbnail extraction task', () => {
    it('repairs only missing or wrongly owned season pictures, forwarding progress without forced admin selection', async () => {
        const progress = vi.fn();
        const ctx = mockContext({
            input: { mediaItemId: id, mode: 'execute' as const, scope: 'season' as const },
        });
        ctx.reportProgress = progress;
        const out = await episodeThumbnailExtractTask.execute(ctx);
        expect(mocks.maintain).toHaveBeenCalledWith(
            expect.anything(),
            id,
            expect.any(AbortSignal),
            'execute',
            expect.any(Function),
        );
        mocks.maintain.mock.calls[0][4](3, 27);
        expect(progress).toHaveBeenCalledWith(3, 27);
        expect(mocks.extract).not.toHaveBeenCalled();
        expect(out.success).toBe(true);
        expect(out.itemsProcessed).toBe(27);
    });
    it('infers season scope when old clients omit it', async () => {
        await runTask(episodeThumbnailExtractTask, { mediaItemId: id, mode: 'execute' });
        expect(mocks.maintain).toHaveBeenCalledOnce();
        expect(mocks.extract).not.toHaveBeenCalled();
    });
    it('passes the reviewed episode observation to the worker', async () => {
        mocks.item.mockResolvedValue({ id, media_type: 'episode' });
        const reviewedInput = {
            episodeId: id,
            fileId: '0bbbfdb3-c815-4551-bc2c-22976c513d48',
            videoPath: '/library/episode.mkv',
            selectedCandidateId: null,
            durationSeconds: 600,
            fileGeneration: 'file',
            mediaGeneration: 'media',
            siblingGeneration: 'siblings',
            artworkGeneration: 'artwork',
            physicalIdentity: 'physical',
            span: { base: 0, duration: 600 },
        };
        await runTask(episodeThumbnailExtractTask, {
            mediaItemId: id,
            mode: 'execute',
            reviewedInput,
        });
        expect(mocks.extract.mock.calls[0][1].reviewedInput).toEqual(reviewedInput);
    });
    it('uses the shared media-type conversion for legacy case variants', async () => {
        mocks.item.mockResolvedValue({ id, media_type: 'TV' });
        await runTask(episodeThumbnailExtractTask, { mediaItemId: id, mode: 'execute' });
        expect(mocks.maintain).toHaveBeenCalledOnce();
        expect(mocks.extract).not.toHaveBeenCalled();
    });
    it('refuses a mismatched scope instead of extracting another hierarchy', async () => {
        await expect(
            runTask(episodeThumbnailExtractTask, {
                mediaItemId: id,
                mode: 'execute',
                scope: 'series',
            }),
        ).rejects.toThrow('scope');
        expect(mocks.extract).not.toHaveBeenCalled();
    });
    it('reports partial extraction failures as a failed run', async () => {
        mocks.maintain.mockResolvedValue({
            extracted: 2,
            errors: 1,
            processed: 3,
            skipped: 0,
            planned: 0,
        });
        expect(
            (await runTask(episodeThumbnailExtractTask, { mediaItemId: id, mode: 'execute' }))
                .success,
        ).toBe(false);
    });
    it('retries an ENOSPC batch after storage recovers', async () => {
        mocks.item.mockResolvedValue({ id, media_type: 'episode' });
        mocks.extract.mockResolvedValueOnce({
            extracted: 0,
            errors: 1,
            processed: 1,
            skipped: 0,
            planned: 0,
            transientError: 'ENOSPC: no space left on device',
        });
        await expect(
            runTask(episodeThumbnailExtractTask, { mediaItemId: id, mode: 'execute' }),
        ).rejects.toMatchObject({ kind: 'transient' });
        expect(episodeThumbnailExtractTask.exclusiveWith).toEqual({ scope: 'global', ttl: '130m' });
        expect(episodeThumbnailExtractTask.retry).toMatchObject({ attempts: 6, backoff: [30_000] });
        expect(
            (await runTask(episodeThumbnailExtractTask, { mediaItemId: id, mode: 'execute' }))
                .success,
        ).toBe(true);
    });

    it('passes cancellation to the extractor and does not claim a completed season', async () => {
        const controller = new AbortController();
        controller.abort();
        const out = await runTask(
            episodeThumbnailExtractTask,
            { mediaItemId: id, mode: 'execute' },
            { signal: controller.signal },
        );
        expect(mocks.maintain.mock.calls[0][2].aborted).toBe(true);
        expect(out.success).toBe(false);
        expect(out.stopReason).toBe('aborted');
    });
});
