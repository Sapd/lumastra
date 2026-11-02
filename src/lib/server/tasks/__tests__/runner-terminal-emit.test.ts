// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RunEventSchema } from '@sapd/lumastra-plugin-sdk';

const published: Array<{ channel: string; payload: string }> = [];

vi.mock('$lib/server/cache/valkey.js', () => ({
    publishMessage: vi.fn(async (channel: string, payload: string) => {
        published.push({ channel, payload });
    }),
    getCoordinationClient: vi.fn(),
}));

// cloud-events.ts reads INSTANCE_ID off the real config module at import time;
// stub it so this suite does not drag the whole config graph into the fork.
vi.mock('$lib/server/config.js', () => ({
    config: { INSTANCE_ID: 'test-node-1' },
}));

beforeEach(() => {
    published.length = 0;
});

describe('runner terminal CloudEvent emission', () => {
    it('publishes exactly one parseable run.completed frame when the row transitions', async () => {
        const { emitTerminalRunEvent } = await import('../runner-events.js');

        await emitTerminalRunEvent({
            resourceClass: 'cpu',
            row: {
                id: 'run-1',
                task_id: 'trickplay-generation',
                label: 'Trickplay',
                state: 'completed',
                scope: {
                    subjectType: 'mediaItem',
                    subjectId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
                },
                trigger: { kind: 'manual' },
                actor: { type: 'user' },
                started_at: new Date('2026-08-18T10:00:00Z'),
                completed_at: new Date('2026-08-18T10:05:00Z'),
                heartbeat_at: null,
                stages: [],
                result: {
                    success: false,
                    itemsProcessed: 663,
                    stopReason: 'budget',
                    result: { generated: 663, countUnit: 'frames', sourcesRemaining: 1 },
                },
                error: null,
            },
        });

        expect(published).toHaveLength(1);
        expect(published[0].channel).toBe('task:events:cpu');
        const frame = JSON.parse(published[0].payload);
        expect(frame.type).toBe('org.lumastra.task.run.completed');
        expect(RunEventSchema.safeParse(frame.data).success).toBe(true);
        expect(frame.data.state).toBe('completed');
        expect(frame.data.countSummary).toEqual({
            count: 663,
            unit: 'frames',
            continuation: { kind: 'source-check', remainingSources: 1 },
        });
        expect(frame.data).not.toHaveProperty('result');
        expect(JSON.stringify(frame)).not.toContain('sourcesRemaining');
    });

    it('publishes nothing when the terminal UPDATE matched no row', async () => {
        const { emitTerminalRunEvent } = await import('../runner-events.js');
        await emitTerminalRunEvent({ resourceClass: 'cpu', row: undefined });
        expect(published).toHaveLength(0);
    });

    it('never includes error.stack or result', async () => {
        const { emitTerminalRunEvent } = await import('../runner-events.js');
        await emitTerminalRunEvent({
            resourceClass: 'io',
            row: {
                id: 'run-2',
                task_id: 'chapter-sync',
                label: 'Chapters',
                state: 'failed',
                scope: null,
                trigger: { kind: 'manual' },
                actor: { type: 'user' },
                started_at: new Date('2026-08-18T10:00:00Z'),
                completed_at: new Date('2026-08-18T10:01:00Z'),
                heartbeat_at: null,
                stages: [],
                error: { message: 'boom', kind: 'permanent', stack: '/srv/secret.ts:1' },
            },
        });

        const frame = JSON.parse(published[0].payload);
        expect(frame.type).toBe('org.lumastra.task.run.failed');
        expect(frame.data.error).toEqual({ message: 'boom', kind: 'permanent' });
        expect(frame.data).not.toHaveProperty('result');
        expect(frame.data).not.toHaveProperty('input');
    });
});

it.each(['failed', 'cancelled'] as const)(
    'redacts a real selected terminal %s emitter row',
    async (state) => {
        const { emitTerminalRunEvent } = await import('../runner-events.js');
        const secret = '/private/selected.mkv ffmpeg password=sentinel';
        await emitTerminalRunEvent({
            resourceClass: 'io',
            row: {
                id: 'run_selected',
                task_id: 'media-probe',
                label: 'Media Probe',
                state,
                recheck_input: { fileId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
                scope: null,
                trigger: { kind: 'manual' },
                actor: { type: 'system' },
                started_at: new Date(),
                completed_at: new Date(),
                heartbeat_at: null,
                stages: [],
                error: { message: secret, kind: 'permanent', stack: secret },
            },
        });
        expect(published).toHaveLength(1);
        const frame = JSON.parse(published[0].payload);
        expect(frame.data.error).toEqual({
            message: 'Selected-file recheck did not complete',
            kind: 'permanent',
        });
        expect(frame.data).not.toHaveProperty('input');
        expect(frame.data).not.toHaveProperty('recheck_input');
        expect(frame.data).not.toHaveProperty('result');
        expect(JSON.stringify(frame)).not.toContain(secret);
    },
);
