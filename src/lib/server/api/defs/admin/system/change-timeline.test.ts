// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiContext } from '$lib/server/api/define.js';

const mockGetDb = vi.fn();
const mockListAdminAuditFeed = vi.fn();
const mockGetTask = vi.fn();
const mockGetConfigForAdmin = vi.fn();

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

vi.mock('$lib/server/database/queries/admin-audit.queries.js', () => ({
    listAdminAuditFeed: (...args: unknown[]) => mockListAdminAuditFeed(...args),
}));

vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { getTask: (...args: unknown[]) => mockGetTask(...args) },
}));

vi.mock('$lib/server/config/index.js', () => ({
    getConfigForAdmin: (...args: unknown[]) => mockGetConfigForAdmin(...args),
}));

const { def } = await import('./change-timeline.js');

function makeCtx(sinceHours?: number): ApiContext<NonNullable<typeof def.request>> {
    return {
        surface: 'internal',
        input: { body: undefined, params: undefined, query: { sinceHours } },
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue({});
    mockGetConfigForAdmin.mockReturnValue({
        schema: {
            settings: [
                { key: 'tmdbApiKey', label: 'TMDB API Key' },
                { key: 'metadataLanguage', label: 'Metadata Language' },
            ],
        },
    });
});

describe('GET /api/admin/system/change-timeline', () => {
    it('reports version tracking as unavailable on every response', async () => {
        mockListAdminAuditFeed.mockResolvedValue({ events: [], nextCursor: null });

        const response = await def.handlers.GET!(null as never, makeCtx());
        const body = await response.json();

        expect(body.versionTrackingAvailable).toBe(false);
        expect(body.events).toEqual([]);
    });

    it('resolves the task display name for a task.pause event', async () => {
        mockGetTask.mockReturnValue({ id: 'intro-detection', name: 'Intro Detection' });
        mockListAdminAuditFeed.mockResolvedValue({
            events: [
                {
                    id: 1,
                    ts: '2026-08-24T14:02:00.000Z',
                    instanceId: 'web-1',
                    actor: 'admin',
                    action: 'task.pause',
                    target: 'intro-detection',
                    outcome: 'ok',
                    detail: {},
                },
            ],
            nextCursor: null,
        });

        const response = await def.handlers.GET!(null as never, makeCtx());
        const body = await response.json();

        expect(body.events[0]).toMatchObject({
            kind: 'task-pause',
            taskName: 'Intro Detection',
        });
    });

    it('maps changedKeys to human labels for a settings.save event, capped', async () => {
        mockListAdminAuditFeed.mockResolvedValue({
            events: [
                {
                    id: 2,
                    ts: '2026-08-24T19:07:00.000Z',
                    instanceId: 'web-1',
                    actor: 'admin',
                    action: 'settings.save',
                    target: 'config',
                    outcome: 'ok',
                    detail: { changedKeys: ['tmdbApiKey', 'unknownKey'] },
                },
            ],
            nextCursor: null,
        });

        const response = await def.handlers.GET!(null as never, makeCtx());
        const body = await response.json();

        expect(body.events[0].kind).toBe('settings');
        expect(body.events[0].changedLabels).toEqual(['TMDB API Key', 'unknownKey']);
        expect(body.events[0].changedLabelsTruncated).toBe(false);
    });

    it('returns 503 when the database is unreachable', async () => {
        mockGetDb.mockReturnValue(null);

        const response = await def.handlers.GET!(null as never, makeCtx());

        expect(response.status).toBe(503);
    });

    it('passes the requested lookback window through to the audit query', async () => {
        mockListAdminAuditFeed.mockResolvedValue({ events: [], nextCursor: null });

        const response = await def.handlers.GET!(null as never, makeCtx(24));
        const body = await response.json();

        expect(body.window).toEqual({ sinceHours: 24 });
        expect(mockListAdminAuditFeed).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ since: expect.any(Date) }),
        );
    });
});
