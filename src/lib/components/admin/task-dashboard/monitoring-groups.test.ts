// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { TaskDefinitionSummary } from '$lib/schemas/task-definition.schema.js';
import { needsAttention } from './monitoring-groups.js';

function task(overrides: Partial<TaskDefinitionSummary> = {}): TaskDefinitionSummary {
    return {
        version: '1.0.0',
        processingVersion: 1,
        resourceClass: 'io',
        capabilities: {},
        visibility: 'user',
        supportsPerItemRetry: false,
        id: 'task',
        name: 'Task',
        ...overrides,
    };
}

describe('needsAttention', () => {
    it('is true for a failed lane or recent failures', () => {
        expect(needsAttention(task({ lane: 'failed' }))).toBe(true);
        expect(needsAttention(task({ lane: 'healthy', recentFailCount: 3 }))).toBe(true);
    });

    it('treats an open attention finding as attention even on a healthy lane', () => {
        const healthy = task({ id: 'lumastra-intro-analyzer', lane: 'healthy' });
        expect(needsAttention(healthy)).toBe(false);
        const ctx = { findingTaskIds: new Set(['lumastra-intro-analyzer']) };
        expect(needsAttention(healthy, ctx)).toBe(true);
    });

    it('does not count waiting backlog or a running task as needing attention', () => {
        expect(needsAttention(task({ lane: 'pending', backlogRemaining: 8 }))).toBe(false);
        expect(needsAttention(task({ lane: 'active', activeCount: 1 }))).toBe(false);
    });
});
