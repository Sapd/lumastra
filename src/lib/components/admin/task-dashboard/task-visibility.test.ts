// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { TaskDefinitionSummary } from '$lib/schemas/task-definition.schema.js';
import { isListedTask } from './task-visibility.js';

function task(over: Partial<TaskDefinitionSummary> = {}): TaskDefinitionSummary {
    return {
        version: '1.0.0',
        processingVersion: 1,
        resourceClass: 'io',
        capabilities: {},
        visibility: 'user',
        supportsPerItemRetry: false,
        id: 'stage-sweep',
        name: 'Stage Coverage Sweeper',
        lane: 'healthy',
        ...over,
    };
}

describe('isListedTask', () => {
    it('lists user tasks, and tasks from older servers that send no visibility', () => {
        expect(isListedTask(task({ visibility: 'user' }), false)).toBe(true);
        expect(isListedTask(task(), false)).toBe(true);
    });

    it('hides a healthy system task unless system tasks are shown', () => {
        expect(isListedTask(task({ visibility: 'system' }), false)).toBe(false);
        expect(isListedTask(task({ visibility: 'system' }), true)).toBe(true);
    });

    it('never hides a system task that has a problem or was paused', () => {
        expect(isListedTask(task({ visibility: 'system', lane: 'failed' }), false)).toBe(true);
        expect(isListedTask(task({ visibility: 'system', recentFailCount: 2 }), false)).toBe(true);
        expect(
            isListedTask(task({ visibility: 'system' }), false, {
                findingTaskIds: new Set(['stage-sweep']),
            }),
        ).toBe(true);
        expect(isListedTask(task({ visibility: 'system', schedulePaused: true }), false)).toBe(
            true,
        );
    });
});
