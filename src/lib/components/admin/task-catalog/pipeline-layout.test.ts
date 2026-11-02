// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    layoutPipeline,
    resolvePipelineRootId,
    collectPipelineMembers,
    pointsToBezierPath,
    NODE_WIDTH,
    NODE_HEIGHT,
} from './pipeline-layout.js';
import type { TaskDefinitionSummary } from '$lib/schemas/task-definition.schema.js';

function makeTask(
    id: string,
    pipeline?: { of: string; after?: string[]; hasWhen?: boolean },
    extras: Partial<TaskDefinitionSummary> = {},
): TaskDefinitionSummary {
    return {
        id,
        name: id,
        version: '1.0.0',
        processingVersion: 1,
        resourceClass: 'io',
        capabilities: {},
        visibility: 'user',
        supportsPerItemRetry: false,
        ...(pipeline ? { pipeline: { ...pipeline, hasWhen: pipeline.hasWhen ?? false } } : {}),
        ...extras,
    };
}

describe('resolvePipelineRootId', () => {
    it('returns pipeline.of when the task is a member', () => {
        const t = makeTask('discover', { of: 'file-system-scan' });
        expect(resolvePipelineRootId(t)).toBe('file-system-scan');
    });

    it('returns the task id when the task has no pipeline metadata', () => {
        const t = makeTask('orphan');
        expect(resolvePipelineRootId(t)).toBe('orphan');
    });
});

describe('collectPipelineMembers', () => {
    it('returns all tasks whose pipeline.of matches the root id', () => {
        const tasks: TaskDefinitionSummary[] = [
            makeTask('a', { of: 'pipe1' }),
            makeTask('b', { of: 'pipe1', after: ['a'] }),
            makeTask('c', { of: 'pipe2' }),
            makeTask('d'),
        ];
        const members = collectPipelineMembers('pipe1', tasks);
        expect(members.map((m) => m.id)).toEqual(['a', 'b']);
    });

    it('includes a task whose id matches root id even without pipeline.of', () => {
        // Defensive: if a future plugin registers a "root" task whose id
        // is also the pipeline name, it still appears in the layout.
        const tasks: TaskDefinitionSummary[] = [
            makeTask('parent'),
            makeTask('child', { of: 'parent', after: ['parent'] }),
        ];
        const members = collectPipelineMembers('parent', tasks);
        expect(members.map((m) => m.id).sort()).toEqual(['child', 'parent']);
    });

    it('returns empty array for unknown root', () => {
        expect(collectPipelineMembers('nothing', [makeTask('a', { of: 'pipe1' })])).toEqual([]);
    });
});

describe('layoutPipeline', () => {
    it('returns null when no members exist', () => {
        expect(layoutPipeline('unknown', [makeTask('foo', { of: 'other' })])).toBeNull();
    });

    it('lays out a simple 3-stage chain (file-system-scan example)', () => {
        const tasks: TaskDefinitionSummary[] = [
            makeTask('discover', { of: 'fs-scan' }),
            makeTask('probe', {
                of: 'fs-scan',
                after: ['discover'],
                hasWhen: true,
            }),
            makeTask('ingest', { of: 'fs-scan', after: ['probe'] }),
        ];

        const layout = layoutPipeline('fs-scan', tasks);
        expect(layout).not.toBeNull();
        const l = layout!;
        expect(l.members.map((m) => m.id)).toEqual(['discover', 'probe', 'ingest']);
        // No multi-parent edges → no gates.
        expect(l.nodes.filter((n) => n.isGate)).toHaveLength(0);
        expect(l.nodes).toHaveLength(3);

        // Topological vertical order: discover.y < probe.y < ingest.y.
        const byId = new Map(l.nodes.map((n) => [n.id, n]));
        expect(byId.get('discover')!.y).toBeLessThan(byId.get('probe')!.y);
        expect(byId.get('probe')!.y).toBeLessThan(byId.get('ingest')!.y);

        // Each node uses the configured size (sanity).
        for (const n of l.nodes) {
            expect(n.width).toBe(NODE_WIDTH);
            expect(n.height).toBe(NODE_HEIGHT);
        }

        // Edges run discover → probe → ingest (no gates).
        const edgeKeys = l.edges.map((e) => `${e.from}->${e.to}`).sort();
        expect(edgeKeys).toEqual(['discover->probe', 'probe->ingest']);

        // Canvas dims are positive.
        expect(l.width).toBeGreaterThan(0);
        expect(l.height).toBeGreaterThan(0);
    });

    it('inserts a synthetic gate node for multi-parent fan-in', () => {
        const tasks: TaskDefinitionSummary[] = [
            makeTask('a', { of: 'pipe' }),
            makeTask('b', { of: 'pipe' }),
            makeTask('c', { of: 'pipe', after: ['a', 'b'] }),
        ];

        const l = layoutPipeline('pipe', tasks);
        expect(l).not.toBeNull();
        const gates = l!.nodes.filter((n) => n.isGate);
        expect(gates).toHaveLength(1);
        expect(gates[0].id).toBe('__gate__c');
        expect(gates[0].task).toBeUndefined();

        // Edges: a→gate, b→gate, gate→c.
        const edgeKeys = l!.edges.map((e) => `${e.from}->${e.to}`).sort();
        expect(edgeKeys).toEqual(['__gate__c->c', 'a->__gate__c', 'b->__gate__c']);
    });

    it('ignores pipeline.after entries that reference non-members', () => {
        // Defensive: if a plugin references a parent that exists in a
        // different pipeline (misconfigured), we silently drop the edge
        // rather than blow up dagre with a dangling reference.
        const tasks: TaskDefinitionSummary[] = [
            makeTask('child', { of: 'pipe', after: ['ghost'] }),
        ];
        const l = layoutPipeline('pipe', tasks);
        expect(l).not.toBeNull();
        expect(l!.nodes).toHaveLength(1);
        expect(l!.edges).toHaveLength(0);
    });

    it('handles a single-node pipeline (only the entry point)', () => {
        const tasks: TaskDefinitionSummary[] = [makeTask('solo', { of: 'pipe' })];
        const l = layoutPipeline('pipe', tasks);
        expect(l).not.toBeNull();
        expect(l!.nodes).toHaveLength(1);
        expect(l!.edges).toHaveLength(0);
        expect(l!.width).toBeGreaterThan(0);
        expect(l!.height).toBeGreaterThan(0);
    });

    it('produces center-corrected x,y coordinates (top-left, not center)', () => {
        const tasks: TaskDefinitionSummary[] = [makeTask('a', { of: 'pipe' })];
        const l = layoutPipeline('pipe', tasks);
        const n = l!.nodes[0];
        // After top-left conversion, x and y are >= 0 (with marginx/y added by dagre).
        expect(n.x).toBeGreaterThanOrEqual(0);
        expect(n.y).toBeGreaterThanOrEqual(0);
    });
});

describe('pointsToBezierPath', () => {
    it('returns empty string for empty input', () => {
        expect(pointsToBezierPath([])).toBe('');
    });

    it('renders a single point as Move only', () => {
        expect(pointsToBezierPath([{ x: 5, y: 10 }])).toBe('M 5,10');
    });

    it('renders two points as a straight Line', () => {
        expect(
            pointsToBezierPath([
                { x: 0, y: 0 },
                { x: 10, y: 20 },
            ]),
        ).toBe('M 0,0 L 10,20');
    });

    it('renders 3+ points using cubic Bezier segments', () => {
        const path = pointsToBezierPath([
            { x: 0, y: 0 },
            { x: 5, y: 10 },
            { x: 10, y: 20 },
        ]);
        expect(path.startsWith('M 0,0')).toBe(true);
        expect(path).toContain(' C ');
        // Path ends at the final point.
        expect(path.endsWith('10,20')).toBe(true);
    });
});
