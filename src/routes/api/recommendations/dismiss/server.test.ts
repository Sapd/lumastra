// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const service = vi.hoisted(() => ({
    recordDismiss: vi.fn(),
    getDismissCount: vi.fn(),
    getDismissedMediaKeys: vi.fn(),
    clearDismissState: vi.fn(),
}));
const getSql = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/services/database.service', () => ({ aiDbService: { getSql } }));
vi.mock('$lib/server/services/dismiss.service', () => ({ getDismissService: () => service }));
const { GET, POST, DELETE } = await import('./+server.js');

function event(method: string, query = '', body?: unknown): RequestEvent {
    const url = new URL(`http://localhost/api/recommendations/dismiss${query}`);
    return {
        url,
        params: {},
        route: { id: '/api/recommendations/dismiss' },
        request: new Request(url, {
            method,
            ...(body === undefined
                ? {}
                : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
        }),
        locals: { user: { userId: '550e8400-e29b-41d4-a716-446655440001', username: 'alex' } },
        getClientAddress: () => '127.0.0.1',
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}
beforeEach(() => {
    vi.clearAllMocks();
    getSql.mockResolvedValue({});
    service.recordDismiss.mockResolvedValue({ success: true, dismissCount: 1 });
    service.getDismissCount.mockResolvedValue(1);
    service.getDismissedMediaKeys.mockResolvedValue(['tmdb:2:movie']);
});

describe('mounted dismissal method validation', () => {
    it('records a valid POST without a source query', async () => {
        const response = await POST!(
            event('POST', '', {
                sourceMediaKey: 'tmdb:1:movie',
                dismissedMediaKey: 'tmdb:2:movie',
            }),
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ dismissed: true, dismissCount: 1 });
        expect(service.recordDismiss).toHaveBeenCalledWith(
            '550e8400-e29b-41d4-a716-446655440001',
            'tmdb:1:movie',
            'tmdb:2:movie',
        );
    });
    it.each([undefined, {}, { sourceMediaKey: 'bad', dismissedMediaKey: 'tmdb:2:movie' }])(
        'rejects invalid POST body %j before persistence',
        async (body) => {
            const response = await POST!(event('POST', '', body));
            expect(response.status).toBe(422);
            expect(await response.json()).toMatchObject({ code: 'validation_failed' });
            expect(getSql).not.toHaveBeenCalled();
            expect(service.recordDismiss).not.toHaveBeenCalled();
        },
    );
    it('rejects malformed JSON before persistence', async () => {
        const input = event('POST');
        input.request = new Request(input.url, {
            method: 'POST',
            body: '{',
            headers: { 'Content-Type': 'application/json' },
        });
        const response = await POST!(input);
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({ code: 'validation_failed' });
        expect(getSql).not.toHaveBeenCalled();
    });
    it.each(['GET', 'DELETE'])('%s reads the requested source', async (method) => {
        const handler = method === 'GET' ? GET! : DELETE!;
        const response = await handler(event(method, '?source=tmdb:1:movie'));
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ sourceMediaKey: 'tmdb:1:movie' });
        expect(
            method === 'GET' ? service.getDismissCount : service.clearDismissState,
        ).toHaveBeenCalledWith('550e8400-e29b-41d4-a716-446655440001', 'tmdb:1:movie');
    });
    it.each(['GET', 'DELETE'])('%s rejects missing or invalid source query', async (method) => {
        for (const query of ['', '?source=bad']) {
            const response = await (method === 'GET' ? GET! : DELETE!)(event(method, query));
            expect(response.status).toBe(422);
            expect(await response.json()).toMatchObject({ code: 'validation_failed' });
        }
        expect(getSql).not.toHaveBeenCalled();
    });
    it('keeps authentication and age restrictions active', async () => {
        const anonymous = event('POST');
        delete (anonymous.locals as Partial<RequestEvent['locals']>).user;
        expect((await POST!(anonymous)).status).toBe(401);
        const restricted = event('POST');
        restricted.locals.user!.isAgeRestricted = true;
        expect((await POST!(restricted)).status).toBe(403);
        expect(getSql).not.toHaveBeenCalled();
    });
});
