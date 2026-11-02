// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/admin/users/:username/gdpr-export walks every per-user table and
 * had no rate limit while the sibling DELETE has one (admin/users review
 * 2026-10-07, item 8c). The limiter is keyed on caller IP + username and
 * answers 429 before the export is collected.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';
import { buildPrincipal } from '$lib/server/api/principal.js';
import { toUserId } from '$lib/shared/user-id.js';

const mockCheckRateLimit = vi.fn();
const mockCollectUserExport = vi.fn();
vi.mock('$lib/server/database/index.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/utils/audit-log.js', () => ({ auditLog: vi.fn(), auditActor: () => ({}) }));
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: (...a: unknown[]) => mockCheckRateLimit(...a),
}));
vi.mock('$lib/server/utils/client-ip.js', () => ({ getClientIpStrict: () => '203.0.113.9' }));
vi.mock('$lib/server/database/queries/gdpr-export.queries.js', () => ({
    collectUserExport: (...a: unknown[]) => mockCollectUserExport(...a),
}));

import { def } from './gdpr-export.js';

const admin = buildPrincipal({
    kind: 'session',
    userId: toUserId('00000000-0000-0000-0000-000000000042'),
    username: 'root',
    userGroups: ['admins'],
    sessionIsAdmin: true,
});

async function call(): Promise<Response> {
    const url = new URL('http://localhost/api/admin/users/target/gdpr-export');
    return def.handlers.GET!(
        {
            url,
            params: { username: 'target' },
            locals: { principal: admin, user: undefined },
            request: new Request(url),
        } as unknown as RequestEvent,
        { surface: 'internal' } as unknown as ApiContext,
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    mockCollectUserExport.mockResolvedValue({ exported_at: '2026-10-07T00:00:00Z', user: {} });
});

describe('GET gdpr-export: rate limit', () => {
    it('429 with Retry-After once the caller is over the limit, without collecting the export', async () => {
        const resetAt = Math.floor(Date.now() / 1000) + 120;
        mockCheckRateLimit.mockResolvedValue({ allowed: false, resetAt });
        const res = await call();
        expect(res.status).toBe(429);
        expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
        expect(mockCollectUserExport).not.toHaveBeenCalled();
        expect(mockCheckRateLimit).toHaveBeenCalledWith(
            'gdpr-export:203.0.113.9:root',
            expect.any(Number),
            expect.any(Number),
        );
    });

    it('exports when under the limit', async () => {
        mockCheckRateLimit.mockResolvedValue({ allowed: true, resetAt: 0 });
        const res = await call();
        expect(res.status).toBe(200);
        expect(mockCollectUserExport).toHaveBeenCalledWith(expect.anything(), 'target');
    });
});
