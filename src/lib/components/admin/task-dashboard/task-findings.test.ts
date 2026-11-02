// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { AttentionItem } from '$lib/schemas/api-attention-responses.js';
import { findingsByTask } from './task-findings.js';

function item(id: string, overrides: Partial<AttentionItem> = {}): AttentionItem {
    return {
        id,
        fingerprint: 'f',
        type: 'dead-letter',
        domain: 'tasks',
        severity: 'warning',
        title: id,
        actions: [],
        firstSeen: '2026-08-26T00:00:00.000Z',
        lastSeen: '2026-09-26T00:00:00.000Z',
        acked: false,
        ...overrides,
    } as AttentionItem;
}

const tasks = [
    { id: 'lumastra-intro-analyzer', coveredStageIds: ['lumastra-intro-analyzer:visual'] },
    { id: 'trickplay-generation', coveredStageIds: ['trickplay-generation'] },
    { id: 'media-probe' },
];

describe('findingsByTask', () => {
    it('joins task-scoped finding ids to their task', () => {
        const out = findingsByTask(
            [item('plugin-failures:media-probe'), item('circuit:media-probe')],
            tasks,
        );
        expect(out.get('media-probe')?.map((i) => i.id)).toEqual([
            'plugin-failures:media-probe',
            'circuit:media-probe',
        ]);
    });

    it('joins stage-scoped findings to the task covering the stage, colon in the id included', () => {
        const out = findingsByTask(
            [
                item('decline-loop:trickplay-generation'),
                item('stuck-items:lumastra-intro-analyzer:visual'),
            ],
            tasks,
        );
        expect(out.get('trickplay-generation')).toHaveLength(1);
        expect(out.get('lumastra-intro-analyzer')).toHaveLength(1);
    });

    it('leaves out answered findings and unrelated kinds', () => {
        const out = findingsByTask(
            [
                item('plugin-failures:media-probe', { acked: true }),
                item('circuit:media-probe', { snoozed: true }),
                item('degraded-component:valkey'),
                item('plugin-failures:not-a-registered-task'),
            ],
            tasks,
        );
        expect(out.size).toBe(0);
    });
});
