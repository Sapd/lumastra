// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { TaskDefinitionSummary } from '$lib/schemas/task-definition.schema.js';
import { failuresWithoutFinding, taskRowState } from './task-row-status.js';

function task(over: Partial<TaskDefinitionSummary> = {}): TaskDefinitionSummary {
    return { id: 't', name: 'Task', lane: 'idle', ...over } as TaskDefinitionSummary;
}

const idle = { running: false, waiting: 0 };

describe('taskRowState', () => {
    it('never-run task is idle', () => {
        expect(taskRowState(task(), idle)).toBe('idle');
    });

    it('completed task is ok', () => {
        expect(taskRowState(task({ lastCompletedAt: '2026-09-27T00:00:00Z' }), idle)).toBe('ok');
    });

    it('a finding makes the row a problem even with a clean lane', () => {
        const ctx = { findingTaskIds: new Set(['t']) };
        expect(taskRowState(task(), idle, ctx)).toBe('problem');
    });

    it('recent failures are a problem, and outrank running', () => {
        expect(taskRowState(task({ recentFailCount: 2 }), { running: true, waiting: 0 })).toBe(
            'problem',
        );
    });

    it('running outranks paused and waiting', () => {
        expect(taskRowState(task({ schedulePaused: true }), { running: true, waiting: 10 })).toBe(
            'running',
        );
    });

    it('a recorded run without worker observation is in flight rather than running', () => {
        expect(
            taskRowState(task({ activeCount: 1, observedActiveCount: 0 }), {
                running: false,
                inFlight: true,
                waiting: 5,
            }),
        ).toBe('in-flight');
    });

    it('paused outranks waiting', () => {
        expect(taskRowState(task({ schedulePaused: true }), { running: false, waiting: 5 })).toBe(
            'paused',
        );
    });

    it('backlog without a run is waiting', () => {
        expect(taskRowState(task(), { running: false, waiting: 5 })).toBe('waiting');
    });
});

describe('failuresWithoutFinding', () => {
    it('lists failing tasks the attention board does not cover, name-sorted', () => {
        const tasks = [
            task({ id: 'b', name: 'Bravo', lane: 'failed' }),
            task({ id: 'a', name: 'Alpha', recentFailCount: 1 }),
            task({ id: 'c', name: 'Charlie', lane: 'failed' }),
            task({ id: 'd', name: 'Delta' }),
        ];
        expect(failuresWithoutFinding(tasks, new Set(['c'])).map((t) => t.id)).toEqual(['a', 'b']);
    });
});
