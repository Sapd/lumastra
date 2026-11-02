// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { mockContext } from '@sapd/lumastra-plugin-sdk-testing';
import {
    runMediaRetention,
    type MediaRetentionResult,
    type RetentionKindCounts,
} from '$lib/server/services/media-retention.service.js';
vi.mock('../../../registry.js', () => ({ registry: { registerTask: vi.fn() } }));
vi.mock('$lib/server/services/media-retention.service.js', () => ({ runMediaRetention: vi.fn() }));
import {
    mediaRetentionInput,
    unavailableMediaRetentionTask,
} from '../unavailable-media-retention.js';

const zero = (): RetentionKindCounts => ({
    roots: 0,
    missingProvenance: 0,
    unhealthyGroup: 0,
    protected: 0,
    shapeBlocked: 0,
    oversized: 0,
    candidates: 0,
    eligible: 0,
    unknownAge: 0,
    deleted: 0,
    deletedRows: 0,
    initialized: 0,
    skipped: 0,
});

describe('unavailable media retention task contract', () => {
    it('registers a visible daily manually runnable maintenance task', async () => {
        vi.resetModules();
        const { registry } = await import('../../../registry.js');
        const { unavailableMediaRetentionTask: loadedTask } =
            await import('../unavailable-media-retention.js');
        expect(registry.registerTask).toHaveBeenCalledWith(loadedTask);
        expect(unavailableMediaRetentionTask.schedule).toEqual({
            every: '24h',
            runOnStartup: false,
        });
        expect(unavailableMediaRetentionTask.id).toBe('unavailable-media-retention');
        expect(unavailableMediaRetentionTask.visibility).not.toBe('system');
    });
    it('accepts only preview and bounded batch inputs; retention cannot be shortened', () => {
        expect(mediaRetentionInput.parse({})).toEqual({ dryRun: false, batchLimit: 100 });
        expect(mediaRetentionInput.parse({ dryRun: true, batchLimit: 1 })).toEqual({
            dryRun: true,
            batchLimit: 1,
        });
        for (const input of [
            { retentionDays: 1 },
            { batchLimit: 0 },
            { batchLimit: 1001 },
            { force: true },
            { kinds: ['movie'] },
        ])
            expect(mediaRetentionInput.safeParse(input).success).toBe(false);
    });
    it('preview has a distinct identity and all purges share the same mutex', () => {
        expect(unavailableMediaRetentionTask.identityFor({ dryRun: true, batchLimit: 1 })).toBe(
            'preview',
        );
        expect(unavailableMediaRetentionTask.identityFor({ dryRun: false, batchLimit: 1 })).toBe(
            'global',
        );
        expect(unavailableMediaRetentionTask.quotas?.maxConcurrent).toBe(1);
        expect(unavailableMediaRetentionTask.exclusiveWith).toEqual({
            scope: 'global',
            ttl: '20m',
        });
    });
    it('adapts preview input and result into the task result without reporting writes', async () => {
        const input = { dryRun: true, batchLimit: 5 };
        const ctx = mockContext({ input });
        const result: MediaRetentionResult = {
            dryRun: true,
            retentionDays: 365,
            candidates: 5,
            hasMore: true,
            truncated: true,
            eligible: 4,
            unknownAge: 1,
            deleted: 0,
            deletedRows: 0,
            initialized: 0,
            skipped: 0,
            reasons: [],
            deletedIds: [],
            byKind: {
                track: { ...zero(), candidates: 5, eligible: 4, unknownAge: 1 },
                album: zero(),
                movie: zero(),
                series: zero(),
                audiobook: zero(),
            },
        };
        vi.mocked(runMediaRetention).mockResolvedValue(result);
        expect(await unavailableMediaRetentionTask.execute(ctx)).toEqual({
            success: true,
            itemsProcessed: 0,
            result,
            message:
                'Unavailable media retention: 0 rows deleted, 0 units deleted, 0 clocks initialized (preview)',
        });
        expect(runMediaRetention).toHaveBeenCalledWith(ctx.sql, ctx.input, ctx.signal);
        expect(vi.mocked(runMediaRetention).mock.calls.at(-1)?.[1]).toBe(input);
    });
    it('explains disabled runs in the persisted summary and log', async () => {
        const ctx = mockContext({ input: { dryRun: false, batchLimit: 10 } });
        vi.spyOn(ctx.logger, 'info');
        vi.mocked(runMediaRetention).mockResolvedValue({
            retentionDays: 0,
            deletedRows: 0,
            deleted: 0,
            initialized: 0,
        } as MediaRetentionResult);
        const result = await unavailableMediaRetentionTask.execute(ctx);
        expect(result).toMatchObject({
            message: expect.stringContaining('disabled: 0 rows deleted'),
        });
        expect(result.itemsProcessed).toBe(0);
        expect(ctx.logger.info).toHaveBeenCalledWith(
            expect.stringContaining('disabled: 0 rows deleted'),
            expect.objectContaining({ deletedRows: 0 }),
        );
    });
    it('reports deletions and clock initializations as processed items', async () => {
        const ctx = mockContext({ input: { dryRun: false, batchLimit: 10 } });
        vi.spyOn(ctx.logger, 'info');
        vi.mocked(runMediaRetention).mockResolvedValue({
            dryRun: false,
            retentionDays: 365,
            candidates: 3,
            hasMore: false,
            truncated: false,
            eligible: 2,
            unknownAge: 1,
            deleted: 2,
            deletedRows: 9,
            initialized: 1,
            skipped: 0,
            reasons: [],
            deletedIds: ['a', 'b'],
            byKind: {
                track: zero(),
                album: zero(),
                movie: zero(),
                series: zero(),
                audiobook: zero(),
            },
        });
        const result = await unavailableMediaRetentionTask.execute(ctx);
        expect(result.itemsProcessed).toBe(3);
        expect(result).toMatchObject({ message: expect.stringContaining('9 rows deleted') });
        expect(ctx.logger.info).toHaveBeenCalledWith(
            expect.stringContaining('9 rows deleted'),
            expect.objectContaining({ deletedRows: 9 }),
        );
    });
});
