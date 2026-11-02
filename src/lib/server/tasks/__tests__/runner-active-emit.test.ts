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

beforeEach(() => {
    published.length = 0;
});

const activeRow = {
    id: 'run-3',
    task_id: 'trickplay-generation',
    label: 'Trickplay',
    state: 'active' as const,
    scope: { subjectType: 'mediaItem', subjectId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    trigger: { kind: 'manual' },
    actor: { type: 'user' },
    started_at: new Date('2026-08-18T10:00:00Z'),
    execution_started_at: new Date('2026-08-18T10:00:01Z'),
    completed_at: null,
    heartbeat_at: new Date('2026-08-18T10:00:01Z'),
    stages: [],
    error: null,
};

describe('runner active-transition emission', () => {
    it('publishes a parseable frame with state=active', async () => {
        const { emitActiveRunEvent } = await import('../runner-events.js');
        await emitActiveRunEvent({ resourceClass: 'cpu', row: activeRow });

        expect(published).toHaveLength(1);
        const frame = JSON.parse(published[0].payload);
        expect(RunEventSchema.safeParse(frame.data).success).toBe(true);
        expect(frame.data.state).toBe('active');
        expect(frame.data.startedAt).toBe('2026-08-18T10:00:00.000Z');
        expect(frame.data.executionStartedAt).toBe('2026-08-18T10:00:01.000Z');
        expect(frame.data.admissionObservation).toBe('active');
    });

    it('publishes nothing when the run was not pending (no row returned)', async () => {
        const { emitActiveRunEvent } = await import('../runner-events.js');
        await emitActiveRunEvent({ resourceClass: 'cpu', row: undefined });
        expect(published).toHaveLength(0);
    });
});
