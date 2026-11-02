// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/admin/media/[id]/index.ts (DELETE /api/admin/media/[id]).
 *
 * Covers the cascade query flag: without `cascade=true` a media item with
 * children yields a 409 whose `details` carries a JSON `{ childCount }`
 * payload; with `cascade=true` the service performs the recursive delete.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';

const mockGetDb = vi.fn();
const mockCountDescendants = vi.fn();
const mockHardDelete = vi.fn();

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

class CascadeLimitExceededError extends Error {
    readonly childCount: number;
    constructor(childCount: number, max: number) {
        super(`exceeds ${max}`);
        this.name = 'CascadeLimitExceededError';
        this.childCount = childCount;
    }
}

vi.mock('$lib/server/services/media-deletion.service.js', () => ({
    MediaDeletionService: {
        countDescendants: (...args: unknown[]) => mockCountDescendants(...args),
        hardDelete: (...args: unknown[]) => mockHardDelete(...args),
    },
    CascadeLimitExceededError,
}));

const { def } = await import('./index.js');

const CTX_BASE = { surface: 'internal' as const };

function makeEvent(query: Record<string, string> = {}): RequestEvent {
    const url = new URL('http://localhost/api/admin/media/0d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6');
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return {
        url,
        params: { id: '0d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6' },
        route: { id: '/api/admin/media/[id]' as const },
        request: new Request(url.toString(), { method: 'DELETE' }),
        locals: {
            principal: { username: 'admin' },
            resolvedIds: { internalId: '0d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6' },
        },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

function makeCtx(cascade?: 'true' | 'false'): ApiContext<NonNullable<typeof def.request>> {
    return {
        ...CTX_BASE,
        input: {
            body: undefined,
            params: undefined,
            query: cascade !== undefined ? { cascade } : {},
        },
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue({});
});

describe('DELETE /api/admin/media/[id] — cascade flag', () => {
    it('409 with childCount when children exist and no cascade', async () => {
        mockCountDescendants.mockResolvedValue(2);

        const handler = def.handlers.DELETE!;
        const res = await handler(makeEvent(), makeCtx());

        expect(res.status).toBe(409);
        const body = await res.clone().json();
        expect(JSON.parse(body.details)).toEqual({ childCount: 2 });
        expect(mockHardDelete).not.toHaveBeenCalled();
    });

    it('deletes without a children check when no descendants exist', async () => {
        mockCountDescendants.mockResolvedValue(0);
        mockHardDelete.mockResolvedValue({ deleted: true, deletedCount: 1 });

        const handler = def.handlers.DELETE!;
        const res = await handler(makeEvent(), makeCtx());

        expect(res.status).toBe(200);
        const body = await res.clone().json();
        expect(body.deleted).toBe(true);
    });

    it('cascades when cascade=true', async () => {
        mockCountDescendants.mockResolvedValue(2);
        mockHardDelete.mockResolvedValue({ deleted: true, deletedCount: 3 });

        const handler = def.handlers.DELETE!;
        const res = await handler(makeEvent({ cascade: 'true' }), makeCtx('true'));

        // maxDescendants is passed as the in-tx backstop for the cap when cascading.
        expect(mockHardDelete).toHaveBeenCalledWith(
            expect.anything(),
            '0d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6',
            expect.objectContaining({ cascade: true, maxDescendants: expect.any(Number) }),
        );
        expect(res.status).toBe(200);
    });

    it('409 when cascade=true would exceed LUMASTRA_CASCADE_DELETE_MAX', async () => {
        mockCountDescendants.mockResolvedValue(10_000);

        const handler = def.handlers.DELETE!;
        const res = await handler(makeEvent({ cascade: 'true' }), makeCtx('true'));

        expect(res.status).toBe(409);
        expect(mockHardDelete).not.toHaveBeenCalled();
    });

    it('maps an in-tx CascadeLimitExceededError to 409 with childCount', async () => {
        // Pre-check passes (count under the limit) but a concurrent insert grew
        // the subtree, so hardDelete throws the in-tx backstop error.
        mockCountDescendants.mockResolvedValue(1);
        mockHardDelete.mockRejectedValue(new CascadeLimitExceededError(9999, 5000));

        const handler = def.handlers.DELETE!;
        const res = await handler(makeEvent({ cascade: 'true' }), makeCtx('true'));

        expect(res.status).toBe(409);
        const body = await res.clone().json();
        expect(JSON.parse(body.details)).toEqual({ childCount: 9999 });
    });
});
