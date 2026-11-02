// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./valkey.js', () => ({
    getCoordinationClient: vi.fn(),
}));

import { publishStageStateChange, PIPELINE_STAGE_STATE_CHANNEL } from './pipeline-pubsub.js';
import { getCoordinationClient } from './valkey.js';

describe('publishStageStateChange', () => {
    let mockCustomCommand: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        mockCustomCommand = vi.fn().mockResolvedValue(0);
        vi.mocked(getCoordinationClient).mockReturnValue({
            customCommand: mockCustomCommand,
        } as never);
    });

    it('publishes a JSON-encoded frame to the pipeline channel', async () => {
        await publishStageStateChange({
            mediaItemId: 'item-1',
            stageId: 's',
            newStatus: 'completed',
            processingVersion: 1,
            kind: 'transition',
            timestamp: '2026-01-01T00:00:00Z',
        });
        expect(mockCustomCommand).toHaveBeenCalledWith([
            'PUBLISH',
            PIPELINE_STAGE_STATE_CHANNEL,
            expect.stringContaining('"newStatus":"completed"'),
        ]);
    });

    it('includes all provided fields in the published payload', async () => {
        await publishStageStateChange({
            mediaItemId: 'item-2',
            stageId: 'embed',
            oldStatus: 'running',
            newStatus: 'completed',
            processingVersion: 3,
            runId: 'run-abc',
            kind: 'transition',
            timestamp: '2026-01-01T00:00:00Z',
        });
        // customCommand is called with a single argument: the command array
        const [[args]] = mockCustomCommand.mock.calls as [string[][]];
        expect(args[0]).toBe('PUBLISH');
        expect(args[1]).toBe(PIPELINE_STAGE_STATE_CHANNEL);
        const parsed = JSON.parse(args[2]) as Record<string, unknown>;
        expect(parsed.mediaItemId).toBe('item-2');
        expect(parsed.stageId).toBe('embed');
        expect(parsed.oldStatus).toBe('running');
        expect(parsed.newStatus).toBe('completed');
        expect(parsed.runId).toBe('run-abc');
        expect(parsed.processingVersion).toBe(3);
    });

    it('is fire-and-forget — does not throw when client is null', async () => {
        vi.mocked(getCoordinationClient).mockReturnValue(null as never);
        await expect(
            publishStageStateChange({
                mediaItemId: 'item-1',
                stageId: 's',
                newStatus: 'completed',
                processingVersion: 1,
                kind: 'transition',
                timestamp: '2026-01-01T00:00:00Z',
            }),
        ).resolves.toBeUndefined();
    });

    it('swallows publish errors', async () => {
        mockCustomCommand.mockRejectedValue(new Error('valkey down'));
        await expect(
            publishStageStateChange({
                mediaItemId: 'item-1',
                stageId: 's',
                newStatus: 'completed',
                processingVersion: 1,
                kind: 'transition',
                timestamp: '2026-01-01T00:00:00Z',
            }),
        ).resolves.toBeUndefined();
    });

    it('publishes seed events with kind=seed', async () => {
        await publishStageStateChange({
            mediaItemId: 'item-3',
            stageId: 'stage-a',
            newStatus: 'pending',
            processingVersion: 2,
            kind: 'seed',
            timestamp: '2026-01-01T00:00:00Z',
        });
        const [firstCallArgs] = mockCustomCommand.mock.calls as string[][][];
        const parsed = JSON.parse(firstCallArgs[0][2]) as Record<string, unknown>;
        expect(parsed.kind).toBe('seed');
    });

    it('publishes delete events with kind=delete', async () => {
        await publishStageStateChange({
            mediaItemId: 'item-4',
            stageId: '*',
            newStatus: 'pending',
            processingVersion: 1,
            kind: 'delete',
            timestamp: '2026-01-01T00:00:00Z',
        });
        const [firstCallArgs] = mockCustomCommand.mock.calls as string[][][];
        const parsed = JSON.parse(firstCallArgs[0][2]) as Record<string, unknown>;
        expect(parsed.kind).toBe('delete');
    });
});
