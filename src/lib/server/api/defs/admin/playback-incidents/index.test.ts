// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/admin/playback-incidents/index.ts
 * (GET /api/admin/playback-incidents).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';
import type { PlaybackIncidentRow } from '$lib/server/database/queries/playback-incident-events.queries.js';

const mockGetDb = vi.fn();
const mockListPlaybackIncidents = vi.fn();

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

vi.mock('$lib/server/database/queries/playback-incident-events.queries.js', () => ({
    listPlaybackIncidents: (...args: unknown[]) => mockListPlaybackIncidents(...args),
}));

const { def } = await import('./index.js');

function makeRow(overrides: Partial<PlaybackIncidentRow> = {}): PlaybackIncidentRow {
    return {
        id: 1,
        attempt_id: 'a1',
        play_session_id: 's1',
        incident_at: new Date('2026-08-13T12:00:00Z'),
        occurred_at: new Date('2026-08-13T12:00:01Z'),
        trigger_type: 'terminal',
        error_type: null,
        stage: null,
        http_status: null,
        server_diagnostic_code: null,
        reconnect_cause: null,
        message: null,
        user_id: null,
        device_id: null,
        media_id: null,
        timeline: [],
        client_info: null,
        resolved_at: null,
        username: null,
        device_name: null,
        media_title: null,
        ...overrides,
    };
}

function makeEvent(): RequestEvent {
    const url = new URL('http://localhost/api/admin/playback-incidents');
    return { url } as unknown as RequestEvent;
}

function makeCtx(query: Record<string, unknown> = {}): ApiContext<NonNullable<typeof def.request>> {
    return {
        surface: 'internal',
        input: {
            body: undefined,
            params: undefined,
            query: {
                userId: undefined,
                deviceId: undefined,
                mediaId: undefined,
                triggerType: undefined,
                from: undefined,
                to: undefined,
                limit: 50,
                offset: 0,
                ...query,
            },
        },
    } as unknown as ApiContext<NonNullable<typeof def.request>>;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue({});
});

describe('GET /admin/playback-incidents', () => {
    it('maps filters from the parsed query into listPlaybackIncidents and returns the mapped response', async () => {
        mockListPlaybackIncidents.mockResolvedValue({ rows: [makeRow()], total: 1 });

        const handler = def.handlers.GET!;
        const res = (await handler(makeEvent(), makeCtx({ triggerType: 'terminal' }))) as Response;

        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            items: { id: number; attemptId: string; triggerType: string }[];
            page: { limit: number; offset?: number; hasMore: boolean; total?: number };
        };
        expect(body.page.total).toBe(1);
        expect(body.page.hasMore).toBe(false);
        expect(body.items).toHaveLength(1);
        expect(body.items[0]).toMatchObject({
            id: 1,
            attemptId: 'a1',
            playSessionId: 's1',
            triggerType: 'terminal',
        });

        expect(mockListPlaybackIncidents).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ triggerType: 'terminal', limit: 50, offset: 0 }),
        );
    });

    it('returns 503 dependency_unavailable when the DB is down', async () => {
        mockGetDb.mockReturnValue(null);

        const handler = def.handlers.GET!;
        const res = (await handler(makeEvent(), makeCtx())) as Response;

        expect(res.status).toBe(503);
        expect(mockListPlaybackIncidents).not.toHaveBeenCalled();
    });

    it('returns hasMore=true when more rows exist past this page', async () => {
        mockListPlaybackIncidents.mockResolvedValue({ rows: [makeRow()], total: 5 });

        const handler = def.handlers.GET!;
        const res = (await handler(makeEvent(), makeCtx({ limit: 1, offset: 0 }))) as Response;
        const body = (await res.json()) as { page: { hasMore: boolean; total?: number } };

        expect(body.page.hasMore).toBe(true);
        expect(body.page.total).toBe(5);
    });

    it('returns 500 internal_error (not an uncaught exception) for an unrecognized trigger_type', async () => {
        mockListPlaybackIncidents.mockResolvedValue({
            rows: [makeRow({ trigger_type: 'bogus' })],
            total: 1,
        });

        const handler = def.handlers.GET!;
        const res = (await handler(makeEvent(), makeCtx())) as Response;

        expect(res.status).toBe(500);
    });
});
