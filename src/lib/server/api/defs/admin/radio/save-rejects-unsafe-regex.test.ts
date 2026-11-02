// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security review 2026-09-12, C7 follow-up: the admin radio create/update
 * endpoints must refuse an unsafe now-playing regex at save time instead of
 * storing it for the poller to choke on.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockSql = vi.fn();
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => {
        const fn = (...args: unknown[]) => mockSql(...args);
        fn.json = (v: unknown) => v;
        return fn;
    },
}));
vi.mock('$lib/server/services/radio-metadata/index.js', () => ({
    peekCacheRecord: vi.fn(),
    clearRadioCache: vi.fn(),
}));
vi.mock('$lib/server/services/media-image-storage.service.js', () => ({
    storeMediaImage: vi.fn(),
    deleteMediaImage: vi.fn(),
}));
vi.mock('$lib/server/utils/ssrf-guard.js', () => ({ assertNotPrivateUrl: vi.fn() }));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

import { def as createDef } from './index.js';
import { def as updateDef } from './[id]/index.js';

const UNSAFE = { url: 'https://radio.example/now', format: 'regex', regexPattern: '(a|a)+' };

function makeEvent(
    method: string,
    body: unknown,
    params: Record<string, string> = {},
): RequestEvent {
    return {
        request: new Request('http://localhost/api/admin/radio', {
            method,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }),
        url: new URL('http://localhost/api/admin/radio'),
        params,
        locals: { user: { username: 'root', ownerIsAdmin: true } },
    } as unknown as RequestEvent;
}

const ctx = { surface: 'internal' } as never;

describe('admin radio save: unsafe now-playing regex is rejected (C7)', () => {
    beforeEach(() => mockSql.mockReset());

    it('POST create -> 422 naming the pattern field, nothing inserted', async () => {
        const res = await createDef.handlers.POST!(
            makeEvent('POST', {
                name: 'x',
                streamUrl: 'https://radio.example/stream',
                metadataSource: UNSAFE,
            }),
            ctx,
        );
        expect(res.status).toBe(422);
        const body = (await res.json()) as { details: Array<{ field: string }> };
        expect(body.details[0].field).toBe('metadataSource.regexPattern');
        expect(mockSql).not.toHaveBeenCalled();
    });

    it('PATCH update -> 422, no UPDATE issued', async () => {
        mockSql.mockResolvedValueOnce([
            { id: '11111111-1111-4111-8111-111111111111', title: 't', custom_metadata: {} },
        ]);
        const res = await updateDef.handlers.PATCH!(
            makeEvent(
                'PATCH',
                { metadataSource: UNSAFE },
                { id: '11111111-1111-4111-8111-111111111111' },
            ),
            ctx,
        );
        expect(res.status).toBe(422);
        expect(mockSql).toHaveBeenCalledTimes(1); // only the SELECT
    });
});
