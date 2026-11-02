// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { toPublicRun } from './run-event.js';

describe('toPublicRun', () => {
    it('drops error.stack and trigger.idempotencyKey, keeps everything else', () => {
        const run = {
            id: 'r1',
            error: { message: 'boom', kind: 'transient', stack: 'at /srv/x.ts:1' },
            trigger: { kind: 'scheduled', by: 'cron', idempotencyKey: 'k1' },
        };
        const out = toPublicRun(run);
        expect(out).toEqual({
            id: 'r1',
            error: { message: 'boom', kind: 'transient' },
            trigger: { kind: 'scheduled', by: 'cron' },
        });
        expect(run.trigger.idempotencyKey).toBe('k1');
    });

    it('returns a run without either field untouched', () => {
        const run = { id: 'r2', trigger: { kind: 'manual' } };
        expect(toPublicRun(run)).toBe(run);
    });

    it('preserves identity when no redaction or count summary applies', () => {
        const run = { id: 'r3', taskId: 'unrelated', trigger: { kind: 'manual' }, result: {} };
        expect(toPublicRun(run)).toBe(run);
    });
});

import { toRunEvent } from './run-event.js';

describe('toRunEvent', () => {
    it('does not carry trigger.idempotencyKey into SSE frames', () => {
        const event = toRunEvent({
            id: 'r1',
            taskId: 't',
            label: 'x',
            state: 'pending',
            trigger: { kind: 'scheduled', idempotencyKey: 'k1' },
            actor: { type: 'system' },
            startedAt: '2026-10-17T00:00:00.000Z',
            stages: [],
            input: {},
        } as never);
        expect(event.trigger).toEqual({ kind: 'scheduled' });
    });
});

it('selected-file lifecycle errors never carry private probe output into SSE', () => {
    const event = toRunEvent({
        id: 'run_selected',
        taskId: 'media-probe',
        label: 'Media Probe',
        state: 'failed',
        trigger: { kind: 'manual' },
        actor: { type: 'system' },
        startedAt: '2026-10-24T00:00:00Z',
        stages: [],
        input: { fileId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
        error: {
            kind: 'transient',
            message: '/private/secret.mkv decoder failure',
            stack: 'private stack',
        },
    } as never);
    expect(JSON.stringify(event)).not.toContain('/private/');
    expect(event.error?.kind).toBe('transient');
});
