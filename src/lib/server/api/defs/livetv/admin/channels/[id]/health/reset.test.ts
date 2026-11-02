// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The health reset is an admin mutation on both surfaces (/api/admin/... and /api/v1/...). The
 * scope gate must hold on each, and a refused caller must never reach the query.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const { mockReset, mockGetSql, mockInvalidate } = vi.hoisted(() => ({
    mockReset: vi.fn(),
    mockGetSql: vi.fn(),
    mockInvalidate: vi.fn(),
}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));
vi.mock('$lib/server/database/queries/livetv-channel-health.queries.js', () => ({
    reset: (...args: unknown[]) => mockReset(...args),
}));
vi.mock('$lib/server/services/livetv-cache.service.js', () => ({
    invalidateLiveTvCaches: (...args: unknown[]) => mockInvalidate(...args),
}));
vi.mock('$lib/server/services/livetv/channel-health.service.js', () => ({
    EMPTY_HEALTH_VIEW: { state: 'ok', consecutiveFailures: 0 },
}));

import { mount } from '$lib/server/api/mount.js';
import { def } from './reset.js';

const CHANNEL = '550e8400-e29b-41d4-a716-446655440000';

function makeEvent(scopes: string[], channelId = CHANNEL): RequestEvent {
    const url = `http://localhost/api/livetv/admin/channels/${channelId}/health/reset`;
    return {
        url: new URL(url),
        request: new Request(url, { method: 'POST' }),
        params: { channelId },
        route: { id: '/api/livetv/admin/channels/[id]/health/reset' },
        locals: { principal: { scopes } },
        cookies: { get: vi.fn(), set: vi.fn() },
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

beforeEach(() => {
    vi.resetAllMocks();
    mockGetSql.mockResolvedValue({});
    mockReset.mockResolvedValue(true);
    mockInvalidate.mockResolvedValue(undefined);
});

describe.each(['v1', 'internal'] as const)('POST health/reset on the %s surface', (surface) => {
    it.each([[[]], [['read']], [['livetv:read']]])(
        'refuses a caller without livetv:admin (scopes %j) and never resets',
        async (scopes) => {
            const response = await mount(def, { surface }).POST!(makeEvent(scopes));
            expect(response.status).toBe(403);
            expect(mockReset).not.toHaveBeenCalled();
            expect(mockInvalidate).not.toHaveBeenCalled();
        },
    );

    it('resets the feed for an administrator and drops the lineup caches', async () => {
        const response = await mount(def, { surface }).POST!(makeEvent(['livetv:admin']));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ state: 'ok', consecutiveFailures: 0 });
        expect(mockReset).toHaveBeenCalledWith({}, CHANNEL);
        expect(mockInvalidate).toHaveBeenCalledTimes(1);
    });

    it('answers 404 for a feed that does not exist', async () => {
        mockReset.mockResolvedValue(false);
        const response = await mount(def, { surface }).POST!(makeEvent(['livetv:admin']));
        expect(response.status).toBe(404);
        expect(mockInvalidate).not.toHaveBeenCalled();
    });

    it('rejects a channel id that is not a UUID before touching the database', async () => {
        const response = await mount(def, { surface }).POST!(
            makeEvent(['livetv:admin'], 'not-a-uuid'),
        );
        expect(response.status).toBe(422);
        expect(mockReset).not.toHaveBeenCalled();
    });
});
