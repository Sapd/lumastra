// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Unit tests for cloud-events.ts — buildCloudEvent + cloudEvents convenience builders.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('$lib/server/config.js', () => ({
    config: { INSTANCE_ID: 'test-node-1' },
}));

import {
    buildCloudEvent,
    buildMediaCloudEvent,
    cloudEvents,
    WEBHOOK_EVENTS,
} from './cloud-events.js';
import type { CloudEventType } from './cloud-events.js';

// ── buildCloudEvent ───────────────────────────────────────────────────────────

describe('buildCloudEvent', () => {
    it('returns a valid CloudEvents 1.0 envelope', () => {
        const event = buildCloudEvent('org.lumastra.task.run.started', 'my-task', 'run_abc', {
            foo: 1,
        });
        expect(event.specversion).toBe('1.0');
        expect(event.datacontenttype).toBe('application/json');
        expect(typeof event.id).toBe('string');
        expect(event.id.length).toBeGreaterThan(0);
    });

    it('sets source to lumastra://task-orchestrator/<instanceId>', () => {
        const event = buildCloudEvent('org.lumastra.task.run.completed', 'task-a', 'run_1', {});
        expect(event.source).toBe('lumastra://task-orchestrator/test-node-1');
    });

    it('sets subject to <taskId>/<runId>', () => {
        const event = buildCloudEvent('org.lumastra.task.run.failed', 'task-b', 'run_2', {});
        expect(event.subject).toBe('task-b/run_2');
    });

    it('sets time as ISO-8601 string', () => {
        const event = buildCloudEvent('org.lumastra.task.run.cancelled', 'task-c', 'run_3', {});
        const parsed = new Date(event.time);
        expect(Number.isNaN(parsed.getTime())).toBe(false);
    });

    it('attaches the data payload verbatim', () => {
        const data = { runId: 'run_4', status: 'ok' };
        const event = buildCloudEvent(
            'org.lumastra.task.run.stage.completed',
            'task-d',
            'run_4',
            data,
        );
        expect(event.data).toEqual(data);
    });

    it('sets the correct type on each event', () => {
        const types: CloudEventType[] = [
            'org.lumastra.task.run.started',
            'org.lumastra.task.run.completed',
            'org.lumastra.task.run.failed',
            'org.lumastra.task.run.cancelled',
            'org.lumastra.task.run.stage.completed',
            'org.lumastra.task.cost.threshold.exceeded',
        ];
        for (const type of types) {
            const event = buildCloudEvent(type, 't', 'r', {});
            expect(event.type).toBe(type);
        }
    });

    it('generates unique IDs across calls', () => {
        const a = buildCloudEvent('org.lumastra.task.run.started', 't', 'r1', {});
        const b = buildCloudEvent('org.lumastra.task.run.started', 't', 'r2', {});
        expect(a.id).not.toBe(b.id);
    });
});

// ── cloudEvents convenience builders ─────────────────────────────────────────

describe('cloudEvents builders', () => {
    it('runStarted produces correct type and subject', () => {
        const e = cloudEvents.runStarted('import-task', 'run_11', { ok: true });
        expect(e.type).toBe('org.lumastra.task.run.started');
        expect(e.subject).toBe('import-task/run_11');
        expect(e.data).toEqual({ ok: true });
    });

    it('runCompleted produces correct type', () => {
        const e = cloudEvents.runCompleted('import-task', 'run_12', {});
        expect(e.type).toBe('org.lumastra.task.run.completed');
    });

    it('runFailed produces correct type', () => {
        const e = cloudEvents.runFailed('import-task', 'run_13', {});
        expect(e.type).toBe('org.lumastra.task.run.failed');
    });

    it('runCancelled produces correct type', () => {
        const e = cloudEvents.runCancelled('import-task', 'run_14', {});
        expect(e.type).toBe('org.lumastra.task.run.cancelled');
    });

    it('stageCompleted produces correct type', () => {
        const e = cloudEvents.stageCompleted('import-task', 'run_15', {});
        expect(e.type).toBe('org.lumastra.task.run.stage.completed');
    });

    it('costThresholdExceeded produces correct type', () => {
        const e = cloudEvents.costThresholdExceeded('import-task', 'run_16', {});
        expect(e.type).toBe('org.lumastra.task.cost.threshold.exceeded');
    });
});

describe('buildMediaCloudEvent', () => {
    const item = {
        mediaType: 'movie',
        title: 'Awakening',
        year: 2016,
        internalId: '1a2b',
        externalIds: { tmdb: '329865' },
        posterPath: '/api/media/1a2b/image/poster',
        libraryGroupId: 'lg-1',
    };

    it('builds an org.lumastra.media.item.added batch envelope', () => {
        const ev = buildMediaCloudEvent([item], 'lg-1');
        expect(ev.type).toBe('org.lumastra.media.item.added');
        expect(ev.subject).toBe('media/batch');
        expect(ev.source).toContain('lumastra://pipeline/');
        const data = ev.data as {
            count: number;
            items: unknown[];
            scope: { libraryGroupId: string | null };
        };
        expect(data.count).toBe(1);
        expect(data.items).toHaveLength(1);
        expect(data.scope.libraryGroupId).toBe('lg-1');
    });
});

describe('webhook delivery catalogue', () => {
    it('contains only the six event types with production delivery wiring', () => {
        const expected: CloudEventType[] = [
            'org.lumastra.task.run.started',
            'org.lumastra.task.run.completed',
            'org.lumastra.task.run.failed',
            'org.lumastra.task.run.cancelled',
            'org.lumastra.media.item.added',
            'org.lumastra.user.notification',
        ];
        expect(WEBHOOK_EVENTS.map((event) => event.type)).toEqual(expected);
        expect(WEBHOOK_EVENTS.every((event) => event.description.length > 0)).toBe(true);
    });
});
