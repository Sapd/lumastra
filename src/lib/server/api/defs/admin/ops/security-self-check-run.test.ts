// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Each self-check run mints a service token and probes the public edge, so it
 * is rate limited install-wide, never runs twice at once, and is audited.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/config.js', () => ({
    config: { PUBLIC_BASE_URL: '', DEVICE_VERIFICATION_BASE_URL: '' },
    features: { deviceAuth: false },
}));
vi.mock('$lib/server/oauth/service-token.service.js', () => ({ getServiceTokenService: vi.fn() }));
const runSecuritySelfCheck = vi.fn();
vi.mock('$lib/server/services/security-self-check/runner.js', () => ({ runSecuritySelfCheck }));
const customCommand = vi.fn();
vi.mock('$lib/server/cache/valkey.js', () => ({
    getCoordinationClient: () => ({ customCommand }),
}));
const auditLog = vi.fn();
vi.mock('$lib/server/utils/audit-log.js', () => ({
    auditLog,
    auditActor: () => ({ username: 'admin' }),
}));

const { def } = await import('./security-self-check-run.js');

const event = {
    locals: { user: { username: 'admin', ownerIsAdmin: true } },
} as unknown as RequestEvent;
const SUMMARY = { pass: 3, warn: 1, fail: 0, skipped: 2, error: 0, info: 0 };

beforeEach(() => {
    vi.clearAllMocks();
    runSecuritySelfCheck.mockResolvedValue({ findings: [], summary: SUMMARY, ranAt: '' });
});

describe('POST /api/admin/security-self-check/run', () => {
    it('declares an install-wide rate limit', () => {
        expect(def.rateLimit?.limit).toBeLessThanOrEqual(3);
        expect(def.rateLimit?.keyBy?.(event)).toBe('admin:security-self-check');
    });

    it('a second run while one holds the lock is a 409, not a second token mint', async () => {
        customCommand.mockResolvedValue(null);
        const res = await def.handlers.POST!(event, {} as never);
        expect(res.status).toBe(409);
        expect(runSecuritySelfCheck).not.toHaveBeenCalled();
    });

    it('a run takes and releases the lock and is audited with its summary', async () => {
        customCommand.mockResolvedValue('OK');
        const res = await def.handlers.POST!(event, {} as never);
        expect(res.status).toBe(200);
        expect(customCommand.mock.calls[0][0].slice(0, 3)).toEqual([
            'SET',
            'security-self-check:running',
            '1',
        ]);
        expect(customCommand).toHaveBeenLastCalledWith(['DEL', 'security-self-check:running']);
        expect(auditLog).toHaveBeenCalledWith(
            'security.self-check.run',
            'security',
            { username: 'admin' },
            SUMMARY,
        );
    });

    it('the lock is released even when the run throws', async () => {
        customCommand.mockResolvedValue('OK');
        runSecuritySelfCheck.mockRejectedValue(new Error('boom'));
        await expect(def.handlers.POST!(event, {} as never)).rejects.toThrow('boom');
        expect(customCommand).toHaveBeenLastCalledWith(['DEL', 'security-self-check:running']);
    });
});
