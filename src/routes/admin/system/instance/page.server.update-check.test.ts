// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The `reviewSecurity` action: the one way to quiet a red security-update
 * notice without updating. Admin only, audited, and only for a release the
 * stored list really flags as a security release.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const markSecurityReviewed = vi.hoisted(() => vi.fn(async (_sql: unknown, _v: string) => true));
const unmarkSecurityReviewed = vi.hoisted(() => vi.fn(async (_sql: unknown, _v: string) => {}));
const auditLog = vi.hoisted(() => vi.fn());
const bustAttentionCache = vi.hoisted(() => vi.fn(async () => 1));

vi.mock('$lib/server/config.js', () => ({
    config: {
        INSTANCE_USE_CASES: [],
        buildInfo: { version: 'v0.1.0' },
        UPDATE_CHECK_ENABLED: true,
    },
    hasEmbeddingProvider: () => false,
}));
vi.mock('$lib/server/config/index.js', () => ({ saveConfig: vi.fn() }));
vi.mock('$lib/server/config/config.service.js', () => ({ isEnvOverridden: () => false }));
vi.mock('$lib/server/services/sonic-embedding.service.js', () => ({
    isSonicEngineConfigured: () => false,
}));
vi.mock('$lib/server/database/index.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/install-identity.queries.js', () => ({
    getInstallUuid: vi.fn(),
}));
vi.mock('$lib/server/utils/audit-log.js', () => ({
    auditLog,
    auditActorFromLocals: () => ({ username: 'admin' }),
}));
vi.mock('$lib/server/services/lumastra-update/check.js', () => ({
    markSecurityReviewed,
    unmarkSecurityReviewed,
    readUpdateState: vi.fn(),
    evaluateStoredUpdate: vi.fn(),
}));
vi.mock('$lib/server/services/attention/attention-cache.js', () => ({ bustAttentionCache }));

import { actions } from './+page.server.js';

function event(version: string | null, isAdmin = true, raw?: string) {
    const body = new FormData();
    if (version !== null) body.set('version', version);
    return {
        request: new Request('http://localhost/admin/system/instance?/reviewSecurity', {
            method: 'POST',
            ...(raw !== undefined
                ? { body: raw, headers: { 'content-type': 'application/json' } }
                : { body }),
        }),
        locals: { user: { username: 'u', isAdmin }, principal: { isAdmin } },
    } as never;
}

beforeEach(() => {
    markSecurityReviewed.mockReset().mockResolvedValue(true);
    unmarkSecurityReviewed.mockReset();
    auditLog.mockReset();
    bustAttentionCache.mockClear();
});

describe('/admin/system/instance reviewSecurity', () => {
    it('refuses non-admins before touching anything', async () => {
        const out = (await actions.reviewSecurity(event('0.1.1', false))) as { status?: number };
        expect(out.status).toBe(403);
        expect(markSecurityReviewed).not.toHaveBeenCalled();
    });

    it('rejects a missing version and one that is not a stored security release', async () => {
        expect(((await actions.reviewSecurity(event(null))) as { status?: number }).status).toBe(
            400,
        );
        markSecurityReviewed.mockResolvedValueOnce(false);
        expect(((await actions.reviewSecurity(event('9.9.9'))) as { status?: number }).status).toBe(
            400,
        );
        expect(auditLog).not.toHaveBeenCalled();
    });

    it('records the review, audits it and refreshes the notices', async () => {
        const out = await actions.reviewSecurity(event('0.1.1'));
        expect(out).toEqual({ securityReviewChanged: '0.1.1' });
        expect(markSecurityReviewed).toHaveBeenCalledWith({}, '0.1.1');
        expect(auditLog).toHaveBeenCalledWith(
            'update-check.security-reviewed',
            'lumastra-update',
            { username: 'admin' },
            { version: '0.1.1', running: 'v0.1.0' },
        );
        expect(bustAttentionCache).toHaveBeenCalled();
    });

    it('answers 400, not 500, to a body that is not a form', async () => {
        const out = (await actions.reviewSecurity(event(null, true, '{}'))) as {
            status?: number;
        };
        expect(out.status).toBe(400);
    });

    it('still reports success when only the cache refresh fails', async () => {
        bustAttentionCache.mockRejectedValueOnce(new Error('valkey down'));
        expect(await actions.reviewSecurity(event('0.1.1'))).toEqual({
            securityReviewChanged: '0.1.1',
        });
    });
});

describe('/admin/system/instance unreviewSecurity', () => {
    it('is admin only, then removes the review and audits it', async () => {
        const denied = (await actions.unreviewSecurity(event('0.1.1', false))) as {
            status?: number;
        };
        expect(denied.status).toBe(403);
        expect(unmarkSecurityReviewed).not.toHaveBeenCalled();

        await actions.unreviewSecurity(event('0.1.1'));
        expect(unmarkSecurityReviewed).toHaveBeenCalledWith({}, '0.1.1');
        expect(auditLog).toHaveBeenCalledWith(
            'update-check.security-unreviewed',
            'lumastra-update',
            { username: 'admin' },
            { version: '0.1.1', running: 'v0.1.0' },
        );
    });
});
