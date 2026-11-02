// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import type { TaskDefinitionSummary } from '$lib/schemas/task-definition.schema.js';
import { setLocale } from '$lib/paraglide/runtime.js';
import { fromTaskSummary } from './from-task-summary.js';

function task(overrides: Partial<TaskDefinitionSummary> = {}): TaskDefinitionSummary {
    return {
        version: '1.0.0',
        processingVersion: 1,
        resourceClass: 'io',
        capabilities: {},
        visibility: 'user',
        supportsPerItemRetry: false,
        id: 'plugin:image-sync',
        name: 'Image Sync',
        ...overrides,
    };
}

describe('fromTaskSummary run action', () => {
    // The admin UI authenticates with the session cookie. /api/v1 is
    // bearer-only, so a browser POST there answers 401 "Bearer token required".
    it('posts to the cookie-authenticated /api surface, not /api/v1', () => {
        const { primaryAction } = fromTaskSummary(task());
        expect(primaryAction?.request.url).toBe('/api/tasks/plugin%3Aimage-sync/run');
    });
});

describe('fromTaskSummary stat tiles', () => {
    afterEach(() => {
        setLocale('en', { reload: false });
    });

    const tile = (t: TaskDefinitionSummary, key: string) =>
        fromTaskSummary(t).stats?.find((s) => s.key === key);

    it('missing lane data renders as unknown, never as a healthy 0', () => {
        const t = task();
        for (const key of ['backlog', 'failures']) {
            expect(tile(t, key)?.value).toBe('—');
            expect(tile(t, key)?.healthy).toBeUndefined();
        }
        expect(tile(t, 'active')?.value).toBe('—');
    });

    it('known zeros are healthy; known counts are not', () => {
        const t = task({ activeCount: 0, backlogRemaining: 0, recentFailCount: 3 });
        expect(tile(t, 'backlog')).toMatchObject({ value: 0, healthy: true });
        expect(tile(t, 'failures')).toMatchObject({ value: 3, healthy: false });
        expect(tile(t, 'active')?.value).toBe(0);
    });

    it('labels trickplay backlog as linked files in Overview', () => {
        const t = task({
            id: 'trickplay-params-sync',
            backlog: { unitLabel: 'file links' },
            backlogRemaining: 2,
        });
        expect(tile(t, 'backlog')).toMatchObject({
            value: 2,
            subtitle: 'file links remaining',
        });
    });

    it('localizes the Overview file-link unit in German', () => {
        setLocale('de', { reload: false });
        const t = task({
            id: 'trickplay-params-sync',
            backlog: { unitLabel: 'file links' },
            backlogRemaining: 2,
        });
        expect(tile(t, 'backlog')?.subtitle).toBe('Dateiverknüpfungen verbleibend');
    });
});
