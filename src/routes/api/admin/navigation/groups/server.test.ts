// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { normalizeGroupName, computeAddGroup } from './group-service.js';

const mockSaveConfig = vi.fn().mockImplementation(async (updates: Record<string, unknown>) => {
    // Simulate what reloadConfig does: update the in-memory nav groups so
    // mergedAvailableGroups() in the handler returns the post-save value.
    if (Array.isArray(updates.NAVIGATION_AVAILABLE_GROUPS)) {
        mockNavGroups = updates.NAVIGATION_AVAILABLE_GROUPS as string[];
    }
});
const mockReloadConfig = vi.fn().mockResolvedValue(undefined);
let mockEnvLocked = false;
let mockNavGroups: string[] = [];

vi.mock('$lib/server/config/config.service.js', () => ({
    saveConfig: (...a: unknown[]) => mockSaveConfig(...a),
    reloadConfig: (...a: unknown[]) => mockReloadConfig(...a),
    isEnvOverridden: () => mockEnvLocked,
    getConfigStorageStatus: async () => ({ willPersist: true }),
}));

vi.mock('$lib/server/config.js', () => ({
    FEATURE_PER_TASK_QUEUES: true,
    features: {},
    config: {
        get ADMIN_GROUPS() {
            return ['admin'];
        },
        get WATCH_PERMISSION_GROUPS() {
            return ['admin', 'stream-monitors'];
        },
        get NAVIGATION_AVAILABLE_GROUPS() {
            return mockNavGroups;
        },
    },
}));

vi.mock('$lib/server/middleware/auth.js', () => ({
    requireAdmin: (fn: (e: unknown) => unknown) => fn,
}));
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    withAdminHeavyRateLimit: (fn: (e: unknown) => unknown) => fn,
    checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, resetAt: 0 }),
    ADMIN_HEAVY_RATE_LIMIT: { limit: 30, windowSeconds: 60 },
}));
vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (fn: (e: unknown) => unknown) => fn,
}));
vi.mock('$lib/server/middleware/validate.js', () => ({
    // mount() imports the C1 body guard from this module too; the test's
    // requests all carry a Content-Type, so it never fires.
    untypedBodyOnCookieAuth: () => false,
    // Pass-through: parse body with the real schema and attach as event.validated.body
    withValidation: (fn: (e: unknown) => unknown) => async (event: Record<string, unknown>) => {
        const body = await (event.request as { json: () => Promise<unknown> }).json();
        return fn({ ...event, validated: { body, query: {}, params: {} } });
    },
}));
vi.mock('$lib/server/utils/audit-log.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/utils/audit-log.js')>();
    return { ...actual, auditLog: vi.fn() };
});

function post(body: unknown, username = 'denis') {
    const url = new URL('http://localhost/api/admin/navigation/groups');
    const request = new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    return import('./+server.js').then(({ POST }) =>
        (POST as (e: unknown) => Promise<Response>)({
            request,
            url,
            params: {},
            locals: {
                user: {
                    userId: '1',
                    username,
                    userGroups: ['admin'],
                    ownerIsAdmin: true,
                    maxAgeRating: null,
                },
                principal: {
                    userId: '1',
                    username,
                    userGroups: ['admin'],
                    scopes: ['admin'],
                    isAdmin: true,
                },
            },
        }),
    );
}

describe('normalizeGroupName', () => {
    it('NFC-normalizes and trims', () => {
        expect(normalizeGroupName('  Librarians  ')).toBe('Librarians');
    });
});

describe('computeAddGroup', () => {
    const base = {
        currentNavGroups: ['Librarians'],
        mergedGroups: ['admin', 'Librarians'],
        envLocked: false,
    };

    it('adds a brand-new group preserving casing', () => {
        const d = computeAddGroup({ ...base, raw: 'StreamMonitors' });
        expect(d).toEqual({
            kind: 'add',
            group: 'StreamMonitors',
            updated: ['Librarians', 'StreamMonitors'],
        });
    });

    it('no-ops on a case-insensitive duplicate of a nav group', () => {
        expect(computeAddGroup({ ...base, raw: 'librarians' })).toEqual({ kind: 'noop' });
    });

    it('persists a name that only exists in admin/watch groups (durability)', () => {
        const d = computeAddGroup({ ...base, raw: 'Admin' });
        // 'admin' is in mergedGroups but NOT in currentNavGroups -> still append for durability
        expect(d).toEqual({ kind: 'add', group: 'Admin', updated: ['Librarians', 'Admin'] });
    });

    it('rejects an empty-after-trim name', () => {
        expect(computeAddGroup({ ...base, raw: '   ' })).toEqual({ kind: 'invalid' });
    });

    it('rejects a name with a zero-width char', () => {
        expect(computeAddGroup({ ...base, raw: 'Kred​itoren' })).toEqual({ kind: 'invalid' });
    });

    it('rejects when env-locked', () => {
        expect(computeAddGroup({ ...base, raw: 'NewGroup', envLocked: true })).toEqual({
            kind: 'env_locked',
        });
    });

    // Invisible/dangerous chars are built via String.fromCodePoint so the test
    // source stays pure ASCII (literal invisibles are unreadable and fragile).
    it('rejects NBSP (a non-ASCII space)', () => {
        const raw = 'Kred' + String.fromCodePoint(0x00a0) + 'itoren';
        expect(computeAddGroup({ ...base, raw })).toEqual({ kind: 'invalid' });
    });

    it('rejects a soft hyphen (format char)', () => {
        const raw = 'Kred' + String.fromCodePoint(0x00ad) + 'itoren';
        expect(computeAddGroup({ ...base, raw })).toEqual({ kind: 'invalid' });
    });

    it('rejects a word joiner (U+2060)', () => {
        const raw = 'Kred' + String.fromCodePoint(0x2060) + 'itoren';
        expect(computeAddGroup({ ...base, raw })).toEqual({ kind: 'invalid' });
    });

    it('rejects an invisible Hangul filler letter (U+3164)', () => {
        expect(computeAddGroup({ ...base, raw: String.fromCodePoint(0x3164) })).toEqual({
            kind: 'invalid',
        });
    });

    it('allows a plain ASCII space inside a name', () => {
        const d = computeAddGroup({ ...base, raw: 'Stream Monitors' });
        expect(d).toEqual({
            kind: 'add',
            group: 'Stream Monitors',
            updated: ['Librarians', 'Stream Monitors'],
        });
    });

    it('returns limit when the group cap is reached', () => {
        const many = Array.from({ length: 250 }, (_, i) => 'g' + i);
        expect(
            computeAddGroup({
                raw: 'OneMore',
                currentNavGroups: many,
                mergedGroups: many,
                envLocked: false,
            }),
        ).toEqual({ kind: 'limit' });
    });

    it('still no-ops a duplicate even at the cap', () => {
        const many = Array.from({ length: 250 }, (_, i) => 'g' + i);
        expect(
            computeAddGroup({
                raw: 'G5',
                currentNavGroups: many,
                mergedGroups: many,
                envLocked: false,
            }),
        ).toEqual({ kind: 'noop' });
    });
});

describe('POST /api/admin/navigation/groups', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockEnvLocked = false;
        mockNavGroups = ['Librarians'];
    });

    it('adds a new group and returns the merged list', async () => {
        const res = await post({ group: 'StreamMonitors' });
        const json = await res.json();
        expect(mockSaveConfig).toHaveBeenCalledWith({
            NAVIGATION_AVAILABLE_GROUPS: ['Librarians', 'StreamMonitors'],
        });
        expect(mockReloadConfig).toHaveBeenCalled();
        expect(json.availableGroups).toContain('StreamMonitors');
        expect(json.persisted).toBe(true);
    });

    it('no-ops on a case-insensitive duplicate without saving', async () => {
        const res = await post({ group: 'librarians' });
        const json = await res.json();
        expect(mockSaveConfig).not.toHaveBeenCalled();
        expect(json.availableGroups).toContain('Librarians');
    });

    it('returns 409 when env-locked', async () => {
        mockEnvLocked = true;
        const res = await post({ group: 'NewGroup' });
        expect(res.status).toBe(409);
        expect(mockSaveConfig).not.toHaveBeenCalled();
    });

    it('returns 500 and does not reload when saveConfig throws', async () => {
        mockSaveConfig.mockRejectedValueOnce(new Error('disk full'));
        const res = await post({ group: 'AnotherGroup' });
        expect(res.status).toBe(500);
        expect(mockReloadConfig).not.toHaveBeenCalled();
    });

    it('returns 422 with the invalid code for a zero-width-char name', async () => {
        const res = await post({ group: 'Kred​itoren' });
        expect(res.status).toBe(422);
        const json = await res.json();
        expect(json.code).toBe('validation_failed');
    });

    it('returns 422 with the limit code when at the group cap', async () => {
        mockNavGroups = Array.from({ length: 250 }, (_, i) => 'g' + i);
        const res = await post({ group: 'OneMore' });
        expect(res.status).toBe(422);
        const json = await res.json();
        expect(json.code).toBe('validation_failed');
        expect(mockSaveConfig).not.toHaveBeenCalled();
    });
});
